"""API Gateway (HTTP API, payload format 2.0) Lambda handler.

Routes:
  GET  /api/health
  GET  /api/schema
  GET  /api/city-state?scenarioAt=...
  POST /api/incidents
  POST /api/incidents/{eventId}/evaluate
  POST /api/chat
  POST /api/agent

The first two plus /api/agent are declared in backend/terraform/api_gateway.tf
today; /api/city-state, /api/incidents*, and /api/chat are new (this file)
and still need the matching Terraform routes added before a real deploy --
see backend/PIPELINES.md.

Product-level view (see backend/PIPELINES.md "三條產品層級觸發路徑" for the
full picture): there are exactly three ways real SOP judgment gets
triggered, and all three go through the LLM-first decide()/answer_chat()
layer, never a hardcoded rule shortcut --
  1. Periodic poll: GET /api/city-state -> decide_congestion() per segment.
  2. Incident injection: POST /api/incidents/{eventId}/evaluate ->
     decide_accident() / decide_signal_failure().
  3. Chat: POST /api/chat -> answer_chat(), which sees the full SOP text.
Each has a deterministic rules/-based fallback for when no LLM is configured
or reachable -- that's a resilience safety net, not an alternate primary path.

/api/agent request body shape: {"action": "...", ...action-specific fields}.

Two families of action/route:
  - "decide" action, and the /api/incidents/{eventId}/evaluate route: the
    real judgment calls (agent/facts.py + agent/decision_agent.py) -- LLM
    reads raw facts + full SOP text and decides what applies. Falls back to
    rules/*.py's deterministic functions when no LLM is configured.
  - "summarize" / "answer_what_if" / "generate_multilingual": pure narration
    of an already-known result (agent/narrator.py) -- no judgment happens
    here.

Every action falls back to canned/deterministic behavior when no LLM is
configured yet (see agent/llm_client.py) -- it never 500s for lack of
credentials. DB-backed routes require DATABASE_URL to be set (see db.py);
they return 503 if the DB can't be reached, since there's no meaningful
demo-mode fallback for "the city state" itself.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import db
from agent.chat import answer_chat
from agent.decision_agent import Decision
from agent.facts import (
    decide_accident,
    decide_congestion,
    decide_dome_dispersal,
    decide_mrt_diversion,
    decide_multilingual,
    decide_signal_failure,
)
from agent.narrator import StructuredEvent, answer_what_if, generate_multilingual, summarize
from rules.network_loader import build_segments_from_raw
from rules.types import CrowdSnapshot, LiveIncident

_JSON_HEADERS = {"content-type": "application/json; charset=utf-8"}
_EVALUATE_PATH = re.compile(r".*/api/incidents/([^/]+)/evaluate$")


def _response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": _JSON_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }


def _handle_health() -> dict[str, Any]:
    return _response(200, {"message": "AI City Commander API is running"})


def _handle_schema() -> dict[str, Any]:
    return _response(
        200,
        {
            "routes": [
                "GET /api/city-state?scenarioAt=<ISO8601>",
                "POST /api/incidents",
                "POST /api/incidents/{eventId}/evaluate",
                "POST /api/chat",
                "POST /api/agent",
            ],
            "actions": {
                "decide": {
                    "scopes": [
                        "congestion", "accident", "mrt_diversion",
                        "dome_dispersal", "signal_failure", "multilingual",
                    ],
                    "note": "LLM makes the actual judgment; see agent/facts.py.",
                },
                "summarize": {},
                "answer_what_if": {},
                "generate_multilingual": {},
            },
            "note": "See backend/PIPELINES.md for full request/response shapes.",
        },
    )


def _parse_scenario_at(raw: str) -> datetime:
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# GET /api/city-state
# ---------------------------------------------------------------------------


def _congestion_decision(
    conn, segment_id: str, segment_name: str, saturation_score: float, scenario_at: datetime
) -> Decision:
    """Cache-then-compute for the periodic per-segment SOP §1 judgment.

    This is a real decide_congestion() (LLM-first, rules/ fallback) call,
    not the deterministic get_tier() shortcut -- every GET /api/city-state
    poll must go through the judgment layer, not just narrate/tag a
    hardcoded threshold. Cached per (segment_id, scenario_at) so repeat
    polls for a scenario time already judged don't re-invoke the LLM.
    """
    cached = db.fetch_cached_congestion_decision(conn, segment_id, scenario_at)
    if cached is not None:
        return cached

    decision = decide_congestion(segment_id, segment_name, saturation_score)
    db.save_congestion_decision(conn, segment_id=segment_id, scenario_at=scenario_at, decision=decision)
    return decision


_MULTILINGUAL_CACHE_KEY = "_ALL_STATIONS_"


def _mrt_decision(conn, snapshot: CrowdSnapshot, scenario_at: datetime) -> Decision:
    """Cache-then-compute for SOP §3 (BS_MRT_BL17 only)."""
    cached = db.fetch_cached_crowd_decision(conn, snapshot.station_id, scenario_at, "mrt_diversion")
    if cached is not None:
        return cached
    decision = decide_mrt_diversion(snapshot)
    db.save_crowd_decision(
        conn, station_id=snapshot.station_id, scenario_at=scenario_at,
        decision_kind="mrt_diversion", decision=decision,
    )
    return decision


def _dome_decision(conn, station_id: str, scenario_at: datetime) -> Decision:
    """Cache-then-compute for SOP §4 (BS_TPE_DOME only)."""
    cached = db.fetch_cached_crowd_decision(conn, station_id, scenario_at, "dome_dispersal")
    if cached is not None:
        return cached
    history = db.fetch_crowd_history(conn, station_id, scenario_at)
    current = next((c for c in db.fetch_latest_crowd_snapshots(conn, scenario_at) if c.station_id == station_id), None)
    if current is None:
        return Decision(triggered=False, sop_section_id=None, source="fallback")
    decision = decide_dome_dispersal(history, current)
    db.save_crowd_decision(
        conn, station_id=station_id, scenario_at=scenario_at,
        decision_kind="dome_dispersal", decision=decision,
    )
    return decision


def _multilingual_decision(conn, stations: list[CrowdSnapshot], scenario_at: datetime) -> Decision:
    """Cache-then-compute for SOP §6 across all currently-visible stations in
    one LLM call -- cached under a synthetic station_id since it's a batch
    judgment, not per-station (see schema.sql's crowd_decisions)."""
    cached = db.fetch_cached_crowd_decision(conn, _MULTILINGUAL_CACHE_KEY, scenario_at, "multilingual")
    if cached is not None:
        return cached
    decision = decide_multilingual(stations)
    db.save_crowd_decision(
        conn, station_id=_MULTILINGUAL_CACHE_KEY, scenario_at=scenario_at,
        decision_kind="multilingual", decision=decision,
    )
    return decision


def _handle_city_state(query: dict[str, str]) -> dict[str, Any]:
    if "scenarioAt" not in query:
        return _response(400, {"error": "missing query param: 'scenarioAt'"})
    try:
        scenario_at = _parse_scenario_at(query["scenarioAt"])
    except ValueError:
        return _response(400, {"error": f"invalid scenarioAt: {query['scenarioAt']!r}"})

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return _response(503, {"error": str(exc)})

    try:
        traffic = db.fetch_latest_traffic_snapshots(conn, scenario_at)
        crowd = db.fetch_latest_crowd_snapshots(conn, scenario_at)
        incidents = db.fetch_active_incidents(conn, scenario_at)

        traffic_out = []
        for t in traffic:
            decision = _congestion_decision(conn, t.segment_id, t.road_name, t.saturation_score, scenario_at)
            traffic_out.append(
                {
                    "segmentId": t.segment_id,
                    "roadName": t.road_name,
                    "observedAt": t.timestamp,
                    "avgSpeedKph": t.avg_speed,
                    "vehicleCount": t.vehicle_count,
                    "saturationScore": t.saturation_score,
                    "laneStatus": t.lane_status,
                    # This is the real SOP §1 judgment (decide_congestion --
                    # LLM-first, rules/ fallback), not a hardcoded threshold
                    # comparison -- see the periodic-poll cache in
                    # congestion_decisions, checked/filled per segment below.
                    "tier": decision.result.get("tier", "Normal"),
                    "cityResponseTriggered": decision.triggered,
                    "cityResponseActions": decision.result.get("actions", []),
                    "reasoning": decision.reasoning,
                    "publicMessage": decision.public_message,
                    "source": decision.source,
                }
            )
        # §6 多語通報：對「目前看得到的所有站點」批次判斷一次，不逐站分開呼叫
        # LLM，跟 §3/§4 是針對特定站點的判斷不同（見 agent/facts.py::decide_multilingual）。
        multilingual_decision = _multilingual_decision(conn, crowd, scenario_at)
        multilingual_triggered_ids = set(multilingual_decision.result.get("stations", []))

        crowd_out = []
        for c in crowd:
            entry = {
                "stationId": c.station_id,
                "locationName": c.location_name,
                "observedAt": c.timestamp,
                "userCount": c.user_count,
                "stayTimeAvgMinutes": c.stay_time_avg,
                "growthRate": c.growth_rate,
                "roamingUserPct": c.roaming_pct,
                # SOP §6 是唯一對「每個站點」都適用的判斷，所以每筆都附上。
                "multilingualTriggered": c.station_id in multilingual_triggered_ids,
            }
            # SOP §3：只有 BS_MRT_BL17 適用（見 rules/mrt_diversion.py 對照的 SOP 條文）。
            if c.station_id == "BS_MRT_BL17":
                mrt = _mrt_decision(conn, c, scenario_at)
                entry["mrtDiversionTriggered"] = mrt.triggered
                entry["mrtDiversionReasoning"] = mrt.reasoning
                entry["mrtDiversionPublicMessage"] = mrt.public_message
                entry["mrtDiversionSource"] = mrt.source
            # SOP §4：只有 BS_TPE_DOME 適用。
            if c.station_id == "BS_TPE_DOME":
                dome = _dome_decision(conn, c.station_id, scenario_at)
                entry["domeDispersalTriggered"] = dome.triggered
                entry["domeDispersalReasoning"] = dome.reasoning
                entry["domeDispersalPublicMessage"] = dome.public_message
                entry["domeDispersalSource"] = dome.source
            crowd_out.append(entry)

        # Module 1 covers live incidents too -- every incident visible at
        # this scenario time gets judged here automatically (both applicable
        # SOP checks, cached), not left as raw fields waiting for a separate
        # manual evaluate call per incident (see backend/PIPELINES.md).
        active_incidents_out = []
        for i in incidents:
            decisions = _evaluate_incident(conn, i.event_id, scenario_at) or []
            active_incidents_out.append(
                {
                    "eventId": i.event_id,
                    "type": i.type,
                    "location": i.location,
                    "affectedSegment": i.affected_segment,
                    "status": i.status,
                    "severity": i.severity,
                    "description": i.description,
                    "occurredAt": i.timestamp,
                    "sopChecks": [
                        {"alertKind": kind, **_decision_to_dict(decision)}
                        for kind, decision in decisions
                    ],
                }
            )
        conn.commit()
    finally:
        conn.close()

    return _response(
        200,
        {
            "meta": {"scenarioAt": query["scenarioAt"], "generatedAt": _now_iso(), "dataMode": "demo"},
            "traffic": traffic_out,
            "crowd": crowd_out,
            # SOP §6 判斷是對所有站點批次做一次，理由文字放在頂層，
            # 各站點只帶 multilingualTriggered 布林值（見上面 crowd_out 迴圈）。
            "multilingualJudgment": {
                "triggered": multilingual_decision.triggered,
                "reasoning": multilingual_decision.reasoning,
                "publicMessage": multilingual_decision.public_message,
                "source": multilingual_decision.source,
            },
            "activeIncidents": active_incidents_out,
        },
    )


# ---------------------------------------------------------------------------
# POST /api/incidents
# ---------------------------------------------------------------------------


def _handle_create_incident(event: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "invalid JSON body"})

    context = payload.get("context", {})
    incident_payload = payload.get("incident")
    if "scenarioAt" not in context:
        return _response(400, {"error": "missing field: 'context.scenarioAt'"})
    if incident_payload is None:
        return _response(400, {"error": "missing field: 'incident'"})

    try:
        scenario_at = _parse_scenario_at(context["scenarioAt"])
        occurred_at = (
            _parse_scenario_at(incident_payload["occurredAt"])
            if incident_payload.get("occurredAt")
            else scenario_at
        )
        road_impacts = incident_payload.get("roadImpacts", [])
        station_impacts = incident_payload.get("stationImpacts", [])
        road_segment_ids = [r["segmentId"] for r in road_impacts]
        station_ids = [s["stationId"] for s in station_impacts]
        affected_segment = (road_segment_ids[0] if road_segment_ids else
                             station_ids[0] if station_ids else "")

        event_id = incident_payload.get("eventId") or f"INC_{scenario_at:%Y%m%d}_{uuid.uuid4().hex[:6]}"
        incident = LiveIncident(
            event_id=event_id,
            type=incident_payload["type"],
            location=incident_payload["location"],
            affected_segment=affected_segment,
            status=incident_payload["status"],
            severity=incident_payload["severity"],
            description=incident_payload["description"],
            timestamp=occurred_at.isoformat(),
        )
    except KeyError as exc:
        return _response(400, {"error": f"missing field: {exc}"})

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return _response(503, {"error": str(exc)})

    try:
        db.insert_incident(
            conn, incident, occurred_at=occurred_at,
            road_segment_ids=road_segment_ids, station_ids=station_ids,
        )
        conn.commit()
    finally:
        conn.close()

    return _response(
        200,
        {
            "meta": {"scenarioAt": context["scenarioAt"], "generatedAt": _now_iso(), "dataMode": "demo"},
            "incident": {
                "eventId": incident.event_id,
                "type": incident.type,
                "location": incident.location,
                "status": incident.status,
                "severity": incident.severity,
                "description": incident.description,
                "occurredAt": occurred_at.isoformat(),
                "roadImpacts": road_impacts,
                "stationImpacts": station_impacts,
                "createdAt": _now_iso(),
            },
        },
    )


# ---------------------------------------------------------------------------
# POST /api/incidents/{eventId}/evaluate
# ---------------------------------------------------------------------------


def _decision_to_dict(decision: Decision) -> dict[str, Any]:
    return {
        "triggered": decision.triggered,
        "sopSectionId": decision.sop_section_id,
        "result": decision.result,
        "reasoning": decision.reasoning,
        # Citizen-facing text -- see data/api.md line 638 and
        # response_alerts.public_message. Never fall back to `reasoning`
        # here; empty string means "no public-safe text for this decision".
        "publicMessage": decision.public_message,
        "source": decision.source,
    }


def _cached_or_computed(
    conn, *, event_id: str, scenario_at: datetime, alert_kind: str, title: str, compute
) -> Decision:
    cached = db.fetch_cached_decision(conn, event_id, scenario_at, alert_kind)
    if cached is not None:
        return cached
    decision = compute()
    db.save_decision(
        conn, event_id=event_id, scenario_at=scenario_at,
        alert_kind=alert_kind, title=title, decision=decision,
    )
    return decision


def _evaluate_incident(
    conn, event_id: str, scenario_at: datetime
) -> Optional[list[tuple[str, Decision]]]:
    """Checks an incident against every SOP article whose facts shape it
    matches (currently accident/§2 and signal_failure/§5 -- both work off a
    LiveIncident directly), independently and unconditionally -- no
    incident.type pre-filter choosing just one. An incident can trigger
    zero, one, or both; each check has its own cache entry so re-requesting
    the same (event_id, scenario_at) doesn't re-invoke the LLM for either.
    Returns None only if event_id doesn't exist.
    """
    incident = db.fetch_incident(conn, event_id)
    if incident is None:
        return None

    segments = db.fetch_road_segments(conn)
    traffic = db.fetch_latest_traffic_snapshots(conn, scenario_at)
    saturation = {t.segment_id: t.saturation_score for t in traffic}

    accident_decision = _cached_or_computed(
        conn, event_id=event_id, scenario_at=scenario_at, alert_kind="accident",
        title=incident.location,
        compute=lambda: decide_accident(incident, segments, saturation),
    )
    signal_decision = _cached_or_computed(
        conn, event_id=event_id, scenario_at=scenario_at, alert_kind="signal_failure",
        title=incident.location,
        compute=lambda: decide_signal_failure(incident),
    )
    conn.commit()
    return [("accident", accident_decision), ("signal_failure", signal_decision)]


def _handle_evaluate_incident(event: dict[str, Any], event_id: str) -> dict[str, Any]:
    try:
        payload = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "invalid JSON body"})

    context = payload.get("context", {})
    if "scenarioAt" not in context:
        return _response(400, {"error": "missing field: 'context.scenarioAt'"})
    try:
        scenario_at = _parse_scenario_at(context["scenarioAt"])
    except ValueError:
        return _response(400, {"error": f"invalid scenarioAt: {context['scenarioAt']!r}"})

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return _response(503, {"error": str(exc)})

    try:
        decisions = _evaluate_incident(conn, event_id, scenario_at)
    finally:
        conn.close()

    if decisions is None:
        return _response(404, {"error": f"unknown eventId: {event_id!r}"})

    return _response(
        200,
        {
            "meta": {"scenarioAt": context["scenarioAt"], "generatedAt": _now_iso(), "dataMode": "demo"},
            # One entry per SOP article actually checked against this
            # incident (currently accident/§2 + signal_failure/§5, run
            # independently -- see _evaluate_incident's docstring). Includes
            # untriggered checks too so the caller can see what was
            # considered, not just what fired; filter on "triggered" client-side.
            "aiDecisions": [
                {"eventId": event_id, "alertKind": kind, **_decision_to_dict(decision)}
                for kind, decision in decisions
            ],
        },
    )


# ---------------------------------------------------------------------------
# POST /api/chat
# ---------------------------------------------------------------------------


def _handle_chat(event: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "invalid JSON body"})

    context = payload.get("context", {})
    if "scenarioAt" not in context:
        return _response(400, {"error": "missing field: 'context.scenarioAt'"})
    if "message" not in payload:
        return _response(400, {"error": "missing field: 'message'"})
    try:
        scenario_at = _parse_scenario_at(context["scenarioAt"])
    except ValueError:
        return _response(400, {"error": f"invalid scenarioAt: {context['scenarioAt']!r}"})
    audience = context.get("audience", "government")

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return _response(503, {"error": str(exc)})

    try:
        traffic = db.fetch_latest_traffic_snapshots(conn, scenario_at)
        crowd = db.fetch_latest_crowd_snapshots(conn, scenario_at)
        incidents = db.fetch_active_incidents(conn, scenario_at)
    finally:
        conn.close()

    # The chat's situational awareness: current numbers, not pre-classified
    # tiers/triggers -- same "facts only, LLM decides" contract as decide().
    facts = {
        "traffic": [
            {"segmentId": t.segment_id, "roadName": t.road_name, "saturationScore": t.saturation_score}
            for t in traffic
        ],
        "crowd": [
            {
                "stationId": c.station_id,
                "locationName": c.location_name,
                "userCount": c.user_count,
                "growthRate": c.growth_rate,
                "roamingPct": c.roaming_pct,
            }
            for c in crowd
        ],
        "activeIncidents": [
            {
                "eventId": i.event_id,
                "type": i.type,
                "location": i.location,
                "status": i.status,
                "severity": i.severity,
            }
            for i in incidents
        ],
    }

    answer = answer_chat(payload["message"], facts, audience=audience)
    return _response(
        200,
        {
            "meta": {"scenarioAt": context["scenarioAt"], "generatedAt": _now_iso(), "dataMode": "demo"},
            "answer": {
                "text": answer.text,
                "sopRefs": answer.sop_refs,
                "source": answer.source,
            },
        },
    )


# ---------------------------------------------------------------------------
# POST /api/agent
# ---------------------------------------------------------------------------


def _parse_incident(d: dict[str, Any]) -> LiveIncident:
    return LiveIncident(
        event_id=d["eventId"],
        type=d["type"],
        location=d["location"],
        affected_segment=d["affectedSegment"],
        status=d["status"],
        severity=d["severity"],
        description=d["description"],
        timestamp=d["timestamp"],
        affected_road=d.get("affectedRoad"),
    )


def _parse_crowd_snapshot(d: dict[str, Any]) -> CrowdSnapshot:
    return CrowdSnapshot(
        timestamp=d["timestamp"],
        station_id=d["stationId"],
        location_name=d["locationName"],
        user_count=d["userCount"],
        stay_time_avg=d["stayTimeAvg"],
        growth_rate=d["growthRate"],
        roaming_pct=d["roamingPct"],
    )


def _handle_decide(payload: dict[str, Any]) -> dict[str, Any]:
    scope = payload.get("scope")
    try:
        if scope == "congestion":
            decision = decide_congestion(
                payload["segmentId"], payload["segmentName"], payload["saturationScore"]
            )
        elif scope == "accident":
            segments = build_segments_from_raw(payload["segments"])
            incident = _parse_incident(payload["incident"])
            saturation = payload.get("saturation", {})
            decision = decide_accident(incident, segments, saturation)
        elif scope == "mrt_diversion":
            snapshot = _parse_crowd_snapshot(payload["snapshot"])
            decision = decide_mrt_diversion(snapshot)
        elif scope == "dome_dispersal":
            history = [_parse_crowd_snapshot(d) for d in payload.get("history", [])]
            current = _parse_crowd_snapshot(payload["current"])
            decision = decide_dome_dispersal(history, current)
        elif scope == "signal_failure":
            incident = _parse_incident(payload["incident"])
            decision = decide_signal_failure(incident)
        elif scope == "multilingual":
            stations = [_parse_crowd_snapshot(d) for d in payload.get("stations", [])]
            decision = decide_multilingual(stations)
        else:
            return _response(400, {"error": f"unknown scope: {scope!r}"})
    except KeyError as exc:
        return _response(400, {"error": f"missing field: {exc}"})

    return _response(200, _decision_to_dict(decision))


def _handle_agent(event: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "invalid JSON body"})

    action = payload.get("action")

    if action == "decide":
        return _handle_decide(payload)

    if action == "summarize":
        try:
            structured = StructuredEvent(
                kind=payload["kind"],
                title=payload.get("title", ""),
                data=payload.get("data", {}),
                sop_ref=payload.get("sopRef"),
            )
        except KeyError as exc:
            return _response(400, {"error": f"missing field: {exc}"})
        return _response(200, {"text": summarize(structured)})

    if action == "answer_what_if":
        if "question" not in payload:
            return _response(400, {"error": "missing field: 'question'"})
        text = answer_what_if(
            payload["question"],
            payload.get("ruleResult"),
            payload.get("sopExcerpt", ""),
        )
        return _response(200, {"text": text})

    if action == "generate_multilingual":
        if "messageType" not in payload:
            return _response(400, {"error": "missing field: 'messageType'"})
        messages = generate_multilingual(payload["messageType"], payload.get("values", {}))
        return _response(200, {"messages": messages})

    return _response(400, {"error": f"unknown action: {action!r}"})


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "")
    query = event.get("queryStringParameters") or {}

    if path.endswith("/api/health"):
        return _handle_health()
    if path.endswith("/api/schema"):
        return _handle_schema()
    if path.endswith("/api/city-state") and method == "GET":
        return _handle_city_state(query)
    if path.endswith("/api/incidents") and method == "POST":
        return _handle_create_incident(event)

    match = _EVALUATE_PATH.match(path)
    if match and method == "POST":
        return _handle_evaluate_incident(event, match.group(1))

    if path.endswith("/api/chat") and method == "POST":
        return _handle_chat(event)

    if path.endswith("/api/agent") and method == "POST":
        return _handle_agent(event)

    return _response(404, {"error": "not found"})

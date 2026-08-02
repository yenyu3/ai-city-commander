"""S3-backed cache for LLM/rules decision results (2026-08-01: moved off
Postgres -- see backend/README.md's "決策快取（S3）" section for why).

RDS (db.py) stays the operational source of truth for road/station/
snapshot/incident data; this module is purely a
(scenario_at, location_id[, kind]) -> Decision cache, one JSON object per
key, matching data/api.md's internal-results bucket layout:

    decisions/{scenario_at}/{segment_id}.json                  congestion (SOP §1)
    decisions/{scenario_at}/{station_id}__{decision_kind}.json mrt/dome diversion (SOP §3/§4)
    decisions/{scenario_at}/all.json                            multilingual (SOP §6, batched across all stations)
    decisions/{scenario_at}/_triggers.json                      router agent's city-wide sweep (2026-08-01)
    decisions/{scenario_at}/_summary/{locationId|_global}.json  focused integration for one caller's view --
                                                                 TWO independent structured NarrativeSummary objects
                                                                 (citizen/government), not free text and not one
                                                                 summary with an audience switch (2026-08-01)
    incidents/{date}/{eventId}/decisions/{scenario_at}/{kind}.json
                                                                 incident SOP checks (SOP §2/§5, 2026-08-01:
                                                                 keyed under the incident's own folder, NOT
                                                                 decisions/ -- which API invoked the worker
                                                                 decides decision vs incident)

`:` in scenario_at's ISO8601 string is replaced with `-` (S3 keys allow
colons, but some HTTP clients/tools handle them poorly) -- mirrors the
`2026-05-20T22-10-00+08-00` example in data/api.md.

Auth is the same IAM Role as agent/llm_client.py::BedrockLLMClient -- no
credential is read or stored here; boto3 resolves the caller's identity via
the standard AWS credential chain (Lambda execution role in prod, local
`aws configure`/`AWS_PROFILE` for dev).
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

import s3_common
from agent.decision_agent import Decision, ReasoningStep
from agent.router_agent import InterAgencyAction, Narrative, NarrativeSummary, RoutingVariant, SignalTiming, Trigger

# SOP §6's multilingual judgment runs once per poll across every visible
# station, not per station -- "all" names that it's the one cross-cutting
# decision for this scenario_at, not a specific location.
_MULTILINGUAL_LOCATION_ID = "all"


def _key(scenario_at: datetime, location_id: str) -> str:
    at = scenario_at.isoformat().replace(":", "-")
    return f"decisions/{at}/{location_id}.json"


def _crowd_location_id(station_id: str, decision_kind: str) -> str:
    if decision_kind == "multilingual":
        return _MULTILINGUAL_LOCATION_ID
    return f"{station_id}__{decision_kind}"


def _decision_from_json(payload: dict) -> Decision:
    return Decision(
        triggered=payload["triggered"],
        sop_section_id=payload.get("sopSectionId"),
        result=payload.get("result", {}) or {},
        reasoning=payload.get("reasoning", ""),
        source=payload.get("source", "cache"),
        public_message=payload.get("publicMessage", ""),
        # 2026-08-01: was missing entirely -- reasoning_steps got dropped on
        # every cache round-trip (a cache HIT would silently strip a
        # decision's reasoningSteps even though the original LLM call
        # produced them fine; caught live comparing a fresh decide_congestion()
        # call, which had 5 steps, against the cached response, which had 0).
        reasoning_steps=[
            ReasoningStep(
                order=s["order"], status=s["status"], title=s["title"],
                detail=s["detail"], sop_ref=s.get("sopRef"),
            )
            for s in (payload.get("reasoningSteps") or [])
        ],
    )


def _decision_to_json(decision: Decision, *, title: Optional[str] = None) -> dict:
    payload = {
        "triggered": decision.triggered,
        "sopSectionId": decision.sop_section_id,
        "result": decision.result,
        "reasoning": decision.reasoning,
        "publicMessage": decision.public_message,
        "source": decision.source,
        "reasoningSteps": [
            {
                "order": s.order, "status": s.status, "title": s.title,
                "detail": s.detail, **({"sopRef": s.sop_ref} if s.sop_ref else {}),
            }
            for s in decision.reasoning_steps
        ],
    }
    if title is not None:
        payload["title"] = title
    return payload


def _fetch_from(key: str) -> Optional[Decision]:
    from botocore.exceptions import ClientError

    try:
        obj = s3_common.client().get_object(Bucket=s3_common.internal_bucket(), Key=key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        raise
    payload = json.loads(obj["Body"].read())
    return _decision_from_json(payload)


def _fetch(location_id: str, scenario_at: datetime) -> Optional[Decision]:
    return _fetch_from(_key(scenario_at, location_id))


def _save_to(key: str, decision: Decision, *, title: Optional[str] = None) -> None:
    body = json.dumps(_decision_to_json(decision, title=title), ensure_ascii=False).encode("utf-8")
    s3_common.client().put_object(
        Bucket=s3_common.internal_bucket(),
        Key=key,
        Body=body,
        ContentType="application/json; charset=utf-8",
    )


def _save(location_id: str, scenario_at: datetime, decision: Decision, *, title: Optional[str] = None) -> None:
    _save_to(_key(scenario_at, location_id), decision, title=title)


# --- SOP §1: per-segment congestion tier (GET /api/city-state) -------------


def fetch_cached_congestion_decision(segment_id: str, scenario_at: datetime) -> Optional[Decision]:
    return _fetch(segment_id, scenario_at)


def save_congestion_decision(*, segment_id: str, scenario_at: datetime, decision: Decision) -> None:
    _save(segment_id, scenario_at, decision)


# --- SOP §3/§4/§6: per-station crowd judgments (GET /api/city-state) -------


def fetch_cached_crowd_decision(
    station_id: str, scenario_at: datetime, decision_kind: str
) -> Optional[Decision]:
    return _fetch(_crowd_location_id(station_id, decision_kind), scenario_at)


def save_crowd_decision(
    *, station_id: str, scenario_at: datetime, decision_kind: str, decision: Decision
) -> None:
    _save(_crowd_location_id(station_id, decision_kind), scenario_at, decision)


# --- SOP §2/§3/§5: per-incident judgments (POST /api/incidents -> worker) --
# Keyed under the incident's own folder, matching the incidents/{date}/{eventId}
# and emergency-reports/{date}/{eventId}/ layout -- incident decisions never
# live under decisions/ (which API invoked the worker decides which keyspace
# gets written: decision-generator-worker/handler.py branches on `mode`).


def _incident_decision_key(event_id: str, date: str, scenario_at: datetime, alert_kind: str) -> str:
    at = scenario_at.isoformat().replace(":", "-")
    return f"incidents/{date}/{event_id}/decisions/{at}/{alert_kind}.json"


def fetch_cached_incident_decision(
    event_id: str, date: str, scenario_at: datetime, alert_kind: str
) -> Optional[Decision]:
    return _fetch_from(_incident_decision_key(event_id, date, scenario_at, alert_kind))


def save_incident_decision(
    *, event_id: str, date: str, scenario_at: datetime, alert_kind: str, title: str, decision: Decision
) -> None:
    _save_to(_incident_decision_key(event_id, date, scenario_at, alert_kind), decision, title=title)


# --- Router agent (2026-08-01): city-wide sweep + per-focus narrative ------


def _triggers_key(scenario_at: datetime) -> str:
    at = scenario_at.isoformat().replace(":", "-")
    return f"decisions/{at}/_triggers.json"


def fetch_cached_triggers(scenario_at: datetime) -> Optional[list[Trigger]]:
    from botocore.exceptions import ClientError

    try:
        obj = s3_common.client().get_object(Bucket=s3_common.internal_bucket(), Key=_triggers_key(scenario_at))
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        raise
    payload = json.loads(obj["Body"].read())
    return [
        Trigger(
            sop_section_id=item["sopSectionId"], location_id=item["locationId"], event_id=item.get("eventId")
        )
        for item in payload["triggers"]
    ]


def save_triggers(*, scenario_at: datetime, triggers: list[Trigger]) -> None:
    body = json.dumps(
        {
            "triggers": [
                {"sopSectionId": t.sop_section_id, "locationId": t.location_id, "eventId": t.event_id}
                for t in triggers
            ]
        },
        ensure_ascii=False,
    ).encode("utf-8")
    s3_common.client().put_object(
        Bucket=s3_common.internal_bucket(),
        Key=_triggers_key(scenario_at),
        Body=body,
        ContentType="application/json; charset=utf-8",
    )


def _narrative_key(scenario_at: datetime, location_key: str) -> str:
    at = scenario_at.isoformat().replace(":", "-")
    return f"decisions/{at}/_summary/{location_key}.json"


def _narrative_summary_to_json(summary: NarrativeSummary, *, government: bool) -> dict:
    payload = {
        "focusLocationId": summary.focus_location_id,
        "headline": summary.headline,
        "text": summary.text,
        "recommendedActions": summary.recommended_actions,
        "estimatedRecovery": summary.estimated_recovery,
        "prioritizedDecisionIds": summary.prioritized_decision_ids,
    }
    if government:
        payload["sopRefs"] = summary.sop_refs
        payload["signalCoordination"] = [
            {"intersectionName": t.intersection_name, "adjustPct": t.adjust_pct, "goal": t.goal}
            for t in summary.signal_coordination
        ]
        payload["crossSystemCoordination"] = [
            {"agency": a.agency, "text": a.text, "icon": a.icon} for a in summary.cross_system_coordination
        ]
        payload["publicationEligibleLocationIds"] = summary.publication_eligible_location_ids
    else:
        payload["routingVariants"] = [
            {"segmentId": v.segment_id, "text": v.text, "weight": v.weight} for v in summary.routing_variants
        ]
    return payload


def _narrative_summary_from_json(payload: dict, *, government: bool) -> NarrativeSummary:
    summary = NarrativeSummary(
        focus_location_id=payload.get("focusLocationId"),
        headline=payload["headline"],
        text=payload["text"],
        recommended_actions=payload.get("recommendedActions") or [],
        estimated_recovery=payload.get("estimatedRecovery") or [],
        prioritized_decision_ids=payload.get("prioritizedDecisionIds") or [],
    )
    if government:
        summary.sop_refs = payload.get("sopRefs") or []
        summary.signal_coordination = [
            SignalTiming(intersection_name=t["intersectionName"], adjust_pct=t["adjustPct"], goal=t["goal"])
            for t in (payload.get("signalCoordination") or [])
        ]
        summary.cross_system_coordination = [
            InterAgencyAction(agency=a["agency"], text=a["text"], icon=a["icon"])
            for a in (payload.get("crossSystemCoordination") or [])
        ]
        summary.publication_eligible_location_ids = payload.get("publicationEligibleLocationIds") or []
    else:
        summary.routing_variants = [
            RoutingVariant(segment_id=v["segmentId"], text=v["text"], weight=v["weight"])
            for v in (payload.get("routingVariants") or [])
        ]
    return summary


def fetch_cached_narrative(scenario_at: datetime, location_key: str) -> Optional[Narrative]:
    from botocore.exceptions import ClientError

    try:
        obj = s3_common.client().get_object(
            Bucket=s3_common.internal_bucket(), Key=_narrative_key(scenario_at, location_key)
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        raise
    payload = json.loads(obj["Body"].read())
    return Narrative(
        citizen=_narrative_summary_from_json(payload["citizen"], government=False),
        government=_narrative_summary_from_json(payload["government"], government=True),
    )


def save_narrative(*, scenario_at: datetime, location_key: str, narrative: Narrative) -> None:
    body = json.dumps(
        {
            "citizen": _narrative_summary_to_json(narrative.citizen, government=False),
            "government": _narrative_summary_to_json(narrative.government, government=True),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    s3_common.client().put_object(
        Bucket=s3_common.internal_bucket(),
        Key=_narrative_key(scenario_at, location_key),
        Body=body,
        ContentType="application/json; charset=utf-8",
    )

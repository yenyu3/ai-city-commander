"""GET /api/decisions?scenarioAt={scenarioAt}&locationId={locationId} --
see data/api.md §4. Cache-aside: check S3 (via s3_cache/decision_routing)
for this exact (scenarioAt, locationId); 200 with the cached decision on a
hit, or fire decision-generator-worker asynchronously and return 202 on a
miss (never computes synchronously here -- that's the worker's job, see
../decision-generator-worker/handler.py).
"""
from __future__ import annotations

from typing import Any, Optional

import api_common
import db
import worker_invoke
from agent.decision_agent import Decision
from decision_routing import LocationRoute, fetch_cached, resolve_location


def _location_name(conn, location_id: str, scenario_at) -> str:
    if location_id.startswith("RD_"):
        traffic = db.fetch_latest_traffic_snapshots(conn, scenario_at)
        match = next((t for t in traffic if t.segment_id == location_id), None)
        return match.road_name if match else location_id
    crowd = db.fetch_latest_crowd_snapshots(conn, scenario_at)
    match = next((c for c in crowd if c.station_id == location_id), None)
    return match.location_name if match else location_id


def _build_ai_decision(
    route: LocationRoute, decision: Decision, location_id: str, location_name: str
) -> dict[str, Any]:
    """Maps our internal Decision onto data/api.md §4's aiDecision shape.
    Fields the doc's own examples leave empty (reasoningSteps,
    signalCoordination, crossSystemCoordination, publicationEligibility)
    stay empty here too -- not a shortcut, that's what the spec itself shows.
    """
    kind = route.kind
    if route.kind == "incident":
        kind = "accident" if decision.sop_section_id == "2" else "signal_failure"

    title_by_kind = {
        "congestion": f"{location_name} 觸發 {decision.result.get('tier', 'Normal')} 級壅塞",
        "accident": location_name,
        "signal_failure": f"{location_name} 號誌故障",
        "mrt_diversion": f"{location_name} 觸發捷運分流",
        "dome_dispersal": f"{location_name} 觸發散場啟動",
        "multilingual": f"{location_name} 觸發多語通報",
    }

    reroute: Optional[dict[str, Any]] = None
    if kind == "accident" and decision.triggered:
        reroute = {
            "mainRoute": decision.result.get("main_route"),
            "secondaryRoutes": decision.result.get("secondary_routes", []),
            "excluded": decision.result.get("excluded", []),
        }

    return {
        "decisionId": f"DEC_{location_id}",
        "status": "recommended" if decision.triggered else "not_triggered",
        "locationContext": {"locationId": location_id, "locationName": location_name},
        "summary": {
            "kind": kind,
            "title": title_by_kind.get(kind, location_name),
            "aiText": decision.reasoning,
            "sopRefs": [f"SOP §{decision.sop_section_id}"] if decision.sop_section_id else [],
        },
        "recommendedActions": decision.result.get("actions", []) if kind == "congestion" else [],
        "metrics": {},
        "estimatedRecovery": decision.result.get("ete") if kind == "accident" else None,
        "reroute": reroute,
        "reasoningSteps": [],
        "signalCoordination": {},
        "crossSystemCoordination": {},
        "publicationEligibility": {},
    }


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    query = event.get("queryStringParameters") or {}
    if "scenarioAt" not in query or "locationId" not in query:
        return api_common.response(400, {"error": "missing query param: 'scenarioAt' and/or 'locationId'"})
    try:
        scenario_at = api_common.parse_scenario_at(query["scenarioAt"])
    except ValueError:
        return api_common.response(400, {"error": f"invalid scenarioAt: {query['scenarioAt']!r}"})
    location_id = query["locationId"]

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return api_common.response(503, {"error": str(exc)})
    try:
        route = resolve_location(conn, location_id, scenario_at)
        if route.kind == "unknown":
            return api_common.response(400, {"error": f"unrecognized locationId: {location_id!r}"})
        cached = fetch_cached(route, location_id, scenario_at)
        location_name = _location_name(conn, location_id, scenario_at)
    finally:
        conn.close()

    retrieved_at = api_common.now_iso()

    if cached is not None:
        return api_common.response(
            200,
            {
                "meta": {
                    "scenarioAt": query["scenarioAt"],
                    "retrievedAt": retrieved_at,
                    "dataMode": "demo",
                    "source": "decision_snapshot",
                    "cacheStatus": "hit",
                },
                "aiDecision": _build_ai_decision(route, cached, location_id, location_name),
            },
        )

    worker_invoke.invoke_async({"scenarioAt": query["scenarioAt"], "locationId": location_id})
    return api_common.response(
        202,
        {
            "meta": {"scenarioAt": query["scenarioAt"], "retrievedAt": retrieved_at, "dataMode": "demo", "cacheStatus": "miss"},
            "processing": {
                "jobId": f"DJOB_{location_id}_{query['scenarioAt']}",
                "status": "queued",
                "processor": "decision-generator",
                "queuedAt": retrieved_at,
                "retryAfterSeconds": 10,
            },
            "message": "此時間與地點的 AI 決策尚未產生，系統已開始處理，請稍後再查詢。",
        },
    )

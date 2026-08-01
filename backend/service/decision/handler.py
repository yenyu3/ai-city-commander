"""GET /api/decisions?scenarioAt={scenarioAt}&locationId={locationId}? --
see data/api.md §4. ``locationId`` is optional: every decision is computed
for the city-wide view and it only selects a focused narrative.

The frontend may query any time, while AI results are stored at 15-minute
slots. This handler rounds down to that slot, reads only its S3 cache, and
starts decision-generator-worker asynchronously on a miss. It never queries
RDS or invokes an LLM itself.
"""
from __future__ import annotations

from typing import Any, Optional

import api_common
import worker_invoke
from agent.decision_agent import Decision
from decision_routing import Trigger, fetch_cached_view


def _decision_item(trig: Trigger, decision: Decision) -> dict[str, Any]:
    reroute: Optional[dict[str, Any]] = None
    if trig.kind == "accident":
        reroute = {
            "mainRoute": decision.result.get("main_route"),
            "secondaryRoutes": decision.result.get("secondary_routes", []),
            "excluded": decision.result.get("excluded", []),
        }

    return {
        "decisionId": f"DEC_{trig.location_id}",
        "sopSectionId": trig.sop_section_id,
        "kind": trig.kind,
        "locationId": trig.location_id,
        "eventId": trig.event_id,
        "summary": {
            "aiText": decision.reasoning,
            "sopRefs": [f"SOP §{trig.sop_section_id}"],
        },
        "recommendedActions": decision.result.get("actions", []) if trig.kind == "congestion" else [],
        "estimatedRecovery": decision.result.get("ete") if trig.kind == "accident" else None,
        "reroute": reroute,
        "publicMessage": decision.public_message,
    }


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    query = event.get("queryStringParameters") or {}
    if "scenarioAt" not in query:
        return api_common.response(400, {"error": "missing query param: 'scenarioAt'"})
    try:
        requested_scenario_at = api_common.parse_scenario_at(query["scenarioAt"])
    except ValueError:
        return api_common.response(400, {"error": f"invalid scenarioAt: {query['scenarioAt']!r}"})

    scenario_at = api_common.decision_snapshot_at(requested_scenario_at)
    location_id = query.get("locationId") or None
    focus = {"locationId": location_id} if location_id else None
    retrieved_at = api_common.now_iso()
    cached = fetch_cached_view(scenario_at, location_id)
    age_minutes = (requested_scenario_at - scenario_at).total_seconds() / 60

    if cached is not None:
        pairs, narrative = cached
        return api_common.response(
            200,
            {
                "meta": {
                    "scenarioAt": query["scenarioAt"],
                    "resolvedScenarioAt": scenario_at.isoformat(),
                    "ageMinutes": age_minutes,
                    "retrievedAt": retrieved_at,
                    "dataMode": "demo",
                    "source": "decision_snapshot",
                    "cacheStatus": "hit" if age_minutes == 0 else "slot_hit",
                },
                "focus": focus,
                "situationSummary": narrative,
                "decisions": [_decision_item(trig, decision) for trig, decision in pairs],
            },
        )

    worker_invoke.invoke_async({"scenarioAt": scenario_at.isoformat(), "locationId": location_id})
    return api_common.response(
        202,
        {
            "meta": {
                "scenarioAt": query["scenarioAt"],
                "resolvedScenarioAt": scenario_at.isoformat(),
                "ageMinutes": age_minutes,
                "retrievedAt": retrieved_at,
                "dataMode": "demo",
                "cacheStatus": "miss",
            },
            "focus": focus,
            "processing": {
                "jobId": f"DJOB_{scenario_at.isoformat()}",
                "status": "queued",
                "processor": "decision-generator",
                "queuedAt": retrieved_at,
                "retryAfterSeconds": 10,
            },
            "message": "此 15 分鐘時槽的 AI 決策尚未產生，系統已開始處理，請稍後再查詢。",
        },
    )

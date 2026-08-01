"""GET /api/decisions?scenarioAt={scenarioAt}&locationId={locationId}? --
see data/api.md §4. 2026-08-01 redesign: `locationId` is now OPTIONAL and
the response shape changed from a single `aiDecision` to a `decisions[]`
array + a `situationSummary` narrative -- see decision_routing.py's module
docstring for why (the short version: the agent now sees the whole city at
once every time; `locationId` only steers which focused narrative comes
back, it no longer selects what gets computed). This is a real change to
`data/api.md`'s documented contract -- I'm not editing that doc myself, see
the diff description handed to the user separately.

Still a pure cache-aside read: `decision_routing.fetch_cached_view` never
touches RDS or an LLM. `200` on a hit; on a miss, fires
decision-generator-worker asynchronously (it does the real -- possibly RDS +
multiple LLM calls -- work, see decision-generator-worker/handler.py) and
returns `202`.
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
        scenario_at = api_common.parse_scenario_at(query["scenarioAt"])
    except ValueError:
        return api_common.response(400, {"error": f"invalid scenarioAt: {query['scenarioAt']!r}"})
    location_id = query.get("locationId") or None

    retrieved_at = api_common.now_iso()
    focus = {"locationId": location_id} if location_id else None
    cached = fetch_cached_view(scenario_at, location_id)

    if cached is not None:
        pairs, narrative = cached
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
                "focus": focus,
                "situationSummary": narrative,
                "decisions": [_decision_item(trig, decision) for trig, decision in pairs],
            },
        )

    worker_invoke.invoke_async({"scenarioAt": query["scenarioAt"], "locationId": location_id})
    return api_common.response(
        202,
        {
            "meta": {
                "scenarioAt": query["scenarioAt"], "retrievedAt": retrieved_at,
                "dataMode": "demo", "cacheStatus": "miss",
            },
            "focus": focus,
            "processing": {
                "jobId": f"DJOB_{query['scenarioAt']}",
                "status": "queued",
                "processor": "decision-generator",
                "queuedAt": retrieved_at,
                "retryAfterSeconds": 10,
            },
            "message": "此時間點的 AI 決策尚未產生，系統已開始處理，請稍後再查詢。",
        },
    )

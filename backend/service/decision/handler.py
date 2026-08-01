"""GET /api/decisions?scenarioAt={scenarioAt}&locationId={locationId}? --
see data/api.md §4. ``locationId`` is optional: every decision is computed
for the city-wide view and it only selects a focused summary.

The frontend may query any time, while AI results are stored at 15-minute
slots. This handler rounds down to that slot, reads only its S3 cache, and
starts decision-generator-worker asynchronously on a miss. It never queries
RDS or invokes an LLM itself.

2026-08-01, final response shape (after several wrong intermediate ones --
see agent/router_agent.py's module docstring for the full history): response
carries `government` and `citizen`, each a structured `NarrativeSummary`
object (headline/text/rollup fields -- NOT free text, NOT a single
audience-switched `situationSummary`), plus `decisions[]` -- the full
per-item detail array, unchanged in spirit from the original design but now
also carrying reasoningSteps/segmentMetrics/signalCoordination/
crossSystemCoordination/publicationEligibility per item (see
decision_routing.decision_detail()).
"""
from __future__ import annotations

from typing import Any

import api_common
import worker_invoke
from agent.router_agent import NarrativeSummary
from decision_routing import decision_detail, fetch_cached_view


def _decision_item(trig, decision) -> dict[str, Any]:
    detail = decision_detail(trig, decision)
    return {
        "decisionId": detail["decisionId"],
        "sopSectionId": detail["sopSectionId"],
        "kind": detail["kind"],
        "locationId": detail["locationId"],
        "eventId": detail["eventId"],
        "title": detail["title"],
        "summary": {"aiText": detail["aiText"], "sopRefs": detail["sopRefs"]},
        "reasoningSteps": detail["reasoningSteps"],
        "recommendedActions": detail["recommendedActions"],
        "estimatedRecovery": detail["estimatedRecovery"],
        "reroute": detail["reroute"],
        "segmentMetrics": detail["segmentMetrics"],
        "signalCoordination": detail["signalCoordination"],
        "crossSystemCoordination": detail["crossSystemCoordination"],
        "publicationEligibility": detail["publicationEligibility"],
        "publicMessage": detail["publicMessage"],
    }


def _summary_item(summary: NarrativeSummary, *, government: bool) -> dict[str, Any]:
    item: dict[str, Any] = {
        "focusLocationId": summary.focus_location_id,
        "headline": summary.headline,
        "text": summary.text,
        "recommendedActions": summary.recommended_actions,
        "estimatedRecovery": summary.estimated_recovery,
        "prioritizedDecisionIds": summary.prioritized_decision_ids,
    }
    if government:
        item["sopRefs"] = summary.sop_refs
        item["signalCoordination"] = [
            {"intersectionName": t.intersection_name, "adjustPct": t.adjust_pct, "goal": t.goal}
            for t in summary.signal_coordination
        ]
        item["crossSystemCoordination"] = [
            {"agency": a.agency, "text": a.text, "icon": a.icon} for a in summary.cross_system_coordination
        ]
        item["publicationEligibleLocationIds"] = summary.publication_eligible_location_ids
    return item


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
                "government": _summary_item(narrative.government, government=True),
                "citizen": _summary_item(narrative.citizen, government=False),
                "decisions": [_decision_item(trig, decision) for trig, decision in pairs],
            },
        )

    # mode="decision" tells the shared worker this came from the decision API
    # entry (it computes the general city sweep only) -- decision-vs-incident
    # is decided by which API invoked it, see decision_routing.py.
    worker_invoke.invoke_async({"mode": "decision", "scenarioAt": scenario_at.isoformat(), "locationId": location_id})
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

"""POST /api/chat/messages -- see data/api.md §5.

Fetches the same RDS situational facts the old monolithic handler.py did,
calls agent.chat.answer_chat() (full SOP text + facts, one real LLM call --
see that module's docstring for why this isn't the narrower narration-only
path), wraps the result into the doc's response envelope.

Known gap: the doc's government-mode example also has a populated
`ruleResult` (a single deterministic rule-check object: rule name, input,
threshold). `reasoningSteps` is now populated (2026-08-01, see agent/chat.py)
-- `ruleResult` is not, and stays empty: it's a different shape (one
structured rule-engine trace) than what `answer_chat()`'s free-form
LLM-judged What-if answers naturally produce, and fabricating one would mean
inventing a rule name/threshold the LLM didn't actually check against.

`sopRefs` is force-emptied for public audience here regardless of what the
LLM returned -- same defense-in-depth reasoning as decide()'s public_message
split: never trust the model alone to keep internal references out of the
public-facing answer, enforce it in code too.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

import api_common
import db
from agent.chat import answer_chat


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    try:
        payload = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return api_common.response(400, {"error": "invalid JSON body"})

    context = payload.get("context", {})
    if "scenarioAt" not in context:
        return api_common.response(400, {"error": "missing field: 'context.scenarioAt'"})
    if "message" not in payload:
        return api_common.response(400, {"error": "missing field: 'message'"})
    try:
        scenario_at = api_common.parse_scenario_at(context["scenarioAt"])
    except ValueError:
        return api_common.response(400, {"error": f"invalid scenarioAt: {context['scenarioAt']!r}"})
    audience = context.get("audience", "government")

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return api_common.response(503, {"error": str(exc)})
    try:
        traffic = db.fetch_latest_traffic_snapshots(conn, scenario_at)
        crowd = db.fetch_latest_crowd_snapshots(conn, scenario_at)
        incidents = db.fetch_active_incidents(conn, scenario_at)
    finally:
        conn.close()

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
            {"eventId": i.event_id, "type": i.type, "location": i.location, "status": i.status, "severity": i.severity}
            for i in incidents
        ],
    }

    answer = answer_chat(payload["message"], facts, audience=audience)
    created_at = api_common.now_iso()
    return api_common.response(
        200,
        {
            "meta": {"scenarioAt": context["scenarioAt"], "generatedAt": created_at, "dataMode": "demo"},
            "answer": {
                "messageId": f"MSG_{uuid.uuid4().hex[:8]}",
                "text": answer.text,
                "createdAt": created_at,
                "sopRefs": answer.sop_refs if audience == "government" else [],
                "reasoningSteps": [
                    {
                        "order": step.order,
                        "status": step.status,
                        "title": step.title,
                        "detail": step.detail,
                        **({"sopRef": step.sop_ref} if step.sop_ref else {}),
                    }
                    for step in answer.reasoning_steps
                ],
            },
        },
    )

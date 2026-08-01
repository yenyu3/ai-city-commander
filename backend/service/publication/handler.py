"""POST /api/publication -- see data/api.md §6.

Writes a public notice object + updates that date's manifest in the public
bucket (CloudFront's sole read origin for citizen-facing content -- see
storage.tf), and returns the doc's `201` envelope with a simulated
`"published"` status for every requested channel. The doc explicitly allows
a simulated result for the competition build ("比賽版本可模擬 queued 或
published 狀態") -- no real SNS/CMS/SMS fan-out happens here.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

import api_common
import s3_common

def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    try:
        payload = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return api_common.response(400, {"error": "invalid JSON body"})

    context = payload.get("context", {})
    if "scenarioAt" not in context:
        return api_common.response(400, {"error": "missing field: 'context.scenarioAt'"})
    if "alertId" not in payload:
        return api_common.response(400, {"error": "missing field: 'alertId'"})

    scenario_at = context["scenarioAt"]
    date = scenario_at.split("T")[0]
    alert_id = payload["alertId"]
    languages = payload.get("languages", [])
    channels = payload.get("channels", [])
    messages = payload.get("messages", {})

    publication_id = f"PUB_{uuid.uuid4().hex[:8]}"
    notice_id = f"{publication_id}_v1"
    notice = {
        "noticeId": notice_id,
        "alertId": alert_id,
        "publishedAt": scenario_at,
        "languages": languages,
        "messages": messages,
    }
    s3_common.publish_public_notice(
        date=date,
        notice_id=notice_id,
        alert_id=alert_id,
        notice=notice,
    )

    return api_common.response(
        201,
        {
            "meta": {"scenarioAt": scenario_at, "generatedAt": api_common.now_iso(), "dataMode": "demo"},
            "publication": {
                "publicationId": publication_id,
                "alertId": alert_id,
                "status": "published",
                "publishedAt": scenario_at,
                "languages": languages,
                "channelStatuses": [{"channel": channel, "status": "published"} for channel in channels],
            },
        },
    )

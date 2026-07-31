"""POST /api/publications — simulated multilingual publication."""

from datetime import datetime, timezone
import json


DEFAULT_SCENARIO_AT = "2026-05-20T21:00:00+08:00"


def handler(event, _context):
    try:
        request = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        request = {}
    scenario_at = request.get("context", {}).get("scenarioAt") or DEFAULT_SCENARIO_AT
    publication = {
        "publicationId": "PUB_001", "alertId": request.get("alertId", "ALT_001"), "status": "published", "publishedAt": scenario_at,
        "languages": request.get("languages", ["zh", "en", "ja", "ko"]),
        "channelStatuses": [{"channel": channel, "status": "published"} for channel in request.get("channels", ["cms", "web"])],
    }
    payload = {"meta": {"scenarioAt": scenario_at, "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"), "dataMode": "demo"}, "publication": publication}
    return {"statusCode": 200, "headers": {"content-type": "application/json; charset=utf-8"}, "body": json.dumps(payload, ensure_ascii=False)}

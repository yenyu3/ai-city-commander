"""POST /api/incidents — simulated event injection endpoint."""

from datetime import datetime, timezone
import json


def handler(event, _context):
    try:
        request = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        request = {}
    scenario_at = request.get("context", {}).get("scenarioAt")
    incident = request.get("incident", {})
    payload = {
        "meta": {
            "scenarioAt": scenario_at,
            "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "dataMode": "demo",
        },
        "incident": incident,
        "injection": {"status": "accepted", "injectedAt": scenario_at},
    }
    return {
        "statusCode": 202,
        "headers": {"content-type": "application/json; charset=utf-8"},
        "body": json.dumps(payload, ensure_ascii=False),
    }

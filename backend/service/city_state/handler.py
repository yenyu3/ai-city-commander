"""GET /api/city-state — fixed demo state for frontend integration."""

from datetime import datetime, timezone
import json


DEFAULT_SCENARIO_AT = "2026-05-20T21:00:00+08:00"


def handler(event, _context):
    scenario_at = ((event.get("queryStringParameters") or {}).get("scenarioAt") or DEFAULT_SCENARIO_AT)
    generated_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    payload = {
        "meta": {"scenarioAt": scenario_at, "generatedAt": generated_at, "dataMode": "demo"},
        "traffic": [
            {"segmentId": "RD_TPE_001", "observedAt": scenario_at, "avgSpeedKph": 18.2, "vehicleCount": 1420, "saturationScore": 0.96, "laneStatus": "Critical", "tier": "A"},
            {"segmentId": "RD_TPE_002", "observedAt": scenario_at, "avgSpeedKph": 27.5, "vehicleCount": 1090, "saturationScore": 0.88, "laneStatus": "Congested", "tier": "B"},
        ],
        "crowd": [
            {"stationId": "BS_MRT_BL17", "observedAt": scenario_at, "userCount": 26700, "stayTimeAvgMinutes": 12.4, "growthRate": 0.34, "roamingUserPct": 0.31},
            {"stationId": "BS_TPE_DOME", "observedAt": scenario_at, "userCount": 18300, "stayTimeAvgMinutes": 9.8, "growthRate": -0.12, "roamingUserPct": 0.18},
        ],
        "activeIncidents": [{"eventId": "INC_001", "type": "Accident", "location": "忠孝東路與光復南路口", "status": "Closed", "severity": "High", "description": "雙向車道封閉處理中", "occurredAt": "2026-05-20T20:55:00+08:00", "roadImpacts": [{"segmentId": "RD_TPE_001", "role": "primary"}], "stationImpacts": []}],
        "alerts": [{"alertId": "ALT_001", "eventId": "INC_001", "kind": "accident", "title": "忠孝東路封閉", "summary": "忠孝東路封閉，請改道仁愛路，預計延誤 52 分鐘", "eteMinutes": 52, "createdAt": scenario_at}],
    }
    return {"statusCode": 200, "headers": {"content-type": "application/json; charset=utf-8"}, "body": json.dumps(payload, ensure_ascii=False)}

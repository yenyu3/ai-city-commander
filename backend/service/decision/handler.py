"""POST /api/ai-decisions — placeholder for the S3-backed decision query."""

import json


def handler(event, _context):
    body = json.loads(event.get("body") or "{}")
    scenario_at = body.get("context", {}).get("scenarioAt")
    location_id = body.get("lookup", {}).get("locationId")
    return {
        "statusCode": 404,
        "headers": {"content-type": "application/json; charset=utf-8"},
        "body": json.dumps({
            "meta": {"scenarioAt": scenario_at, "dataMode": "demo", "source": "s3_snapshot"},
            "error": {
                "code": "DECISION_NOT_READY",
                "message": "No cached decision exists for this time and location.",
                "locationId": location_id,
                "retryAfterSeconds": 3,
            },
        }),
    }

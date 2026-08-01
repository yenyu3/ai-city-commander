"""Government report query placeholder backed by internal S3."""

import json


def handler(event, _context):
    body = json.loads(event.get("body") or "{}")
    event_id = body.get("eventId")
    return {
        "statusCode": 202,
        "headers": {"content-type": "application/json; charset=utf-8"},
        "body": json.dumps({
            "eventId": event_id,
            "status": "processing",
            "message": "The internal emergency report is not ready yet.",
        }),
    }

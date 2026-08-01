"""Comparison endpoint: API Gateway -> Lambda -> public-results S3.

It deliberately preserves the public delivery contract's two reads:

* ``GET /api/experiments/public-notices?date=YYYY-MM-DD`` returns that
  day's manifest.
* Adding ``noticeId`` returns exactly that notice object.

The endpoint exists solely to compare this proxy path with a browser reading
the same manifest and notice directly through CloudFront.  It is not a
replacement for the production public delivery path.
"""
from __future__ import annotations

import json
import re
from typing import Any

import s3_common

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    query = event.get("queryStringParameters") or {}
    date = query.get("date")
    notice_id = query.get("noticeId")
    if not date or not _DATE.fullmatch(date):
        return _response(400, {"error": "query param 'date' must be YYYY-MM-DD"})

    try:
        s3 = s3_common.client()
        bucket = s3_common.public_bucket()
        manifest_key = s3_common.public_manifest_key(date)
        manifest = _read_json(s3, bucket, manifest_key)
        if not notice_id:
            return _response(200, manifest)

        entry = next((item for item in manifest.get("notices", []) if item.get("noticeId") == notice_id), None)
        if entry is None:
            return _response(404, {"error": {"code": "NOTICE_NOT_FOUND", "noticeId": notice_id}})
        return _response(200, _read_json(s3, bucket, entry["noticeKey"]))
    except Exception as exc:  # S3 intentionally does not reveal missing-key details to public callers
        return _response(404, {"error": {"code": "PUBLIC_RESULT_NOT_FOUND", "message": str(exc)}})


def _read_json(s3: Any, bucket: str, key: str) -> dict[str, Any]:
    return json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())


def _response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            # Keep the experimental proxy comparable to a fresh manifest
            # polling request; do not let API Gateway/browser cache mask it.
            "cache-control": "no-store",
        },
        "body": json.dumps(body, ensure_ascii=False),
    }

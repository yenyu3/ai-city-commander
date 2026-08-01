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


def _manifest_key(date: str) -> str:
    return f"public/{date}/manifest.json"


def _load_manifest(bucket: str, date: str) -> dict[str, Any]:
    try:
        obj = s3_common.client().get_object(Bucket=bucket, Key=_manifest_key(date))
        return json.loads(obj["Body"].read())
    except Exception:  # noqa: BLE001 - no manifest yet is the common case, not an error
        return {"date": date, "notices": []}


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
    bucket = s3_common.public_bucket()
    client = s3_common.client()

    notice = {
        "noticeId": notice_id,
        "alertId": alert_id,
        "publishedAt": scenario_at,
        "languages": languages,
        "messages": messages,
    }
    client.put_object(
        Bucket=bucket,
        Key=f"public/notices/{notice_id}.json",
        Body=json.dumps(notice, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
        CacheControl="public, max-age=31536000, immutable",
    )

    manifest = _load_manifest(bucket, date)
    manifest.setdefault("notices", []).append({"noticeId": notice_id, "alertId": alert_id})
    client.put_object(
        Bucket=bucket,
        Key=_manifest_key(date),
        Body=json.dumps(manifest, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
        CacheControl="no-store",
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

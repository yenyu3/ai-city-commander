"""S3 client + bucket-name lookup shared by every module that talks to the
two data/api.md buckets directly (s3_cache.py, and the incident/report/
publication Lambda handlers). Auth is the same IAM Role as
agent/llm_client.py::BedrockLLMClient -- no credential read or stored here.
"""
from __future__ import annotations

import json
import os
from typing import Any


def client():
    import boto3  # optional dependency, only needed on this path

    return boto3.client("s3")


def internal_bucket() -> str:
    bucket = os.environ.get("INTERNAL_RESULTS_BUCKET")
    if not bucket:
        raise RuntimeError(
            "INTERNAL_RESULTS_BUCKET is not set. For local dev, point it at a "
            "real S3 bucket you can read/write (a deployed internal-results "
            "bucket, or a scratch `aws s3 mb` bucket)."
        )
    return bucket


def public_bucket() -> str:
    bucket = os.environ.get("PUBLIC_RESULTS_BUCKET")
    if not bucket:
        raise RuntimeError("PUBLIC_RESULTS_BUCKET is not set.")
    return bucket


def public_manifest_key(date: str) -> str:
    return f"public/{date}/manifest.json"


def public_notice_key(date: str, notice_id: str) -> str:
    return f"public/{date}/notices/{notice_id}.json"


def publish_public_notice(*, date: str, notice_id: str, alert_id: str, notice: dict[str, Any]) -> tuple[str, str]:
    """Write an immutable notice, then upsert its entry in that day's manifest.

    CloudFront clients poll the small no-store manifest and fetch individual
    notice files only when a new noticeId appears. The public bucket remains
    private; CloudFront reads it through its origin access control.
    """
    bucket = public_bucket()
    s3 = client()
    notice_key = public_notice_key(date, notice_id)
    manifest_key = public_manifest_key(date)

    s3.put_object(
        Bucket=bucket,
        Key=notice_key,
        Body=json.dumps(notice, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
        CacheControl="public, max-age=31536000, immutable",
    )

    try:
        existing = s3.get_object(Bucket=bucket, Key=manifest_key)
        manifest = json.loads(existing["Body"].read())
    except Exception:  # noqa: BLE001 - a missing manifest is the normal first-publication case
        manifest = {"date": date, "notices": []}

    entry = {
        "noticeId": notice_id,
        "alertId": alert_id,
        "noticeKey": notice_key,
        "publishedAt": notice.get("publishedAt"),
    }
    notices = [item for item in manifest.get("notices", []) if item.get("noticeId") != notice_id]
    notices.append(entry)
    manifest["date"] = date
    manifest["notices"] = notices

    s3.put_object(
        Bucket=bucket,
        Key=manifest_key,
        Body=json.dumps(manifest, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
        CacheControl="no-store",
    )
    return manifest_key, notice_key

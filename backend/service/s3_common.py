"""S3 client + bucket-name lookup shared by every module that talks to the
two data/api.md buckets directly (s3_cache.py, and the incident/report/
publication Lambda handlers). Auth is the same IAM Role as
agent/llm_client.py::BedrockLLMClient -- no credential read or stored here.
"""
from __future__ import annotations

import os


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

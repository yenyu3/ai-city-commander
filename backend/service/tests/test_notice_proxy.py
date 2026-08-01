"""Unit tests for the Lambda-vs-CloudFront experiment proxy."""
from __future__ import annotations

import io
import json

from notice_proxy.handler import handler


class FakeS3:
    def __init__(self, objects: dict[str, dict]):
        self.objects = objects

    def get_object(self, *, Bucket: str, Key: str):  # noqa: N803 - AWS spelling
        return {"Body": io.BytesIO(json.dumps(self.objects[Key]).encode("utf-8"))}


def test_returns_manifest_then_selected_notice(monkeypatch):
    manifest_key = "public/2026-05-20/manifest.json"
    notice_key = "public/2026-05-20/notices/PUB_EXP_1_v1.json"
    s3 = FakeS3({
        manifest_key: {"date": "2026-05-20", "notices": [{"noticeId": "PUB_EXP_1_v1", "noticeKey": notice_key}]},
        notice_key: {"noticeId": "PUB_EXP_1_v1", "messages": {"zh": "測試公告"}},
    })
    monkeypatch.setattr("s3_common.client", lambda: s3)
    monkeypatch.setattr("s3_common.public_bucket", lambda: "public-bucket")

    manifest = handler({"queryStringParameters": {"date": "2026-05-20"}}, None)
    notice = handler({"queryStringParameters": {"date": "2026-05-20", "noticeId": "PUB_EXP_1_v1"}}, None)

    assert manifest["statusCode"] == 200
    assert json.loads(manifest["body"])["notices"][0]["noticeId"] == "PUB_EXP_1_v1"
    assert notice["statusCode"] == 200
    assert json.loads(notice["body"])["messages"]["zh"] == "測試公告"


def test_rejects_invalid_date():
    result = handler({"queryStringParameters": {"date": "not-a-date"}}, None)
    assert result["statusCode"] == 400

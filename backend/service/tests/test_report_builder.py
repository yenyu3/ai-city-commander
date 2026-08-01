"""Tests for report_builder.py, run against moto's in-memory S3 mock -- never
a real AWS call, no credentials needed. Mirrors tests/test_s3_cache.py's
setup.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

moto = pytest.importorskip("moto")

import report_builder  # noqa: E402
from agent.decision_agent import Decision  # noqa: E402
from rules.types import LiveIncident  # noqa: E402

_BUCKET = "test-internal-results"
_TAIPEI = timezone(timedelta(hours=8))


@pytest.fixture(autouse=True)
def mock_s3(monkeypatch):
    monkeypatch.setenv("INTERNAL_RESULTS_BUCKET", _BUCKET)
    with moto.mock_aws():
        import boto3

        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=_BUCKET)
        yield


def _incident(**overrides) -> LiveIncident:
    base = dict(
        event_id="TEST_EVT_REPORT",
        type="Road_Collapse_Accident",
        location="測試路段",
        affected_segment="RD_TPE_002",
        status="Closed",
        severity="Critical",
        description="測試事件描述",
        timestamp="2026-05-20T22:10:00+08:00",
    )
    base.update(overrides)
    return LiveIncident(**base)


def test_writes_report_keyed_by_date_and_event_id():
    import boto3

    incident = _incident()
    decision = Decision(
        triggered=True,
        sop_section_id="2",
        result={"main_route": "RD_TPE_001", "ete": 60},
        reasoning="測試理由，引用 SOP 第2條",
        source="llm",
        public_message="測試民眾訊息",
    )
    scenario_at = datetime(2026, 5, 20, 22, 15, tzinfo=_TAIPEI)

    report_builder.build_and_save_report(incident=incident, decision=decision, scenario_at=scenario_at)

    obj = boto3.client("s3", region_name="us-east-1").get_object(
        Bucket=_BUCKET, Key="emergency-reports/2026-05-20/TEST_EVT_REPORT/report-v1.json"
    )
    body = json.loads(obj["Body"].read())
    assert body["eventId"] == "TEST_EVT_REPORT"
    assert body["sopSectionId"] == "2"
    assert body["classification"]["main_route"] == "RD_TPE_001"
    assert body["publicMessage"] == "測試民眾訊息"
    assert body["incident"]["affectedSegment"] == "RD_TPE_002"


def test_date_extraction_handles_space_separated_timestamp():
    """db._incident_from_row falls back to occurred_at.isoformat() with a
    space separator when source_payload has no 'timestamp' key -- report_
    builder must key off the same date either way."""
    import boto3

    incident = _incident(event_id="TEST_EVT_SPACE", timestamp="2026-05-20 22:10:00")
    decision = Decision(
        triggered=True, sop_section_id="5", result={}, reasoning="r", source="fallback", public_message="p",
    )
    scenario_at = datetime(2026, 5, 20, 22, 30, tzinfo=_TAIPEI)

    report_builder.build_and_save_report(incident=incident, decision=decision, scenario_at=scenario_at)

    obj = boto3.client("s3", region_name="us-east-1").get_object(
        Bucket=_BUCKET, Key="emergency-reports/2026-05-20/TEST_EVT_SPACE/report-v1.json"
    )
    assert json.loads(obj["Body"].read())["eventId"] == "TEST_EVT_SPACE"

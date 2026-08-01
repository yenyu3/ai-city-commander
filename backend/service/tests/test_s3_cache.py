"""Tests for s3_cache.py, run against moto's in-memory S3 mock -- never a
real AWS call, no credentials needed. Mirrors what tests/test_db.py's old
TestDecisionCache class verified against Postgres before the cache moved to
S3 (2026-08-01).
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest

moto = pytest.importorskip("moto")

import s3_cache  # noqa: E402
from agent.decision_agent import Decision  # noqa: E402

_TAIPEI = timezone(timedelta(hours=8))
_BUCKET = "test-internal-results"


def taipei(y, m, d, h, mi) -> datetime:
    return datetime(y, m, d, h, mi, tzinfo=_TAIPEI)


@pytest.fixture(autouse=True)
def mock_s3(monkeypatch):
    monkeypatch.setenv("INTERNAL_RESULTS_BUCKET", _BUCKET)
    with moto.mock_aws():
        import boto3

        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=_BUCKET)
        yield


class TestKeyScheme:
    def test_scenario_at_colons_are_replaced_with_dashes(self):
        key = s3_cache._key(taipei(2026, 5, 20, 22, 10), "RD_TPE_002")
        assert ":" not in key
        assert key == "decisions/2026-05-20T22-10-00+08-00/RD_TPE_002.json"

    def test_multilingual_uses_the_shared_all_json_key(self):
        assert s3_cache._crowd_location_id("_ALL_STATIONS_", "multilingual") == "all"

    def test_other_crowd_kinds_are_scoped_per_station(self):
        assert s3_cache._crowd_location_id("BS_MRT_BL17", "mrt_diversion") == "BS_MRT_BL17__mrt_diversion"


class TestCongestionDecisionCache:
    def test_cache_miss_returns_none(self):
        assert s3_cache.fetch_cached_congestion_decision("RD_TPE_001", taipei(2026, 5, 20, 21, 0)) is None

    def test_save_then_fetch_round_trips(self):
        scenario_at = taipei(2026, 5, 20, 21, 0)
        decision = Decision(
            triggered=True, sop_section_id="1", result={"tier": "A", "actions": ["x"]},
            reasoning="飽和度 0.96 達 A 級門檻。", source="llm",
            public_message="附近路段車流壅塞，建議改道通行。",
        )
        s3_cache.save_congestion_decision(segment_id="RD_TPE_001", scenario_at=scenario_at, decision=decision)
        cached = s3_cache.fetch_cached_congestion_decision("RD_TPE_001", scenario_at)
        assert cached is not None
        assert cached.triggered is True
        assert cached.result["tier"] == "A"
        assert cached.public_message == decision.public_message

    def test_different_segment_is_a_cache_miss(self):
        scenario_at = taipei(2026, 5, 20, 21, 0)
        s3_cache.save_congestion_decision(
            segment_id="RD_TPE_001", scenario_at=scenario_at,
            decision=Decision(triggered=True, sop_section_id="1", source="llm"),
        )
        assert s3_cache.fetch_cached_congestion_decision("RD_TPE_002", scenario_at) is None


class TestCrowdDecisionCache:
    def test_multilingual_is_cached_under_the_shared_all_key_not_per_station(self):
        scenario_at = taipei(2026, 5, 20, 21, 0)
        s3_cache.save_crowd_decision(
            station_id="_ALL_STATIONS_", scenario_at=scenario_at, decision_kind="multilingual",
            decision=Decision(triggered=True, sop_section_id="6", result={"stations": ["BS_TPE_101"]}, source="llm"),
        )
        cached = s3_cache.fetch_cached_crowd_decision("_ALL_STATIONS_", scenario_at, "multilingual")
        assert cached is not None
        assert cached.result["stations"] == ["BS_TPE_101"]

    def test_mrt_and_dome_are_independent_cache_entries_for_the_same_station(self):
        scenario_at = taipei(2026, 5, 20, 21, 0)
        s3_cache.save_crowd_decision(
            station_id="BS_MRT_BL17", scenario_at=scenario_at, decision_kind="mrt_diversion",
            decision=Decision(triggered=True, sop_section_id="3", source="llm"),
        )
        assert s3_cache.fetch_cached_crowd_decision("BS_MRT_BL17", scenario_at, "dome_dispersal") is None
        assert s3_cache.fetch_cached_crowd_decision("BS_MRT_BL17", scenario_at, "mrt_diversion") is not None


class TestIncidentDecisionCache:
    def test_cache_miss_returns_none(self):
        assert s3_cache.fetch_cached_decision(
            "TPE_2026_ACC_001", taipei(2026, 5, 20, 22, 10), "accident"
        ) is None

    def test_save_then_fetch_round_trips(self):
        scenario_at = taipei(2026, 5, 20, 22, 10)
        decision = Decision(
            triggered=True, sop_section_id="2",
            result={"main_route": "RD_TPE_004", "secondary_routes": ["RD_TPE_005"]},
            reasoning="容量與上游條件皆符合，選定市民大道四段為主疏散路徑。",
            source="llm", public_message="光復南路南下封閉，請改道市民大道四段。",
        )
        s3_cache.save_decision(
            event_id="TPE_2026_ACC_001", scenario_at=scenario_at, alert_kind="accident",
            title="光復南路封閉", decision=decision,
        )
        cached = s3_cache.fetch_cached_decision("TPE_2026_ACC_001", scenario_at, "accident")
        assert cached is not None
        assert cached.result["main_route"] == "RD_TPE_004"
        assert cached.reasoning == decision.reasoning
        assert cached.public_message == decision.public_message

    def test_different_alert_kind_is_a_cache_miss(self):
        """Same incident + same scenario time, but a different SOP check --
        must not collide with the accident cache entry (this is exactly what
        lets one incident independently trigger multiple SOPs)."""
        scenario_at = taipei(2026, 5, 20, 22, 10)
        s3_cache.save_decision(
            event_id="TPE_2026_ACC_001", scenario_at=scenario_at, alert_kind="accident",
            title="x", decision=Decision(triggered=True, sop_section_id="2", source="llm"),
        )
        assert s3_cache.fetch_cached_decision("TPE_2026_ACC_001", scenario_at, "signal_failure") is None

    def test_different_scenario_at_is_a_cache_miss(self):
        scenario_at = taipei(2026, 5, 20, 22, 10)
        s3_cache.save_decision(
            event_id="TPE_2026_ACC_001", scenario_at=scenario_at, alert_kind="accident",
            title="x", decision=Decision(triggered=True, sop_section_id="2", source="llm"),
        )
        other_time = taipei(2026, 5, 20, 22, 20)
        assert s3_cache.fetch_cached_decision("TPE_2026_ACC_001", other_time, "accident") is None


class TestBucketNotConfigured:
    def test_raises_a_clear_error_when_env_var_missing(self, monkeypatch):
        monkeypatch.delenv("INTERNAL_RESULTS_BUCKET", raising=False)
        with pytest.raises(RuntimeError, match="INTERNAL_RESULTS_BUCKET"):
            s3_cache.fetch_cached_congestion_decision("RD_TPE_001", taipei(2026, 5, 20, 21, 0))

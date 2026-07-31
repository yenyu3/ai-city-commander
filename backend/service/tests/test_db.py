"""Tests for db.py, run against a real local Postgres (see
backend/README.md's "本機 DB 測試" section for how to stand one up) loaded
with the schema + demo dataset via
backend/terraform/scripts/load_demo_data.py.

Every test runs inside one uncommitted transaction and rolls back at
teardown -- inserts made here (test incidents, cached decisions) never
persist, so this suite never mutates the shared demo dataset. Skips
entirely (module-level) if DATABASE_URL isn't set or the DB isn't reachable,
so the rest of the suite (which needs no external services) still runs
everywhere else.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest

psycopg = pytest.importorskip("psycopg")

import db  # noqa: E402
from agent.decision_agent import Decision  # noqa: E402
from rules.types import LiveIncident  # noqa: E402

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:aicity@localhost:5432/aicity"
)

try:
    _probe = psycopg.connect(DATABASE_URL, connect_timeout=2)
    _probe.close()
    _DB_AVAILABLE = True
except Exception:  # noqa: BLE001 - any connection failure just means "skip"
    _DB_AVAILABLE = False

pytestmark = pytest.mark.skipif(
    not _DB_AVAILABLE, reason=f"no reachable Postgres at {DATABASE_URL}"
)


@pytest.fixture
def conn(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", DATABASE_URL)
    connection = db.connect()
    yield connection
    connection.rollback()
    connection.close()


_TAIPEI = timezone(timedelta(hours=8))


def taipei(y, m, d, h, mi) -> datetime:
    # tz-aware Taipei timestamp; timestamptz comparisons in Postgres are
    # timezone-correct regardless of which offset the Python value carries,
    # so there's no need to manually shift into UTC here.
    return datetime(y, m, d, h, mi, tzinfo=_TAIPEI)


class TestFetchTrafficSnapshots:
    def test_returns_only_segments_with_data_by_scenario_time(self, conn):
        # RD_TPE_011..015 only start at 22:00 Taipei in the seeded dataset;
        # at 21:00 they must not appear yet.
        rows = db.fetch_latest_traffic_snapshots(conn, taipei(2026, 5, 20, 21, 0))
        segment_ids = {r.segment_id for r in rows}
        assert "RD_TPE_001" in segment_ids
        assert "RD_TPE_011" not in segment_ids

    def test_picks_the_latest_row_at_or_before_scenario_time(self, conn):
        early = db.fetch_latest_traffic_snapshots(conn, taipei(2026, 5, 20, 17, 0))
        later = db.fetch_latest_traffic_snapshots(conn, taipei(2026, 5, 20, 23, 0))
        early_rd1 = next(r for r in early if r.segment_id == "RD_TPE_001")
        later_rd1 = next(r for r in later if r.segment_id == "RD_TPE_001")
        # the later query must not be strictly earlier than the earlier one
        assert later_rd1.timestamp >= early_rd1.timestamp

    def test_empty_before_any_data_exists(self, conn):
        rows = db.fetch_latest_traffic_snapshots(conn, taipei(2020, 1, 1, 0, 0))
        assert rows == []


class TestFetchCrowdSnapshots:
    def test_returns_snapshots_with_expected_fields(self, conn):
        rows = db.fetch_latest_crowd_snapshots(conn, taipei(2026, 5, 20, 23, 0))
        assert len(rows) > 0
        assert all(0 <= r.roaming_pct <= 1 for r in rows)

    def test_history_excludes_the_scenario_time_itself(self, conn):
        station_id = "BS_TPE_DOME"
        scenario_at = taipei(2026, 5, 20, 23, 0)
        history = db.fetch_crowd_history(conn, station_id, scenario_at)
        assert all(
            datetime.fromisoformat(h.timestamp) < scenario_at for h in history
        )


class TestFetchIncidents:
    def test_time_filtering_matches_known_seeded_incidents(self, conn):
        before_any = db.fetch_active_incidents(conn, taipei(2026, 5, 20, 21, 0))
        assert before_any == []

        after_first = db.fetch_active_incidents(conn, taipei(2026, 5, 20, 22, 15))
        assert {i.event_id for i in after_first} == {"TPE_2026_ACC_001"}

        after_all = db.fetch_active_incidents(conn, taipei(2026, 5, 20, 23, 0))
        assert {i.event_id for i in after_all} == {
            "TPE_2026_ACC_001", "TPE_2026_EVT_002", "TPE_2026_EVT_003",
        }

    def test_fetch_by_id_reconstructs_the_original_incident_shape(self, conn):
        incident = db.fetch_incident(conn, "TPE_2026_ACC_001")
        assert incident is not None
        assert incident.affected_segment == "RD_TPE_002"
        assert incident.status == "Closed"
        assert incident.severity == "Critical"

    def test_fetch_by_id_returns_none_for_unknown_id(self, conn):
        assert db.fetch_incident(conn, "NOT_A_REAL_ID") is None


class TestInsertIncident:
    def test_round_trips_through_insert_and_fetch(self, conn):
        incident = LiveIncident(
            event_id="TEST_EVT_ROUNDTRIP",
            type="Road_Collapse_Accident",
            location="測試路口",
            affected_segment="RD_TPE_003",
            status="Closed",
            severity="Critical",
            description="測試用事件，不應該真的留在資料庫",
            timestamp="2026-05-20 21:30",
        )
        db.insert_incident(
            conn, incident,
            occurred_at=taipei(2026, 5, 20, 21, 30),
            road_segment_ids=["RD_TPE_003"],
            station_ids=[],
        )
        fetched = db.fetch_incident(conn, "TEST_EVT_ROUNDTRIP")
        assert fetched is not None
        assert fetched.affected_segment == "RD_TPE_003"
        assert fetched.description == incident.description


class TestDecisionCache:
    def test_cache_miss_returns_none(self, conn):
        assert db.fetch_cached_decision(
            conn, "TPE_2026_ACC_001", taipei(2026, 5, 20, 22, 10), "accident"
        ) is None

    def test_save_then_fetch_round_trips(self, conn):
        scenario_at = taipei(2026, 5, 20, 22, 10)
        decision = Decision(
            triggered=True,
            sop_section_id="2",
            result={"main_route": "RD_TPE_004", "secondary_routes": ["RD_TPE_005"]},
            reasoning="容量與上游條件皆符合，選定市民大道四段為主疏散路徑。",
            source="llm",
        )
        db.save_decision(
            conn,
            event_id="TPE_2026_ACC_001",
            scenario_at=scenario_at,
            alert_kind="accident",
            title="光復南路封閉",
            decision=decision,
        )
        cached = db.fetch_cached_decision(conn, "TPE_2026_ACC_001", scenario_at, "accident")
        assert cached is not None
        assert cached.triggered is True
        assert cached.sop_section_id == "2"
        assert cached.result["main_route"] == "RD_TPE_004"
        assert cached.reasoning == decision.reasoning

    def test_different_alert_kind_is_a_cache_miss(self, conn):
        """Same incident + same scenario time, but a different SOP check --
        must not collide with the accident cache entry (this is exactly what
        lets one incident independently trigger multiple SOPs)."""
        scenario_at = taipei(2026, 5, 20, 22, 10)
        db.save_decision(
            conn, event_id="TPE_2026_ACC_001", scenario_at=scenario_at,
            alert_kind="accident", title="x",
            decision=Decision(triggered=True, sop_section_id="2", source="llm"),
        )
        assert db.fetch_cached_decision(
            conn, "TPE_2026_ACC_001", scenario_at, "signal_failure"
        ) is None

    def test_different_scenario_at_is_a_cache_miss(self, conn):
        scenario_at = taipei(2026, 5, 20, 22, 10)
        db.save_decision(
            conn, event_id="TPE_2026_ACC_001", scenario_at=scenario_at,
            alert_kind="accident", title="x",
            decision=Decision(triggered=True, sop_section_id="2", source="llm"),
        )
        other_time = taipei(2026, 5, 20, 22, 20)
        assert db.fetch_cached_decision(conn, "TPE_2026_ACC_001", other_time, "accident") is None

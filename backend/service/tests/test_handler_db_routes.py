"""Tests for the DB-backed handler routes (GET /api/city-state,
POST /api/incidents, POST /api/incidents/{eventId}/evaluate), run against a
real local Postgres -- see tests/test_db.py's module docstring for the setup
and the skip-if-unreachable/rollback-per-test conventions, which this file
reuses.
"""
from __future__ import annotations

import json
import os

import pytest

psycopg = pytest.importorskip("psycopg")

import db  # noqa: E402
import handler  # noqa: E402

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:aicity@localhost:5432/aicity"
)

try:
    _probe = psycopg.connect(DATABASE_URL, connect_timeout=2)
    _probe.close()
    _DB_AVAILABLE = True
except Exception:  # noqa: BLE001
    _DB_AVAILABLE = False

pytestmark = pytest.mark.skipif(
    not _DB_AVAILABLE, reason=f"no reachable Postgres at {DATABASE_URL}"
)


@pytest.fixture(autouse=True)
def clean_test_rows(monkeypatch):
    """These routes commit internally (city-state/evaluate need to persist
    across the two separate Lambda invocations a cache is supposed to span),
    so -- unlike test_db.py -- this suite can't rely on a rolled-back
    transaction for isolation. Instead it deletes only the rows it created,
    by a recognizable TEST_ prefix, before and after each test.
    """
    monkeypatch.setenv("DATABASE_URL", DATABASE_URL)
    _delete_test_rows()
    yield
    _delete_test_rows()


def _delete_test_rows():
    conn = psycopg.connect(DATABASE_URL)
    conn.execute("DELETE FROM incident_road_impacts WHERE event_id LIKE 'TEST_%'")
    conn.execute("DELETE FROM incident_station_impacts WHERE event_id LIKE 'TEST_%'")
    conn.execute("DELETE FROM incidents WHERE event_id LIKE 'TEST_%'")
    # response_alerts/congestion_decisions/crowd_decisions are pure cache
    # (see schema.sql) -- city-state now auto-evaluates every real seeded
    # incident too (not just TEST_-prefixed ones), so a TEST_-only filter on
    # response_alerts would leave cross-test pollution; safe to wipe all
    # three entirely between tests.
    conn.execute("DELETE FROM response_alerts")
    conn.execute("DELETE FROM congestion_decisions")
    conn.execute("DELETE FROM crowd_decisions")
    conn.commit()
    conn.close()


def _event(method: str, path: str, body: dict | None = None, query: dict | None = None) -> dict:
    return {
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "body": json.dumps(body) if body is not None else None,
        "queryStringParameters": query,
    }


class TestCityState:
    def test_missing_scenario_at_is_400(self):
        result = handler.handler(_event("GET", "/api/city-state"), None)
        assert result["statusCode"] == 400

    def test_returns_traffic_crowd_and_incidents_as_of_time(self):
        result = handler.handler(
            _event("GET", "/api/city-state", query={"scenarioAt": "2026-05-20T21:00:00+08:00"}),
            None,
        )
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert len(body["traffic"]) > 0
        assert all("tier" in t for t in body["traffic"])
        assert body["activeIncidents"] == []  # first incident is at 22:10

    def test_incidents_appear_once_their_time_has_passed(self):
        result = handler.handler(
            _event("GET", "/api/city-state", query={"scenarioAt": "2026-05-20T23:00:00+08:00"}),
            None,
        )
        body = json.loads(result["body"])
        assert len(body["activeIncidents"]) == 3

    def test_tier_comes_from_a_real_decide_call_when_llm_is_configured(self, monkeypatch):
        """Proves the periodic-poll path actually routes through
        decide_congestion() -- not the old hardcoded get_tier() shortcut --
        by injecting a fake client and checking the response is tagged
        source="llm", not "fallback"."""
        import json as _json

        from agent.llm_client import LLMClient

        class _FakeClient(LLMClient):
            def complete(self, system, prompt, *, max_tokens=1024):
                return _json.dumps(
                    {"triggered": True, "sop_section_id": "1",
                     "result": {"tier": "A", "actions": ["fake-llm-action"]},
                     "reasoning": "fake LLM reasoning"}
                )

        monkeypatch.setattr(
            "agent.decision_agent.get_configured_llm_client", lambda: _FakeClient()
        )
        result = handler.handler(
            _event("GET", "/api/city-state", query={"scenarioAt": "2026-05-20T21:00:00+08:00"}),
            None,
        )
        body = json.loads(result["body"])
        assert body["traffic"][0]["source"] == "llm"
        assert body["traffic"][0]["tier"] == "A"
        assert body["traffic"][0]["reasoning"] == "fake LLM reasoning"

    def test_repeated_poll_for_the_same_scenario_time_is_cached(self):
        query = {"scenarioAt": "2026-05-20T21:00:00+08:00"}
        handler.handler(_event("GET", "/api/city-state", query=query), None)

        conn = psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row)
        count_after_first = conn.execute(
            "SELECT count(*) AS n FROM congestion_decisions"
        ).fetchone()["n"]

        handler.handler(_event("GET", "/api/city-state", query=query), None)
        count_after_second = conn.execute(
            "SELECT count(*) AS n FROM congestion_decisions"
        ).fetchone()["n"]
        conn.close()

        assert count_after_first > 0
        assert count_after_second == count_after_first  # no new rows -- cache hit

    def test_crowd_judgments_are_present_and_match_known_boundary_cases(self):
        """Module 1 of the brief requires the periodic poll to cover 人流
        (crowd) data too, not just 車流 (traffic) -- see
        backend/PIPELINES.md's corrected scope. BS_MRT_BL17 in the seeded
        dataset has growth_rate=0.88 (> 0.30, SOP §3 triggers); BS_TPE_101
        has roaming_user_pct=0.40 (>= 30%, SOP §6 triggers); BS_TPE_DOME has
        growth_rate=-0.05 (not <= -0.20, SOP §4 does not trigger)."""
        result = handler.handler(
            _event("GET", "/api/city-state", query={"scenarioAt": "2026-05-20T21:00:00+08:00"}),
            None,
        )
        crowd = {c["stationId"]: c for c in json.loads(result["body"])["crowd"]}

        assert crowd["BS_MRT_BL17"]["mrtDiversionTriggered"] is True
        assert crowd["BS_TPE_DOME"]["domeDispersalTriggered"] is False
        assert crowd["BS_TPE_101"]["multilingualTriggered"] is True
        assert crowd["BS_MRT_BL16"]["multilingualTriggered"] is False

    def test_crowd_judgments_are_cached_across_repeated_polls(self):
        query = {"scenarioAt": "2026-05-20T21:00:00+08:00"}
        handler.handler(_event("GET", "/api/city-state", query=query), None)

        conn = psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row)
        count_after_first = conn.execute("SELECT count(*) AS n FROM crowd_decisions").fetchone()["n"]

        handler.handler(_event("GET", "/api/city-state", query=query), None)
        count_after_second = conn.execute("SELECT count(*) AS n FROM crowd_decisions").fetchone()["n"]
        conn.close()

        assert count_after_first == 3  # mrt_diversion + dome_dispersal + multilingual
        assert count_after_second == count_after_first

    def test_crowd_judgment_llm_path_is_actually_invoked_when_configured(self, monkeypatch):
        import json as _json

        from agent.llm_client import LLMClient

        class _FakeClient(LLMClient):
            def complete(self, system, prompt, *, max_tokens=1024):
                return _json.dumps(
                    {"triggered": True, "sop_section_id": "3", "result": {}, "reasoning": "fake"}
                )

        monkeypatch.setattr("agent.decision_agent.get_configured_llm_client", lambda: _FakeClient())
        result = handler.handler(
            _event("GET", "/api/city-state", query={"scenarioAt": "2026-05-20T21:00:00+08:00"}),
            None,
        )
        crowd = {c["stationId"]: c for c in json.loads(result["body"])["crowd"]}
        assert crowd["BS_MRT_BL17"]["mrtDiversionSource"] == "llm"
        assert crowd["BS_MRT_BL17"]["mrtDiversionReasoning"] == "fake"


class TestCreateIncident:
    def test_creates_and_returns_incident(self):
        body = {
            "context": {"scenarioAt": "2026-05-20T21:00:00+08:00"},
            "incident": {
                "eventId": "TEST_EVT_CREATE",
                "type": "Road_Collapse_Accident",
                "location": "測試地點",
                "status": "Closed",
                "severity": "Critical",
                "description": "測試建立事件",
                "roadImpacts": [{"segmentId": "RD_TPE_003", "role": "primary"}],
                "stationImpacts": [],
            },
        }
        result = handler.handler(_event("POST", "/api/incidents", body), None)
        assert result["statusCode"] == 200
        created = json.loads(result["body"])["incident"]
        assert created["eventId"] == "TEST_EVT_CREATE"

        fetched = db.fetch_incident(
            psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row), "TEST_EVT_CREATE"
        )
        assert fetched.affected_segment == "RD_TPE_003"

    def test_missing_field_is_400(self):
        result = handler.handler(
            _event("POST", "/api/incidents", {"context": {"scenarioAt": "2026-05-20T21:00:00+08:00"}}),
            None,
        )
        assert result["statusCode"] == 400


class TestEvaluateIncident:
    def test_unknown_event_id_is_404(self):
        result = handler.handler(
            _event(
                "POST", "/api/incidents/NOT_REAL/evaluate",
                {"context": {"scenarioAt": "2026-05-20T22:10:00+08:00"}},
            ),
            None,
        )
        assert result["statusCode"] == 404

    def test_evaluates_the_seeded_accident_and_checks_both_applicable_sops(self):
        """No incident.type pre-filter anymore -- every incident is checked
        against both accident/§2 and signal_failure/§5 independently, so
        this Road_Collapse_Accident incident should come back with the
        accident check triggered and the signal_failure check present but
        not triggered (both were considered, not just one guessed)."""
        result = handler.handler(
            _event(
                "POST", "/api/incidents/TPE_2026_ACC_001/evaluate",
                {"context": {"scenarioAt": "2026-05-20T22:10:00+08:00"}},
            ),
            None,
        )
        assert result["statusCode"] == 200
        decisions = {d["alertKind"]: d for d in json.loads(result["body"])["aiDecisions"]}
        assert set(decisions) == {"accident", "signal_failure"}
        assert decisions["accident"]["triggered"] is True
        assert decisions["accident"]["sopSectionId"] == "2"
        assert decisions["accident"]["result"]["main_route"] == "RD_TPE_004"
        assert decisions["signal_failure"]["triggered"] is False

        conn = psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row)
        row = conn.execute(
            "SELECT count(*) AS n FROM response_alerts "
            "WHERE event_id = 'TPE_2026_ACC_001' AND scenario_at = '2026-05-20T22:10:00+08:00'"
        ).fetchone()
        assert row["n"] == 2  # one row per alert_kind checked, at this scenario time
        conn.close()
        conn = psycopg.connect(DATABASE_URL)
        conn.execute("DELETE FROM response_alerts WHERE event_id = 'TPE_2026_ACC_001'")
        conn.commit()
        conn.close()

    def test_second_call_for_same_scenario_time_is_served_from_cache(self):
        req = _event(
            "POST", "/api/incidents/TPE_2026_ACC_001/evaluate",
            {"context": {"scenarioAt": "2026-05-20T22:10:00+08:00"}},
        )
        first = handler.handler(req, None)
        assert first["statusCode"] == 200

        conn = psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row)
        count_query = (
            "SELECT count(*) AS n FROM response_alerts "
            "WHERE event_id = 'TPE_2026_ACC_001' AND scenario_at = '2026-05-20T22:10:00+08:00'"
        )
        count_after_first = conn.execute(count_query).fetchone()["n"]

        second = handler.handler(req, None)
        assert second["statusCode"] == 200
        count_after_second = conn.execute(count_query).fetchone()["n"]

        assert count_after_first == 2  # accident + signal_failure, each cached once
        assert count_after_second == 2  # no new rows -- cache hit

        conn.execute("DELETE FROM response_alerts WHERE event_id = 'TPE_2026_ACC_001'")
        conn.commit()
        conn.close()

    def test_signal_failure_incident_also_checked_against_accident_and_not_triggered(self):
        """Mirror case: a Power_Failure incident should still get checked
        against accident/§2 (and correctly not trigger it -- severity=Medium
        isn't in {High,Critical}), proving neither check is skipped based on
        incident.type."""
        result = handler.handler(
            _event(
                "POST", "/api/incidents/TPE_2026_EVT_003/evaluate",
                {"context": {"scenarioAt": "2026-05-20T22:30:00+08:00"}},
            ),
            None,
        )
        assert result["statusCode"] == 200
        decisions = {d["alertKind"]: d for d in json.loads(result["body"])["aiDecisions"]}
        assert set(decisions) == {"accident", "signal_failure"}
        assert decisions["signal_failure"]["triggered"] is True
        assert decisions["signal_failure"]["sopSectionId"] == "5"
        assert decisions["accident"]["triggered"] is False

        conn = psycopg.connect(DATABASE_URL)
        conn.execute("DELETE FROM response_alerts WHERE event_id = 'TPE_2026_EVT_003'")
        conn.commit()
        conn.close()


class TestChatWithDbContext:
    def test_answers_with_db_backed_situational_facts(self):
        result = handler.handler(
            _event(
                "POST", "/api/chat",
                {
                    "context": {"scenarioAt": "2026-05-20T22:30:00+08:00", "audience": "government"},
                    "message": "現在有哪些事件？",
                },
            ),
            None,
        )
        assert result["statusCode"] == 200
        answer = json.loads(result["body"])["answer"]
        assert answer["text"]

    def test_llm_is_actually_invoked_when_configured(self, monkeypatch):
        import json as _json

        from agent.llm_client import LLMClient

        class _FakeClient(LLMClient):
            def complete(self, system, prompt, *, max_tokens=1024):
                return _json.dumps({"text": "假的聊天回覆", "sopRefs": ["SOP §3"]})

        monkeypatch.setattr("agent.chat.get_configured_llm_client", lambda: _FakeClient())
        result = handler.handler(
            _event(
                "POST", "/api/chat",
                {
                    "context": {"scenarioAt": "2026-05-20T21:00:00+08:00", "audience": "government"},
                    "message": "測試問題",
                },
            ),
            None,
        )
        answer = json.loads(result["body"])["answer"]
        assert answer["source"] == "llm"
        assert answer["text"] == "假的聊天回覆"

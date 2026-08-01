"""Tests for the DB-backed per-service Lambda handlers (city_state/,
incident/, decision/, chat/) -- run against a real local Postgres for
operational data (see tests/test_db.py's module docstring for the setup)
plus moto's in-memory S3 mock for the decision cache (see
tests/test_s3_cache.py) -- never a real AWS call.
"""
from __future__ import annotations

import json
import os
import threading
import time

import pytest

psycopg = pytest.importorskip("psycopg")
moto = pytest.importorskip("moto")

import db  # noqa: E402
import s3_cache  # noqa: E402
from city_state.handler import handler as city_state_handler  # noqa: E402
from incident.handler import handler as incident_handler  # noqa: E402
from decision.handler import handler as decision_handler  # noqa: E402
from chat.handler import handler as chat_handler  # noqa: E402
from decision_routing import resolve_location  # noqa: E402

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:aicity@localhost:5432/aicity"
)
_BUCKET = "test-internal-results"

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
    monkeypatch.setenv("DATABASE_URL", DATABASE_URL)
    monkeypatch.setenv("INTERNAL_RESULTS_BUCKET", _BUCKET)
    monkeypatch.delenv("DECISION_GENERATOR_WORKER_FUNCTION_NAME", raising=False)
    _delete_test_rows()
    with moto.mock_aws():
        import boto3

        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=_BUCKET)
        yield
        # worker_invoke.py's local fallback runs decision-generator-worker in
        # a background daemon thread (no real Lambda to invoke asynchronously
        # in tests). Join any such thread before the mocked S3 context exits,
        # or it can bleed into a later test and hit a bucket that no longer
        # exists in that test's own fresh moto context.
        _join_background_threads()
    _delete_test_rows()


def _join_background_threads(timeout: float = 5.0) -> None:
    main = threading.main_thread()
    deadline = time.time() + timeout
    for t in threading.enumerate():
        if t is main or not t.is_alive():
            continue
        t.join(timeout=max(0.0, deadline - time.time()))


def _delete_test_rows():
    conn = psycopg.connect(DATABASE_URL)
    conn.execute("DELETE FROM incidents WHERE event_id LIKE 'TEST_%'")
    conn.commit()
    conn.close()


def _event(method: str, path: str, body: dict | None = None, query: dict | None = None, path_params: dict | None = None) -> dict:
    return {
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "body": json.dumps(body) if body is not None else None,
        "queryStringParameters": query,
        "pathParameters": path_params,
    }


def _wait_for_cache(fetch, timeout=5.0):
    """decision/handler.py's cache-miss path invokes decision-generator-worker
    asynchronously (a background thread in this no-Lambda-runtime test
    environment -- see worker_invoke.py) -- poll briefly instead of assuming
    it's finished by the time the HTTP call returns 202."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = fetch()
        if result is not None:
            return result
        time.sleep(0.05)
    return None


class TestCityState:
    def test_missing_scenario_at_is_400(self):
        result = city_state_handler(_event("GET", "/api/city-state"), None)
        assert result["statusCode"] == 400

    def test_returns_traffic_and_crowd_with_deterministic_tier(self):
        """Per data/api.md §1: city-state is raw state only, no SOP
        judgment content -- `tier` is the cheap deterministic threshold
        label (rules/congestion_tier.get_tier()), not a decide_congestion()
        LLM call. No activeIncidents field either (see city_state/handler.py's
        docstring on that spec gap)."""
        result = city_state_handler(
            _event("GET", "/api/city-state", query={"scenarioAt": "2026-05-20T21:00:00+08:00"}), None
        )
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert len(body["traffic"]) > 0
        assert all("tier" in t for t in body["traffic"])
        assert "activeIncidents" not in body
        assert "cityResponseTriggered" not in body["traffic"][0]

    def test_tier_matches_known_boundary_without_any_llm_configured(self):
        result = city_state_handler(
            _event("GET", "/api/city-state", query={"scenarioAt": "2026-05-20T21:00:00+08:00"}), None
        )
        traffic = {t["segmentId"]: t for t in json.loads(result["body"])["traffic"]}
        assert traffic["RD_TPE_001"]["saturationScore"] >= 0.85
        assert traffic["RD_TPE_001"]["tier"] == "B"


class TestIncidentCreate:
    def test_creates_incident_and_writes_s3_payload(self):
        body = {
            "context": {"scenarioAt": "2026-05-20T21:00:00+08:00"},
            "incident": {
                "eventId": "TEST_EVT_CREATE",
                "type": "Road_Collapse_Accident",
                "location": "測試地點",
                "affectedSegmentId": "RD_TPE_003",
                "status": "Closed",
                "severity": "Critical",
                "description": "測試建立事件",
                "occurredAt": "2026-05-20T21:00:00+08:00",
            },
        }
        result = incident_handler(_event("POST", "/api/incidents", body), None)
        assert result["statusCode"] == 202
        parsed = json.loads(result["body"])
        assert parsed["incident"]["eventId"] == "TEST_EVT_CREATE"
        assert parsed["processing"]["status"] == "queued"
        assert parsed["publication"]["status"] == "pending"

        conn = psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row)
        fetched = db.fetch_incident(conn, "TEST_EVT_CREATE")
        conn.close()
        assert fetched.affected_segment == "RD_TPE_003"

        import boto3

        obj = boto3.client("s3", region_name="us-east-1").get_object(
            Bucket=_BUCKET, Key="incidents/2026-05-20/TEST_EVT_CREATE.json"
        )
        assert json.loads(obj["Body"].read())["incident"]["eventId"] == "TEST_EVT_CREATE"

    def test_missing_field_is_400(self):
        result = incident_handler(
            _event("POST", "/api/incidents", {"context": {"scenarioAt": "2026-05-20T21:00:00+08:00"}}), None
        )
        assert result["statusCode"] == 400


class TestDecisionCacheAside:
    def test_unknown_location_id_is_400(self):
        result = decision_handler(
            _event("GET", "/api/decisions", query={"scenarioAt": "2026-05-20T21:00:00+08:00", "locationId": "XX_NOPE"}),
            None,
        )
        assert result["statusCode"] == 400

    def test_cache_hit_returns_200_with_ai_decision_shape(self):
        import api_common
        from agent.decision_agent import Decision

        parsed_scenario_at = api_common.parse_scenario_at("2026-05-20T21:00:00+08:00")
        s3_cache.save_congestion_decision(
            segment_id="RD_TPE_001",
            scenario_at=parsed_scenario_at,
            decision=Decision(
                triggered=True, sop_section_id="1", result={"tier": "A", "actions": ["x"]},
                reasoning="test reasoning", source="llm", public_message="test public",
            ),
        )

        result = decision_handler(
            _event("GET", "/api/decisions", query={"scenarioAt": "2026-05-20T21:00:00+08:00", "locationId": "RD_TPE_001"}),
            None,
        )
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["meta"]["cacheStatus"] == "hit"
        assert body["aiDecision"]["locationContext"]["locationId"] == "RD_TPE_001"
        assert body["aiDecision"]["summary"]["kind"] == "congestion"
        assert body["aiDecision"]["summary"]["sopRefs"] == ["SOP §1"]

    def test_cache_miss_triggers_worker_and_returns_202(self):
        result = decision_handler(
            _event("GET", "/api/decisions", query={"scenarioAt": "2026-05-20T21:00:00+08:00", "locationId": "RD_TPE_001"}),
            None,
        )
        assert result["statusCode"] == 202
        body = json.loads(result["body"])
        assert body["meta"]["cacheStatus"] == "miss"
        assert body["processing"]["status"] == "queued"

        import api_common

        parsed_scenario_at = api_common.parse_scenario_at("2026-05-20T21:00:00+08:00")
        cached = _wait_for_cache(
            lambda: s3_cache.fetch_cached_congestion_decision("RD_TPE_001", parsed_scenario_at)
        )
        assert cached is not None  # the background worker did eventually fill the cache
        assert cached.result.get("tier") == "B"

    def test_incident_affected_segment_routes_to_accident_check(self):
        import api_common

        conn = db.connect()
        try:
            route = resolve_location(conn, "RD_TPE_002", api_common.parse_scenario_at("2026-05-20T22:15:00+08:00"))
        finally:
            conn.close()
        assert route.kind == "incident"
        assert route.event_id == "TPE_2026_ACC_001"


class TestChatWithDbContext:
    def test_answers_with_db_backed_situational_facts(self):
        result = chat_handler(
            _event(
                "POST", "/api/chat/messages",
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
        assert "messageId" in answer

    def test_llm_is_actually_invoked_when_configured(self, monkeypatch):
        import json as _json

        from agent.llm_client import LLMClient

        class _FakeClient(LLMClient):
            def complete(self, system, prompt, *, max_tokens=1024):
                return _json.dumps({"text": "假的聊天回覆", "sopRefs": ["SOP §3"]})

        monkeypatch.setattr("agent.chat.get_configured_llm_client", lambda: _FakeClient())
        result = chat_handler(
            _event(
                "POST", "/api/chat/messages",
                {
                    "context": {"scenarioAt": "2026-05-20T21:00:00+08:00", "audience": "government"},
                    "message": "測試問題",
                },
            ),
            None,
        )
        answer = json.loads(result["body"])["answer"]
        assert answer["text"] == "假的聊天回覆"
        assert answer["sopRefs"] == ["SOP §3"]

    def test_public_audience_never_gets_sop_refs_even_if_llm_returns_them(self, monkeypatch):
        """Defense in depth, mirrors decide()'s public_message split -- never
        trust the model alone to keep internal references out of the
        public-facing answer."""
        import json as _json

        from agent.llm_client import LLMClient

        class _FakeClient(LLMClient):
            def complete(self, system, prompt, *, max_tokens=1024):
                return _json.dumps({"text": "public answer", "sopRefs": ["SOP §3"]})

        monkeypatch.setattr("agent.chat.get_configured_llm_client", lambda: _FakeClient())
        result = chat_handler(
            _event(
                "POST", "/api/chat/messages",
                {
                    "context": {"scenarioAt": "2026-05-20T21:00:00+08:00", "audience": "public"},
                    "message": "測試問題",
                },
            ),
            None,
        )
        answer = json.loads(result["body"])["answer"]
        assert answer["sopRefs"] == []

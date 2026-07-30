"""Tests for the agent/narrator layer and the /api/agent Lambda route.

No AWS/Anthropic credentials exist in this environment yet, so these only
exercise the canned-template fallback path (agent/templates.py) plus the
LLM-calling code path via a fake in-memory LLMClient (dependency injection),
never a real network call. Once real credentials are available, add a
provider-specific integration test alongside these rather than replacing them
-- the fallback path must keep working regardless.
"""
from __future__ import annotations

import json

import pytest

import handler
from agent.llm_client import LLMClient, get_configured_llm_client
from agent.narrator import StructuredEvent, answer_what_if, generate_multilingual, summarize
from agent.templates import MSG_TEMPLATES


class FakeLLMClient(LLMClient):
    """Records the prompt it was given and returns a fixed response, so
    tests can assert the narrator wired the call correctly without hitting
    a real provider."""

    def __init__(self, response: str = "fake-llm-response"):
        self.response = response
        self.calls: list[dict[str, str]] = []

    def complete(self, system: str, prompt: str, *, max_tokens: int = 1024) -> str:
        self.calls.append({"system": system, "prompt": prompt})
        return self.response


@pytest.fixture(autouse=True)
def no_llm_credentials(monkeypatch):
    """Every test in this file runs as if no provider is configured, unless
    it explicitly injects a FakeLLMClient -- keeps results independent of
    whatever happens to be in the environment running the suite."""
    monkeypatch.delenv("BEDROCK_AGENTCORE_RUNTIME_ARN", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


class TestConfiguredClientDetection:
    def test_no_env_vars_means_no_client(self):
        assert get_configured_llm_client() is None

    def test_agentcore_arn_takes_priority_over_anthropic_key(self, monkeypatch):
        monkeypatch.setenv("BEDROCK_AGENTCORE_RUNTIME_ARN", "arn:aws:bedrock-agentcore:...")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-fake")
        from agent.llm_client import BedrockAgentCoreLLMClient

        client = get_configured_llm_client()
        assert isinstance(client, BedrockAgentCoreLLMClient)


class TestTemplatesFallback:
    def test_generate_multilingual_covers_all_four_languages(self):
        messages = generate_multilingual(
            "congestion", {"location": "忠孝東路", "ete": "20"}
        )
        assert set(messages) == {"zh", "en", "ja", "ko"}
        assert "忠孝東路" in messages["zh"]
        assert "20" in messages["en"]

    def test_unknown_message_type_raises(self):
        with pytest.raises(KeyError):
            generate_multilingual("not_a_real_type", {})

    @pytest.mark.parametrize("message_type", list(MSG_TEMPLATES))
    def test_every_message_type_is_generatable(self, message_type):
        # every template references the same two placeholder keys except
        # congestion/mrt_diversion which use `location` -- exercise with a
        # superset of keys so all branches are covered without per-type maps
        values = {"location": "測試站", "segment": "測試路段", "detour": "備援路段", "ete": "15"}
        messages = generate_multilingual(message_type, values)
        assert len(messages) == 4


class TestSummarizeFallback:
    def test_city_response_kind(self):
        text = summarize(
            StructuredEvent(
                kind="city_response",
                title="忠孝東路壅塞",
                data={"segmentName": "忠孝東路四段", "saturation": "0.96", "tier": "A"},
                sop_ref="SOP 第1條",
            )
        )
        assert "忠孝東路四段" in text
        assert "SOP 第1條" in text

    def test_accident_kind_with_congestion_warning(self):
        text = summarize(
            StructuredEvent(
                kind="accident",
                title="光復南路封閉",
                data={
                    "segmentName": "光復南路",
                    "incidentDesc": "路面塌陷",
                    "statusLabel": "封閉",
                    "severity": "Critical",
                    "mainRoute": "市民大道四段",
                    "ete": "83",
                    "congestionWarning": "true",
                },
            )
        )
        assert "83" in text
        assert "建議併行大眾運輸" in text

    def test_unknown_kind_still_returns_generic_text(self):
        text = summarize(StructuredEvent(kind="something_new", title="x", data={}))
        assert "規則引擎判定完成" in text

    def test_answer_what_if_includes_question_and_sop_excerpt(self):
        text = answer_what_if(
            "若 BL17 人數增加到 40000 人會怎樣？",
            {"rule": "checkMrtDiversion", "triggered": True},
            "[SOP §3 捷運與接駁分流]\n觸發 (任一成立)：...",
        )
        assert "40000" in text
        assert "SOP §3" in text


class TestNarratorWithInjectedFakeClient:
    """Proves the LLM-calling branch is wired correctly (prompt built,
    client invoked, response passed through) without a real provider."""

    def test_summarize_calls_the_injected_client(self):
        fake = FakeLLMClient("這是假的 LLM 回覆")
        event = StructuredEvent(kind="city_response", title="t", data={"saturation": "0.9"})
        result = summarize(event, llm_client=fake)
        assert result == "這是假的 LLM 回覆"
        assert len(fake.calls) == 1
        assert "city_response" in fake.calls[0]["prompt"]

    def test_answer_what_if_calls_the_injected_client(self):
        fake = FakeLLMClient("假回答")
        result = answer_what_if("問題", {"a": 1}, "SOP 原文", llm_client=fake)
        assert result == "假回答"
        assert "問題" in fake.calls[0]["prompt"]


def _api_gw_event(method: str, path: str, body: dict | None = None) -> dict:
    return {
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "body": json.dumps(body) if body is not None else None,
    }


class TestHandlerRouting:
    def test_health(self):
        result = handler.handler(_api_gw_event("GET", "/api/health"), None)
        assert result["statusCode"] == 200
        assert json.loads(result["body"])["message"] == "AI City Commander API is running"

    def test_schema(self):
        result = handler.handler(_api_gw_event("GET", "/api/schema"), None)
        assert result["statusCode"] == 200
        assert "actions" in json.loads(result["body"])

    def test_unknown_path_is_404(self):
        result = handler.handler(_api_gw_event("GET", "/api/nope"), None)
        assert result["statusCode"] == 404

    def test_agent_summarize(self):
        body = {
            "action": "summarize",
            "kind": "mrt_diversion",
            "title": "BL17",
            "data": {"stationName": "捷運國父紀念館站", "userCount": "33000", "growthRate": "0.06"},
        }
        result = handler.handler(_api_gw_event("POST", "/api/agent", body), None)
        assert result["statusCode"] == 200
        text = json.loads(result["body"])["text"]
        assert "捷運國父紀念館站" in text

    def test_agent_answer_what_if(self):
        body = {
            "action": "answer_what_if",
            "question": "若飽和度到 0.96 會怎樣？",
            "ruleResult": {"tier": "A"},
            "sopExcerpt": "SOP 第1條...",
        }
        result = handler.handler(_api_gw_event("POST", "/api/agent", body), None)
        assert result["statusCode"] == 200
        assert "0.96" in json.loads(result["body"])["text"]

    def test_agent_generate_multilingual(self):
        body = {
            "action": "generate_multilingual",
            "messageType": "congestion",
            "values": {"location": "信義區", "ete": "10"},
        }
        result = handler.handler(_api_gw_event("POST", "/api/agent", body), None)
        assert result["statusCode"] == 200
        messages = json.loads(result["body"])["messages"]
        assert set(messages) == {"zh", "en", "ja", "ko"}

    def test_agent_missing_field_is_400(self):
        result = handler.handler(
            _api_gw_event("POST", "/api/agent", {"action": "summarize"}), None
        )
        assert result["statusCode"] == 400

    def test_agent_unknown_action_is_400(self):
        result = handler.handler(
            _api_gw_event("POST", "/api/agent", {"action": "does_not_exist"}), None
        )
        assert result["statusCode"] == 400

    def test_agent_invalid_json_body_is_400(self):
        event = {
            "rawPath": "/api/agent",
            "requestContext": {"http": {"method": "POST"}},
            "body": "{not json",
        }
        result = handler.handler(event, None)
        assert result["statusCode"] == 400

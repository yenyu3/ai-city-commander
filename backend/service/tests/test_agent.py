"""Tests for the agent/narrator layer and the /api/agent Lambda route.

No AWS/Anthropic credentials exist in this environment yet, so these only
exercise the canned-template fallback path (agent/templates.py) plus the
LLM-calling code path via a fake in-memory LLMClient (dependency injection),
never a real network call. Once real credentials are available, add a
provider-specific integration test alongside these rather than replacing them
-- the fallback path must keep working regardless.
"""
from __future__ import annotations

import pytest

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
    monkeypatch.delenv("BEDROCK_MODEL_ID", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OMNIROUTE_BASE_URL", raising=False)
    monkeypatch.delenv("OMNIROUTE_MODEL", raising=False)


class TestConfiguredClientDetection:
    def test_no_env_vars_means_no_client(self):
        assert get_configured_llm_client() is None

    def test_agentcore_arn_takes_priority_over_anthropic_key(self, monkeypatch):
        monkeypatch.setenv("BEDROCK_AGENTCORE_RUNTIME_ARN", "arn:aws:bedrock-agentcore:...")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-fake")
        from agent.llm_client import BedrockAgentCoreLLMClient

        client = get_configured_llm_client()
        assert isinstance(client, BedrockAgentCoreLLMClient)

    def test_omniroute_only_activates_when_explicitly_configured(self, monkeypatch):
        from agent.llm_client import OmniRouteLLMClient

        assert get_configured_llm_client() is None
        monkeypatch.setenv("OMNIROUTE_BASE_URL", "http://localhost:20128/v1")
        client = get_configured_llm_client()
        assert isinstance(client, OmniRouteLLMClient)

    def test_anthropic_key_takes_priority_over_omniroute(self, monkeypatch):
        from agent.llm_client import AnthropicLLMClient

        monkeypatch.setenv("OMNIROUTE_BASE_URL", "http://localhost:20128/v1")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-fake")
        client = get_configured_llm_client()
        assert isinstance(client, AnthropicLLMClient)

    def test_bedrock_only_activates_when_explicitly_configured(self, monkeypatch):
        from agent.llm_client import BedrockLLMClient

        assert get_configured_llm_client() is None
        monkeypatch.setenv("BEDROCK_MODEL_ID", "apac.anthropic.claude-sonnet-4-5-20250929-v1:0")
        client = get_configured_llm_client()
        assert isinstance(client, BedrockLLMClient)

    def test_bedrock_takes_priority_over_anthropic_key(self, monkeypatch):
        from agent.llm_client import BedrockLLMClient

        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-fake")
        monkeypatch.setenv("BEDROCK_MODEL_ID", "apac.anthropic.claude-sonnet-4-5-20250929-v1:0")
        client = get_configured_llm_client()
        assert isinstance(client, BedrockLLMClient)

    def test_agentcore_arn_takes_priority_over_bedrock(self, monkeypatch):
        from agent.llm_client import BedrockAgentCoreLLMClient

        monkeypatch.setenv("BEDROCK_MODEL_ID", "apac.anthropic.claude-sonnet-4-5-20250929-v1:0")
        monkeypatch.setenv("BEDROCK_AGENTCORE_RUNTIME_ARN", "arn:aws:bedrock-agentcore:...")
        client = get_configured_llm_client()
        assert isinstance(client, BedrockAgentCoreLLMClient)


class TestOmniRouteLLMClient:
    """Mocks urllib so these never depend on the local OmniRoute router
    actually being up/reachable/unrateimited -- see backend/README.md for
    what its live behavior looked like when last checked."""

    def test_complete_parses_a_successful_response(self, monkeypatch):
        import json as _json

        from agent.llm_client import OmniRouteLLMClient

        captured_request = {}

        class _FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return _json.dumps(
                    {"choices": [{"message": {"content": "測試回覆"}}]}
                ).encode("utf-8")

        def fake_urlopen(request, timeout=None):
            captured_request["url"] = request.full_url
            captured_request["body"] = _json.loads(request.data)
            captured_request["timeout"] = timeout
            return _FakeResponse()

        monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

        client = OmniRouteLLMClient("http://localhost:20128/v1", model="auto/claude-sonnet")
        result = client.complete("system prompt", "user prompt", max_tokens=200)

        assert result == "測試回覆"
        assert captured_request["url"] == "http://localhost:20128/v1/chat/completions"
        assert captured_request["body"]["model"] == "auto/claude-sonnet"
        assert captured_request["body"]["stream"] is False
        assert captured_request["body"]["messages"] == [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "user prompt"},
        ]

    def test_complete_raises_on_error_payload(self, monkeypatch):
        import json as _json

        from agent.llm_client import OmniRouteLLMClient

        class _FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return _json.dumps(
                    {"error": {"message": "Maximum combo retry limit reached"}}
                ).encode("utf-8")

        monkeypatch.setattr(
            "urllib.request.urlopen", lambda request, timeout=None: _FakeResponse()
        )

        client = OmniRouteLLMClient("http://localhost:20128/v1")
        with pytest.raises(RuntimeError, match="Maximum combo retry limit reached"):
            client.complete("s", "p")


class TestBedrockLLMClient:
    """Mocks boto3 so these never make a real AWS call or need real
    credentials -- BedrockLLMClient's whole point is that it authenticates
    via the caller's IAM role/profile, which this test environment doesn't
    have configured."""

    def test_complete_parses_a_successful_converse_response(self, monkeypatch):
        from agent.llm_client import BedrockLLMClient

        captured_call = {}

        class _FakeBedrockRuntimeClient:
            def converse(self, **kwargs):
                captured_call.update(kwargs)
                return {"output": {"message": {"content": [{"text": "測試回覆"}]}}}

        class _FakeBoto3Module:
            @staticmethod
            def client(service_name, region_name=None):
                captured_call["service_name"] = service_name
                captured_call["region_name"] = region_name
                return _FakeBedrockRuntimeClient()

        monkeypatch.setitem(__import__("sys").modules, "boto3", _FakeBoto3Module())

        client = BedrockLLMClient("apac.anthropic.claude-sonnet-4-5-20250929-v1:0", region="ap-northeast-1")
        result = client.complete("system prompt", "user prompt", max_tokens=200)

        assert result == "測試回覆"
        assert captured_call["service_name"] == "bedrock-runtime"
        assert captured_call["region_name"] == "ap-northeast-1"
        assert captured_call["modelId"] == "apac.anthropic.claude-sonnet-4-5-20250929-v1:0"
        assert captured_call["system"] == [{"text": "system prompt"}]
        assert captured_call["messages"] == [{"role": "user", "content": [{"text": "user prompt"}]}]
        assert captured_call["inferenceConfig"] == {"maxTokens": 200}

    def test_complete_raises_on_client_error(self, monkeypatch):
        from botocore.exceptions import ClientError

        from agent.llm_client import BedrockLLMClient

        class _FakeBedrockRuntimeClient:
            def converse(self, **kwargs):
                raise ClientError(
                    {"Error": {"Code": "AccessDeniedException", "Message": "not authorized"}},
                    "Converse",
                )

        class _FakeBoto3Module:
            @staticmethod
            def client(service_name, region_name=None):
                return _FakeBedrockRuntimeClient()

        monkeypatch.setitem(__import__("sys").modules, "boto3", _FakeBoto3Module())

        client = BedrockLLMClient("apac.anthropic.claude-sonnet-4-5-20250929-v1:0")
        with pytest.raises(RuntimeError, match="not authorized"):
            client.complete("s", "p")


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


class FailingLLMClient(LLMClient):
    """Simulates a configured-but-unreachable provider, e.g. the ~40%
    failure rate observed live against the local OmniRoute router."""

    def complete(self, system: str, prompt: str, *, max_tokens: int = 1024) -> str:
        raise RuntimeError("Maximum combo retry limit reached")


class TestNarratorFallsBackOnProviderFailure:
    """A *configured* client that fails at call time must still degrade to
    the canned template, not propagate the error -- 'a client exists' must
    not imply 'a real answer always comes back' (see narrator._complete_or_fallback).
    """

    def test_summarize_falls_back_when_the_client_raises(self):
        event = StructuredEvent(
            kind="mrt_diversion",
            title="t",
            data={"stationName": "捷運國父紀念館站", "userCount": "33000", "growthRate": "0.06"},
        )
        result = summarize(event, llm_client=FailingLLMClient())
        assert "捷運國父紀念館站" in result  # same content the pure-template test expects

    def test_answer_what_if_falls_back_when_the_client_raises(self):
        result = answer_what_if(
            "若飽和度到 0.96 會怎樣？", {"tier": "A"}, "SOP 第1條...", llm_client=FailingLLMClient()
        )
        assert "0.96" in result


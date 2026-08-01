"""Tests for agent/chat.py and the POST /api/chat route.

Direction being verified: chat must be able to trigger a genuine LLM call
(not just narrate a pre-computed rule result), and that call must carry the
full SOP text -- not a narrowed keyword-matched excerpt. FakeLLMClient
injection proves the wiring without a real network call.
"""
from __future__ import annotations

import json

import pytest

from agent.chat import answer_chat
from agent.llm_client import LLMClient
from agent.sop_sections import FULL_SOP_TEXT


class FakeLLMClient(LLMClient):
    def __init__(self, response: str):
        self.response = response
        self.calls: list[dict[str, str]] = []

    def complete(self, system: str, prompt: str, *, max_tokens: int = 1024) -> str:
        self.calls.append({"system": system, "prompt": prompt})
        return self.response


class RaisingLLMClient(LLMClient):
    def complete(self, system: str, prompt: str, *, max_tokens: int = 1024) -> str:
        raise RuntimeError("Maximum combo retry limit reached")


@pytest.fixture(autouse=True)
def no_llm_credentials(monkeypatch):
    monkeypatch.delenv("BEDROCK_AGENTCORE_RUNTIME_ARN", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OMNIROUTE_BASE_URL", raising=False)


class TestAnswerChatWiring:
    def test_prompt_carries_the_full_sop_text_not_an_excerpt(self):
        fake = FakeLLMClient(json.dumps({"text": "假回答", "sopRefs": ["SOP §3"]}))
        answer_chat("BL17 人數 26000，成長率 35%", {"stub": True}, llm_client=fake)
        prompt = fake.calls[0]["prompt"]
        assert FULL_SOP_TEXT in prompt
        # sanity: all seven articles' titles are present, not just one section
        for title in ("交通擁塞級別判定", "車禍與路障應變", "捷運與接駁分流",
                       "大巨蛋散場啟動", "號誌故障應變", "數位通報與多語化", "預計恢復時間ETE"):
            assert title in prompt

    def test_government_answer_includes_sop_refs(self):
        fake = FakeLLMClient(json.dumps({"text": "建議過站不停", "sopRefs": ["SOP §3"]}))
        answer = answer_chat("問題", {}, audience="government", llm_client=fake)
        assert answer.text == "建議過站不停"
        assert answer.sop_refs == ["SOP §3"]
        assert answer.source == "llm"

    def test_public_prompt_instructs_no_sop_refs(self):
        fake = FakeLLMClient(json.dumps({"text": "建議改道", "sopRefs": []}))
        answer_chat("問題", {}, audience="public", llm_client=fake)
        prompt = fake.calls[0]["prompt"]
        assert "民眾模式一律回傳空陣列" in prompt

    def test_markdown_fenced_json_is_parsed(self):
        fake = FakeLLMClient('```json\n{"text": "回答", "sopRefs": []}\n```')
        answer = answer_chat("問題", {}, llm_client=fake)
        assert answer.text == "回答"


class TestAnswerChatFallback:
    def test_no_client_falls_back_to_keyword_match(self):
        answer = answer_chat("BL17 人數增加到 40000 人會怎樣？", {}, llm_client=None)
        assert answer.source == "fallback"
        assert "SOP §3" in answer.sop_refs

    def test_client_exception_falls_back(self):
        answer = answer_chat("問題", {}, llm_client=RaisingLLMClient())
        assert answer.source == "fallback"

    def test_public_fallback_never_leaks_sop_refs(self):
        answer = answer_chat("BL17 人數增加到 40000 人會怎樣？", {}, audience="public", llm_client=None)
        assert answer.sop_refs == []
        assert "SOP" not in answer.text


def _event(body: dict) -> dict:
    return {
        "rawPath": "/api/chat/messages",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps(body),
    }


class TestChatHandlerWithoutDb:
    """These exercise routing/validation only -- DB-backed happy-path chat
    is covered in test_handler_db_routes.py-style tests where a real
    Postgres is available."""

    def test_missing_scenario_at_is_400(self):
        from chat.handler import handler as chat_handler

        result = chat_handler(_event({"message": "hi"}), None)
        assert result["statusCode"] == 400

    def test_missing_message_is_400(self):
        from chat.handler import handler as chat_handler

        result = chat_handler(
            _event({"context": {"scenarioAt": "2026-05-20T21:00:00+08:00"}}), None
        )
        assert result["statusCode"] == 400

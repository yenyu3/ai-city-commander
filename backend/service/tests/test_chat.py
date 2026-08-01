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

    def test_government_answer_includes_reasoning_steps(self):
        """data/api.md §5's government-mode example (lines 738-759) shows a
        populated reasoningSteps array -- verify the LLM's steps survive
        parsing, in order, with sopRef preserved."""
        fake = FakeLLMClient(json.dumps({
            "text": "建議過站不停",
            "sopRefs": ["SOP §3"],
            "reasoningSteps": [
                {"order": 1, "status": "info", "title": "取得情境輸入", "detail": "BL17 人數 26,000"},
                {"order": 2, "status": "pass", "title": "檢核捷運分流門檻", "detail": "26,000 > 25,000", "sopRef": "SOP §3"},
            ],
        }))
        answer = answer_chat("問題", {}, audience="government", llm_client=fake)
        assert len(answer.reasoning_steps) == 2
        assert answer.reasoning_steps[0].status == "info"
        assert answer.reasoning_steps[0].sop_ref is None
        assert answer.reasoning_steps[1].sop_ref == "SOP §3"
        prompt = fake.calls[0]["prompt"]
        assert "reasoningSteps" in prompt

    def test_malformed_reasoning_step_is_dropped_not_fatal(self):
        fake = FakeLLMClient(json.dumps({
            "text": "建議過站不停",
            "sopRefs": ["SOP §3"],
            "reasoningSteps": [
                {"order": 1, "status": "info", "title": "ok", "detail": "ok"},
                {"order": "not-a-number-but-unparseable", "status": "pass"},  # missing title/detail
            ],
        }))
        answer = answer_chat("問題", {}, audience="government", llm_client=fake)
        assert len(answer.reasoning_steps) == 1

    def test_public_answer_never_includes_reasoning_steps(self):
        """Public audience's doc example (lines 764-779) has no reasoningSteps
        key at all -- even if a misbehaving LLM included one, it must not
        leak through (same defense-in-depth as sopRefs)."""
        fake = FakeLLMClient(json.dumps({
            "text": "建議改道",
            "sopRefs": [],
            "reasoningSteps": [{"order": 1, "status": "info", "title": "x", "detail": "x", "sopRef": "SOP §3"}],
        }))
        answer = answer_chat("問題", {}, audience="public", llm_client=fake)
        assert answer.reasoning_steps == []

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
        assert answer.reasoning_steps == []  # no LLM judgment to trace

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

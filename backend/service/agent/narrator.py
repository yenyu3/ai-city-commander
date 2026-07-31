"""Generates natural-language output (report/SMS/what-if answers) from
already-computed structured facts. Calls a real LLM when one is configured
(agent.llm_client.get_configured_llm_client), and falls back to the canned
templates in agent.templates otherwise -- same resilience property as the
frontend's TemplateLLMAdapter, so this endpoint works today even without
AWS/Anthropic credentials.

The prompts below are written to keep the model in a pure narration role:
it is explicitly told not to (re)compute numbers, only to phrase results
that were already produced by `rules/`. This is the compute/generate split
agreed on for this project -- see the
feedback-agent-architecture-compute-vs-generate memory.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Callable, Optional

from . import templates
from .llm_client import LLMClient, get_configured_llm_client


@dataclass
class StructuredEvent:
    kind: str
    title: str
    data: dict[str, str] = field(default_factory=dict)
    sop_ref: Optional[str] = None


def _complete_or_fallback(
    client: LLMClient, *, system: str, prompt: str, make_fallback: Callable[[], str]
) -> str:
    """Calls the LLM client, but never lets a provider failure surface as an
    API error -- falls back to the canned text instead. This matters in
    practice, not just in theory: local testing against the OmniRoute router
    (a shared multi-provider pool) saw roughly a 40% failure rate
    ("Maximum combo retry limit reached") even with a client correctly
    configured, so "a client exists" must not imply "a real answer always
    comes back."

    `make_fallback` is a thunk, not a precomputed string: the fallback
    template functions require exact keys the caller's `data` dict may not
    always carry (real LLM prompts don't need those keys), so it must only
    run when actually needed, not unconditionally on the success path too.
    """
    try:
        return client.complete(system=system, prompt=prompt)
    except Exception as exc:  # noqa: BLE001 - any provider failure must fall back, not crash the request
        print(f"[agent.narrator] LLM call failed, falling back to template: {exc}", file=sys.stderr)
        return make_fallback()


def summarize(event: StructuredEvent, *, llm_client: Optional[LLMClient] = None) -> str:
    client = llm_client if llm_client is not None else get_configured_llm_client()
    make_fallback = lambda: templates.summarize_fallback(event.kind, event.data, event.sop_ref)
    if client is None:
        return make_fallback()

    sop_line = f"依據 SOP：{event.sop_ref}" if event.sop_ref else ""
    prompt = (
        f"事件類型：{event.kind}\n標題：{event.title}\n結構化資料：{event.data}\n{sop_line}\n\n"
        "請用一段繁體中文向交控中心指揮官說明此事件的判定結果與已觸發的處置動作，"
        "語氣專業、精簡，直接引用上述資料中的數值，不要虛構或重新計算任何未提供的數字。"
    )
    return _complete_or_fallback(
        client,
        system=(
            "你是台北市交通應變指揮系統的 AI 幕僚，只負責把已經計算好的結構化結果轉譯成"
            "自然語言，不做任何數值計算或門檻判斷。"
        ),
        prompt=prompt,
        make_fallback=make_fallback,
    )


def answer_what_if(
    question: str,
    rule_result: object,
    sop_excerpt: str,
    *,
    llm_client: Optional[LLMClient] = None,
) -> str:
    client = llm_client if llm_client is not None else get_configured_llm_client()
    make_fallback = lambda: templates.answer_what_if_fallback(question, rule_result, sop_excerpt)
    if client is None:
        return make_fallback()

    prompt = (
        f"指揮官的假設性問題：{question}\n"
        f"規則引擎重新計算後的結果：{rule_result}\n"
        f"相關 SOP 原文：\n{sop_excerpt}\n\n"
        "請根據上述規則引擎計算結果與 SOP 原文，用繁體中文簡潔回答指揮官的問題，"
        "並明確引用命中的 SOP 條號，不要自行重新計算或臆測數字。"
    )
    return _complete_or_fallback(
        client,
        system=(
            "你是台北市交通應變指揮系統的 AI 幕僚，只負責解釋已經算好的規則引擎結果並引用 "
            "SOP 原文，不做任何數值計算。"
        ),
        prompt=prompt,
        make_fallback=make_fallback,
    )


def generate_multilingual(message_type: str, v: dict[str, str]) -> dict[str, str]:
    # Deliberately templated even when an LLM is configured: fixed-format
    # CMS/SMS text is more reliable from deterministic sentence construction
    # than from LLM translation (same call the frontend adapter already made).
    return templates.generate_multilingual(message_type, v)

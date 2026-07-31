"""Full-SOP-aware chat answering for POST /api/chat (government + public
audience, shared).

Direction (2026-07-31): chat must trigger a genuine LLM call and that call
must have the complete SOP text available -- not the narrower
`narrator.answer_what_if()` path, which only hands the model a couple of
keyword-matched excerpts and treats the LLM as pure narration of an
already-computed rule result. Here the LLM sees the full 7-article SOP text
plus whatever situational facts are available and answers the free-text
question directly, including reasoning over What-if scenarios itself.

Falls back to a keyword-matched-excerpt answer (via
sop_sections.retrieve_relevant_sections, the same mechanism used before this
change) when no LLM is configured or the call fails -- same resilience
contract as the rest of agent/.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from typing import Any, Optional

from .llm_client import LLMClient, get_configured_llm_client
from .sop_sections import FULL_SOP_TEXT, retrieve_relevant_sections

_GOV_SYSTEM_PROMPT = (
    "你是台北市交通應變指揮系統的 AI 幕僚，服務對象是交控中心指揮官。"
    "你完整知道以下 SOP 七條全文，回答問題時必須引用相關條號，並且只能根據"
    "提供的情境數據作答，不要臆測或虛構未提供的數字。如果問題是假設性情境"
    "（What-if，例如「若某站人數增加到多少會怎樣」），請直接依 SOP 條文的"
    "門檻與邏輯代入計算，並在回答中說明計算依據。"
)

_PUBLIC_SYSTEM_PROMPT = (
    "你是台北市交通應變指揮系統面向民眾的助理。你完整知道 SOP 全文，但回答"
    "民眾問題時不要提及 SOP 條號、內部門檻數字或规则細節，只用白話文給出對"
    "民眾實際有幫助的建議（例如建議改道、預留時間、避開路段、搭乘資訊）。"
)


@dataclass
class ChatAnswer:
    text: str
    sop_refs: list[str] = field(default_factory=list)
    source: str = "llm"  # "llm" or "fallback"


def answer_chat(
    question: str,
    facts: dict[str, Any],
    *,
    audience: str = "government",
    llm_client: Optional[LLMClient] = None,
) -> ChatAnswer:
    client = llm_client if llm_client is not None else get_configured_llm_client()
    if client is None:
        return _fallback_answer(question, audience)

    system = _GOV_SYSTEM_PROMPT if audience == "government" else _PUBLIC_SYSTEM_PROMPT
    sop_ref_instruction = (
        '"sopRefs": ["引用的 SOP 條號字串，例如 \\"SOP §3\\""]'
        if audience == "government"
        else '"sopRefs": []  // 民眾模式一律回傳空陣列，不對外揭露條號'
    )
    prompt = (
        f"{FULL_SOP_TEXT}\n\n"
        f"=== 目前情境數據 ===\n{json.dumps(facts, ensure_ascii=False, indent=2)}\n\n"
        f"=== 使用者問題 ===\n{question}\n\n"
        "請用繁體中文回答，只能輸出一個 JSON 物件，不要有其他文字，格式：\n"
        f'{{"text": "回答內容", {sop_ref_instruction}}}'
    )
    try:
        raw = client.complete(system=system, prompt=prompt, max_tokens=1000)
        parsed = _parse_json_response(raw)
        return ChatAnswer(
            text=parsed["text"], sop_refs=parsed.get("sopRefs", []) or [], source="llm"
        )
    except Exception as exc:  # noqa: BLE001 - any failure must fall back, never crash the request
        print(f"[agent.chat] LLM chat call failed, falling back: {exc}", file=sys.stderr)
        return _fallback_answer(question, audience)


def _parse_json_response(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    return json.loads(text)


def _fallback_answer(question: str, audience: str) -> ChatAnswer:
    sections = retrieve_relevant_sections(question)
    refs = [f"SOP §{s.id}" for s in sections]
    if audience == "public":
        return ChatAnswer(
            text="目前系統暫時無法即時分析，建議留意現場指揮或官方公告，並預留額外通行時間。",
            sop_refs=[],
            source="fallback",
        )
    excerpt = sections[0].text.strip()[:200] if sections else ""
    return ChatAnswer(
        text=(
            f"（fallback：目前無可用 LLM，以下依關鍵字比對命中 {', '.join(refs) or '無'}"
            f" 供參考）\n{excerpt}"
        ),
        sop_refs=refs,
        source="fallback",
    )

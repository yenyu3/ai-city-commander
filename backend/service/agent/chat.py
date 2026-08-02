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

2026-08-01: government answers also carry `reasoning_steps` -- data/api.md
§5's government-mode example (lines 738-759) specifies this as a populated
array (`{order, status, title, detail, sopRef?}`), not an always-empty
placeholder; this module previously left it out ("a real content-generation
change, not a relocation" -- true, but it's still spec-required, not
optional). Requested in the SAME LLM call as `text`/`sopRefs` (one extra
JSON field, not a second call) so What-if reasoning is genuinely explained
step by step, matching the doc's worked example (info -> pass -> final).
Public audience never gets this (the doc's public example has no
`reasoningSteps` key at all, consistent with "不揭露...內部推理內容") --
always an empty list there, same as `sopRefs`.
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
    "門檻與邏輯代入計算，並在回答中說明計算依據。\n\n"
    "除了文字回答，還要拆解你的判斷過程成一系列有序步驟（reasoningSteps），"
    "讓指揮官清楚看到推理鏈：先列出你取得/引用的情境輸入，再列出你依 SOP 條文"
    "做的每一項檢核（通過或未通過），最後以結論步驟收尾。步驟數量依實際判斷"
    "複雜度而定，不要為了湊步驟數硬拆。"
)

_PUBLIC_SYSTEM_PROMPT = (
    "你是台北市交通應變指揮系統面向民眾的助理。你完整知道 SOP 全文，但回答"
    "民眾問題時不要提及 SOP 條號、內部門檻數字或规则細節，只用白話文給出對"
    "民眾實際有幫助的建議（例如建議改道、預留時間、避開路段、搭乘資訊）。"
)


@dataclass
class ReasoningStep:
    order: int
    status: str  # "info" | "pass" | "fail" | "final"
    title: str
    detail: str
    sop_ref: Optional[str] = None


@dataclass
class ChatAnswer:
    text: str
    sop_refs: list[str] = field(default_factory=list)
    source: str = "llm"  # "llm" or "fallback"
    reasoning_steps: list[ReasoningStep] = field(default_factory=list)


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
    if audience == "government":
        response_shape = (
            '"sopRefs": ["引用的 SOP 條號字串，例如 \\"SOP §3\\""], '
            '"reasoningSteps": [{"order": 1, "status": "info/pass/fail/final", '
            '"title": "步驟標題", "detail": "詳細說明", "sopRef": "SOP §3（可省略）"}, ...]'
        )
    else:
        response_shape = (
            '"sopRefs": []  // 民眾模式一律回傳空陣列，不對外揭露條號'
        )
    prompt = (
        f"{FULL_SOP_TEXT}\n\n"
        f"=== 目前情境數據 ===\n{json.dumps(facts, ensure_ascii=False, indent=2)}\n\n"
        f"=== 使用者問題 ===\n{question}\n\n"
        "請用繁體中文回答，只能輸出一個 JSON 物件，不要有其他文字，格式：\n"
        f'{{"text": "回答內容", {response_shape}}}'
    )
    try:
        # 1500 was too tight for government answers -- text + sopRefs + a
        # full reasoningSteps array (each step its own title/detail) on a
        # complex What-if question can run long, and a truncated response
        # means json.loads() fails and this silently falls back to the
        # keyword-excerpt path below, discarding a real LLM answer. Same
        # failure mode caught live in router_agent.py's narrate_for_focus,
        # which needed the same 8000 ceiling for the same reason.
        raw = client.complete(system=system, prompt=prompt, max_tokens=8000)
        parsed = _parse_json_response(raw)
        return ChatAnswer(
            text=parsed["text"],
            sop_refs=parsed.get("sopRefs", []) or [],
            source="llm",
            reasoning_steps=_parse_reasoning_steps(parsed.get("reasoningSteps"))
            if audience == "government"
            else [],
        )
    except Exception as exc:  # noqa: BLE001 - any failure must fall back, never crash the request
        print(f"[agent.chat] LLM chat call failed, falling back: {exc}", file=sys.stderr)
        return _fallback_answer(question, audience)


def _parse_reasoning_steps(raw: Any) -> list[ReasoningStep]:
    if not raw:
        return []
    steps = []
    for item in raw:
        try:
            steps.append(
                ReasoningStep(
                    order=int(item["order"]),
                    status=item["status"],
                    title=item["title"],
                    detail=item["detail"],
                    sop_ref=item.get("sopRef"),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue  # a malformed step is dropped, not fatal to the whole answer
    return steps


def _parse_json_response(raw: str) -> dict[str, Any]:
    import re

    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        # strict=False allows raw control characters (literal newlines etc.)
        # inside string values -- caught live on the deployed chat Lambda:
        # a real Bedrock call's long `text`/`reasoning` field contained an
        # actual newline instead of an escaped "\n", which json.loads()'s
        # default strict mode rejects outright ("Expecting property name
        # enclosed in double quotes"), silently discarding an otherwise-good
        # answer and falling back to the keyword-excerpt path.
        return json.loads(text, strict=False)
    except json.JSONDecodeError:
        pass
    try:
        # Same long-JSON trailing-comma slip caught live in
        # router_agent.py's _parse_json_response -- one retry with trailing
        # commas stripped before giving up and falling back.
        return json.loads(re.sub(r",(\s*[}\]])", r"\1", text), strict=False)
    except json.JSONDecodeError:
        # "Extra data" -- a real Bedrock call returned a complete, valid
        # JSON object followed by stray trailing content (e.g. the model
        # appended a stray sentence after the closing brace). json.loads()
        # requires the ENTIRE string to be exactly one JSON document;
        # raw_decode() instead parses just the first complete value and
        # ignores whatever follows, which is exactly what's needed here.
        obj, _end = json.JSONDecoder(strict=False).raw_decode(text)
        return obj


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

"""The primary decision-maker for every SOP judgment call.

Direction (2026-07-27): the LLM must participate in the actual judgment --
which SOP article applies, tier classification, route selection -- not just
narrate a result the code already decided. This module is given raw facts
that are never pre-classified (see agent/facts.py) plus the full SOP text,
and asks the model to decide what applies and produce its reasoning in one
shot, citing the SOP article it used.

`rules/*.py`'s deterministic functions are kept as the fallback decision
path (the `fallback` callable each caller in agent/facts.py provides) for
when no LLM is configured, the call fails, or the response isn't parseable
JSON -- same resilience contract as narrator.py's template fallback for
narration failures. That fallback is a safety net, not the intended normal
path: whenever a provider is configured and reachable, its decision is
authoritative, including on exact numeric boundary cases -- accept that a
live LLM call is not perfectly reproducible run to run, unlike the
deterministic fallback it replaces as the primary path.
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .llm_client import LLMClient, get_configured_llm_client
from .sop_sections import FULL_SOP_TEXT


@dataclass
class ReasoningStep:
    order: int
    status: str  # "info" | "pass" | "fail" | "final"
    title: str
    detail: str
    sop_ref: Optional[str] = None


@dataclass
class Decision:
    triggered: bool
    sop_section_id: Optional[str]
    result: dict[str, Any] = field(default_factory=dict)
    reasoning: str = ""
    source: str = "llm"  # "llm" or "fallback"
    # Citizen-facing text, produced in the SAME call as `reasoning` (see
    # data/api.md line 638: public audience "不揭露內部 SOP、規則門檻或內部
    # 推理內容") -- never derive this by truncating/reusing `reasoning`,
    # which is written for the government/internal audience and cites SOP
    # articles, thresholds and internal ops details the public must not see.
    public_message: str = ""
    # 2026-08-01: structured step-by-step trace of the judgment above (same
    # shape as agent/chat.py's ReasoningStep, so the frontend's existing
    # ReasoningChain rendering works for both). `reasoning` stays the
    # free-text government summary; this is the expandable step list. Empty
    # on the fallback path -- there's no LLM judgment trace to show, only a
    # single deterministic rule result (reasoning already says so).
    reasoning_steps: list[ReasoningStep] = field(default_factory=list)


_SYSTEM_PROMPT = (
    "你是台北市交通應變指揮系統的判定 Agent。你會收到一組已經算好的原始事實數據，"
    "以及完整的 SOP 七條條文全文。你的工作是依據 SOP 條文判斷：這個情境是否觸發某條 SOP、"
    "觸發哪一條、以及該條文要求的處置決定是什麼（例如分級、主疏散路徑、是否發布多語通報等）。\n\n"
    "規則：\n"
    "1. 所有判斷都必須明確引用 SOP 原文條款作為依據，不要臆測 SOP 沒有明文規定的規則。\n"
    "2. 不要重新計算你收到的原始數字（那些已經算好了，直接引用、不要質疑或修改）。\n"
    "3. 除了 reasoning 這段完整敘述外，也要把判斷過程拆解成 reasoningSteps 陣列，"
    "每一步是一個 {\"order\", \"status\", \"title\", \"detail\", \"sopRef\"} 物件："
    "order 從 1 遞增；status 是 \"info\"（取得輸入資料）、\"pass\"（檢核通過）、"
    "\"fail\"（候選被排除，僅路徑篩選類判斷需要）、\"final\"（最終結論）四選一；"
    "title 是這一步的簡短標題；detail 是這一步具體的數據與判斷依據；"
    "sopRef 是這一步引用的 SOP 條號字串（例如 \"SOP §2\"），沒有引用可省略。"
    "步驟數量依實際判斷複雜度而定，至少要有一步取得輸入、一步最終結論；"
    "若判斷牽涉多個候選（例如疏散路徑），每個候選各自的通過/排除都要有一步。\n"
    "4. 只能輸出一個 JSON 物件，不要有任何 JSON 以外的文字或 markdown 標記，格式：\n"
    '   {"triggered": true 或 false, "sop_section_id": "純數字字串（例如 "2"）或 null，'
    '不要加「第」「條」「SOP」「§」等文字或符號", '
    '"result": {...依情境而定的決定欄位，見指示...}, '
    '"reasoning": "繁體中文說明你的判斷依據，給交通控制中心指揮官看，'
    '需引用 SOP 條號、門檻數字與內部處置細節", '
    '"reasoningSteps": [{"order": 1, "status": "info/pass/fail/final", "title": "...", '
    '"detail": "...", "sopRef": "SOP §N（可省略）"}, ...], '
    '"public_message": "給一般民眾看的一句話繁體中文提醒，只講對民眾有用的行動建議'
    '（例如改道、預留時間、避開哪一區），絕對不能出現 SOP 條號、門檻數字、規則名稱、'
    '警力／號誌等內部調度細節；若 triggered 為 false 則留空字串"}'
)


def decide(
    facts: dict[str, Any],
    *,
    instructions: str,
    fallback: Callable[[], Decision],
    llm_client: Optional[LLMClient] = None,
) -> Decision:
    """Runs one facts-in, decision-out judgment call.

    `instructions` tells the model what this specific scenario needs decided
    (which `result` fields to fill in) -- the SOP text and general contract
    are already in the system prompt. `fallback` is invoked, and its result
    tagged source="fallback", whenever no LLM is configured, the call
    fails, or the response isn't valid JSON.
    """
    client = llm_client if llm_client is not None else get_configured_llm_client()
    if client is None:
        return fallback()

    prompt = (
        f"{FULL_SOP_TEXT}\n\n"
        f"=== 本次情境的原始事實數據 ===\n{json.dumps(facts, ensure_ascii=False, indent=2)}\n\n"
        f"=== 這次要判斷什麼 ===\n{instructions}"
    )
    try:
        # decide_accident's JSON is the heaviest case (main_route/secondary_routes/
        # multiple excluded candidates each with a reason, plus a full reasoning
        # and public_message) -- 1500 truncated mid-string on a real call
        # (2026-08-01: "Unterminated string" JSONDecodeError, silently fell
        # back to rules/ since decide()'s except-clause catches parse failures).
        # Sized for that worst case since every scope shares this one call.
        raw = client.complete(system=_SYSTEM_PROMPT, prompt=prompt, max_tokens=3000)
        parsed = _parse_json_response(raw)
        return Decision(
            triggered=bool(parsed["triggered"]),
            sop_section_id=_normalize_sop_section_id(parsed.get("sop_section_id")),
            result=parsed.get("result", {}) or {},
            reasoning=parsed.get("reasoning", ""),
            source="llm",
            public_message=parsed.get("public_message", "") or "",
            reasoning_steps=_parse_reasoning_steps(parsed.get("reasoningSteps")),
        )
    except Exception as exc:  # noqa: BLE001 - any failure here must fall back, never crash the request
        print(
            f"[agent.decision_agent] LLM decision failed, falling back to rules/: {exc}",
            file=sys.stderr,
        )
        return fallback()


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
            continue  # a malformed step is dropped, not fatal to the whole decision
    return steps


def _normalize_sop_section_id(raw: Any) -> Optional[str]:
    """sop_sections.sop_section_id is stored as a bare digit string ("2"),
    but despite the system prompt's instructions the model sometimes phrases
    it as "第2條", "SOP §2", etc. -- extract the digits so response_alerts'
    FK to sop_sections never breaks on formatting alone (see response_alerts_
    sop_section_fk in schema.sql)."""
    if raw is None:
        return None
    match = re.search(r"\d+", str(raw))
    return match.group(0) if match else None


def _parse_json_response(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    return json.loads(text)

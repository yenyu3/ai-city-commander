"""City-wide SOP triage (Phase A) + focused narrative generation (Phase C)
for decision-generator-worker's 3-phase pipeline (2026-08-01 redesign -- see
decision_routing.py's module docstring for the full picture).

Direction from the user: don't fragment context into tiny per-location LLM
calls. `route_triggers()` is handed the ENTIRE city's current state (every
segment/station, current *and* previous tick so it can see a trend, not a
single point) plus every active incident, in one shot, and decides which SOP
articles are triggered and where. Detailed reasoning/report content is
*not* produced here -- that's Phase B (agent/facts.py's existing decide_*()
functions, reused as-is, called only for whatever Phase A flagged worth
generating). `narrate_for_focus()` then blends the resulting triggered
items into one piece of text, optionally centered on a caller-supplied
focus location -- this is what lets a response say "your station's fine,
but avoid Station B, it's congested" instead of only ever answering about
one isolated location.

Same resilience contract as the rest of agent/: no LLM configured, or the
call fails/returns unparseable JSON, falls back -- `route_triggers()` takes
an explicit `fallback` callable (like decision_agent.decide()) because its
fallback needs RDS-backed data (full road network graph, full crowd
history) that this module deliberately doesn't fetch itself (agent/ stays a
pure judgment layer, given data -- see decision_routing.py for the fetching
side). `narrate_for_focus()`'s fallback needs no such data (it only
rephrases already-generated public_message strings), so it's self-contained.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .llm_client import LLMClient, get_configured_llm_client
from .sop_sections import FULL_SOP_TEXT

_KIND_BY_SOP_SECTION = {
    "1": "congestion",
    "2": "accident",
    "3": "mrt_diversion",
    "4": "dome_dispersal",
    "5": "signal_failure",
    "6": "multilingual",
}


@dataclass
class Trigger:
    sop_section_id: str
    location_id: str
    # Populated by decision_routing.py after route_triggers() returns (not
    # by the LLM/fallback here) -- see decision_routing._attach_event_ids.
    event_id: Optional[str] = None

    @property
    def kind(self) -> str:
        return _KIND_BY_SOP_SECTION.get(self.sop_section_id, "unknown")


_ROUTER_SYSTEM_PROMPT = (
    "你是台北市交通應變指揮系統的分診 Agent。你會收到全市目前所有路段、站點的"
    "即時與前一筆快照數據（用來看趨勢變化，不是只看單一時間點），以及目前所有"
    "進行中的事件，還有完整的 SOP 七條全文。\n\n"
    "你的工作只有一件事：找出目前有哪些 SOP 條款被觸發、分別在哪個地點/哪個"
    "事件。不需要在這一步生成詳細處置建議、理由或民眾訊息，那是下一階段的工作，"
    "這一步只要正確列出目前觸發清單即可（不確定的可以列出來，之後會被各自的"
    "規則再驗證一次，多列不影響正確性；但漏掉真的有觸發的比較不好，請寧可"
    "多列）。\n\n"
    "規則：\n"
    "1. 針對 segments 陣列中的每一個路段，依 SOP 第1條判斷是否觸發——"
    "每個路段已經附上 is_city_trigger_segment 布林值，直接告訴你這個路段是不是"
    "SOP 第1條認定的城市應變觸發路段，不用自己再從 SOP 文字反推；只有這個值"
    "為 true、且達 B 級以上門檻，才算觸發（其餘路段即使飽和度再高，也不算"
    "第1條觸發，只是 dashboard 顯示分級用，不用列入 triggers）。\n"
    "2. 針對 stations 陣列中的每一個站點，依 SOP 第6條判斷 roaming 是否達門檻。\n"
    "3. 針對 active_incidents 陣列中的每一個事件，同時且獨立判斷 SOP 第2條"
    "（事故/路障）與第5條（號誌故障）是否觸發——一個事件可能兩條都觸發、都不"
    "觸發，不要用事件 type 預先排除任何一條，locationId 請填該事件的"
    "affected_segment。每個事件已經附上 candidate_alternative_routes（各候選"
    "替代路線的 capacity_vph/is_direct_intersection/is_upstream/"
    "current_saturation），可以直接拿來判斷第2條是否觸發（三項觸發條件：狀態"
    "屬於封閉/阻斷/管制、severity 屬於高/危急、affected_segment 是路段），"
    "不需要在這一步就選出主/次疏散路徑，那是下一階段的工作。\n"
    "4. SOP 第3條（捷運分流）與第4條（大巨蛋散場）由程式碼另外處理，這裡不用"
    "判斷 BS_MRT_BL17 或 BS_TPE_DOME。\n"
    "5. 只能輸出一個 JSON 物件，不要有其他文字或 markdown 標記，格式：\n"
    '   {"triggers": [{"sopSectionId": "純數字字串，例如 \\"1\\"", '
    '"locationId": "路段或站點 ID"}, ...]}\n'
    '   沒有任何觸發就輸出 {"triggers": []}。不需要輸出 eventId，事件關聯由'
    "程式碼自動比對，你只要給 sopSectionId 跟 locationId。"
)


def route_triggers(
    snapshot: dict[str, Any],
    *,
    fallback: Callable[[], list[Trigger]],
    llm_client: Optional[LLMClient] = None,
) -> list[Trigger]:
    client = llm_client if llm_client is not None else get_configured_llm_client()
    if client is None:
        return fallback()

    prompt = (
        f"{FULL_SOP_TEXT}\n\n"
        f"=== 全市目前快照（含前一筆資料供趨勢比對） ===\n"
        f"{json.dumps(snapshot, ensure_ascii=False, indent=2)}"
    )
    try:
        raw = client.complete(system=_ROUTER_SYSTEM_PROMPT, prompt=prompt, max_tokens=2000)
        parsed = _parse_json_response(raw)
        return [
            Trigger(
                sop_section_id=_normalize_sop_section_id(item.get("sopSectionId")),
                location_id=item["locationId"],
            )
            for item in parsed.get("triggers", [])
            if item.get("locationId")
        ]
    except Exception as exc:  # noqa: BLE001 - any failure here must fall back, never crash the request
        print(f"[agent.router_agent] route_triggers LLM call failed, falling back: {exc}", file=sys.stderr)
        return fallback()


_NARRATIVE_SYSTEM_PROMPT = (
    "你是台北市交通應變指揮系統面向使用者的助理。你會收到目前全市所有已觸發"
    "SOP 事項的清單（每項含地點與一句給使用者看的訊息），以及使用者目前關注的"
    "地點（可能沒有）。請用繁體中文寫一段話回覆：\n"
    "- 如果有給關注地點：先講這個地點本身的狀況（沒有觸發項目就說明狀況正常），"
    "如果其他地方有觸發中的事項，可以順帶提醒使用者避開或留意，不用勉強牽拖"
    "無關的地方，但也不要完全略過。\n"
    "- 如果沒有給關注地點：對整體狀況做一段簡短總結，把目前所有觸發中的事項"
    "講清楚。\n"
    "- 完全沒有任何觸發時，用一句話說明目前一切正常即可。\n"
    "- 不要出現 SOP 條號、門檻數字、規則名稱、警力/號誌等內部調度細節（這是"
    "給一般使用者看的文字，跟政府內部版本的 reasoning 不同）。\n"
    '只能輸出一個 JSON 物件，不要有其他文字：{"text": "..."}'
)


def narrate_for_focus(
    triggered_items: list[dict[str, Any]],
    focus_location_id: Optional[str],
    focus_location_name: Optional[str],
    *,
    llm_client: Optional[LLMClient] = None,
) -> str:
    client = llm_client if llm_client is not None else get_configured_llm_client()
    if client is None:
        return _fallback_narrative(triggered_items, focus_location_id, focus_location_name)

    facts = {
        "triggeredItems": triggered_items,
        "focusLocationId": focus_location_id,
        "focusLocationName": focus_location_name,
    }
    prompt = f"=== 目前全市觸發清單 ===\n{json.dumps(facts, ensure_ascii=False, indent=2)}\n\n請依規則寫出回覆文字。"
    try:
        raw = client.complete(system=_NARRATIVE_SYSTEM_PROMPT, prompt=prompt, max_tokens=600)
        parsed = _parse_json_response(raw)
        return parsed["text"]
    except Exception as exc:  # noqa: BLE001 - any failure here must fall back, never crash the request
        print(f"[agent.router_agent] narrate_for_focus LLM call failed, falling back: {exc}", file=sys.stderr)
        return _fallback_narrative(triggered_items, focus_location_id, focus_location_name)


def _fallback_narrative(
    triggered_items: list[dict[str, Any]],
    focus_location_id: Optional[str],
    focus_location_name: Optional[str],
) -> str:
    """No LLM configured/failed -- just recombines the public_message strings
    Phase B already generated (or its own rules/ fallback wording), rather
    than inventing new prose. Same compute/generate split as the rest of
    agent/: this fallback narrates, it doesn't judge or compose from
    scratch."""
    if not triggered_items:
        if focus_location_id is None:
            return "目前一切正常，無異常事件。"
        return f"{focus_location_name or focus_location_id}目前狀況正常。"

    if focus_location_id is None:
        return " ".join(i["publicMessage"] for i in triggered_items if i.get("publicMessage"))

    own = [i for i in triggered_items if i["locationId"] == focus_location_id]
    others = [i for i in triggered_items if i["locationId"] != focus_location_id]
    parts = [
        " ".join(i["publicMessage"] for i in own if i.get("publicMessage"))
        if own
        else f"{focus_location_name or focus_location_id}目前狀況正常。"
    ]
    if others:
        other_text = " ".join(i["publicMessage"] for i in others if i.get("publicMessage"))
        if other_text:
            parts.append(f"其他地方請留意：{other_text}")
    return " ".join(p for p in parts if p)


def _normalize_sop_section_id(raw: Any) -> Optional[str]:
    import re

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

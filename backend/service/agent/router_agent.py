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
items into a `Narrative` (`.citizen` / `.government`, one caller-supplied
focus location, possibly none) -- this is what lets a response say "your
station's fine, but avoid Station B, it's congested" instead of only ever
answering about one isolated location.

2026-08-01, final design after three wrong intermediate versions (see git
history if that reasoning is ever needed, but the ONLY correct contract is
this one):

  `Narrative.citizen` / `.government` are each a `NarrativeSummary` --
  structured, not free text: `headline` (one line), `text` (a complete
  integrated account -- every triggered item's SOP citation/reasoning
  highlights, recommended actions, ETE, main/secondary reroute, signal/
  cross-agency coordination summarized IN, not a "see decisions[] for
  detail" pointer, since decisions[] is never rendered by the frontend at
  all), plus CITY-WIDE ROLLUPS of every field decisions[] carries that
  can be meaningfully aggregated (`sopRefs`, `recommendedActions`,
  `estimatedRecovery` per item, `signalCoordination`, `crossSystemCoordination`,
  `publicationEligibility`) and `prioritizedDecisionIds` (decisions[]'s
  decisionId values, focus-first ordered). Only per-item detail that CANNOT
  be meaningfully rolled up (reasoningSteps, segmentMetrics, reroute.excluded
  detail) stays exclusively in decisions[] (see
  decision_routing.decision_detail()). `government` gets every rollup;
  `citizen` gets the citizen-safe subset (no sopRefs, no signal/cross-agency
  detail -- SOP jargon and internal ops dispatch never reach a resident).

Wrong things this replaced, for the record: (1) a single blended string,
silently citizen-only -- government text never existed; (2) two blended
strings, government compressed into a one-line-per-item digest under the
wrong assumption "the real detail is already in decisions[]" -- decisions[]
is never rendered, so that made the detail invisible; (3) free text at all
for either side, even after adding structure -- the frontend needs
structured, renderable data (matching decisions[]'s shape and rollup-able
fields), not prose to dump in a paragraph; (4) treating `government`/
`citizen` as arrays mirroring decisions[] one-for-one -- they're each ONE
integrated summary object, not a parallel per-item list (decisions[] is
already the per-item list).

Same resilience contract as the rest of agent/: no LLM configured, or the
call fails/returns unparseable JSON, falls back -- `route_triggers()` takes
an explicit `fallback` callable (like decision_agent.decide()) because its
fallback needs RDS-backed data (full road network graph, full crowd
history) that this module deliberately doesn't fetch itself (agent/ stays a
pure judgment layer, given data -- see decision_routing.py for the fetching
side). `narrate_for_focus()`'s fallback needs no such data (it only
recombines already-generated structured fields from decision_detail()
output), so it's self-contained.
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .llm_client import LLMClient, get_configured_llm_client
from .sop_sections import FULL_SOP_TEXT


@dataclass
class SignalTiming:
    intersection_name: str
    adjust_pct: int
    goal: str


@dataclass
class InterAgencyAction:
    agency: str
    text: str
    icon: str  # "train" | "bus" | "shield"


@dataclass
class NarrativeSummary:
    """One audience's integrated view of the current sweep -- structured,
    not free text. `text` is a complete account (every triggered item's
    highlights woven in, not a pointer to decisions[]), plus city-wide
    rollups of decisions[]'s aggregatable fields. See module docstring for
    exactly which fields roll up here vs. stay decisions[]-only, and why
    `citizen` omits sopRefs/signalCoordination/crossSystemCoordination."""

    focus_location_id: Optional[str]
    headline: str
    text: str
    recommended_actions: list[str] = field(default_factory=list)
    estimated_recovery: list[dict[str, Any]] = field(default_factory=list)  # [{decisionId, locationId, ete}]
    prioritized_decision_ids: list[str] = field(default_factory=list)
    sop_refs: list[str] = field(default_factory=list)  # government only
    signal_coordination: list[SignalTiming] = field(default_factory=list)  # government only
    cross_system_coordination: list[InterAgencyAction] = field(default_factory=list)  # government only
    publication_eligible_location_ids: list[str] = field(default_factory=list)  # government only


@dataclass
class Narrative:
    """Two INDEPENDENT NarrativeSummary objects, not one summary with an
    internal audience switch -- citizen is what a resident's screen renders,
    government is what the command-center operator's screen renders. Never
    derive one from the other."""

    citizen: NarrativeSummary
    government: NarrativeSummary


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
    # Only ever set directly by run_incident_flow, for that incident's own
    # §2/§5/§3 triggers (the incident API entry). The decision API's city
    # sweep (_ensure_city_sweep) never sets this -- 2026-08-02: decision and
    # incident are judged completely independently, so a decision-sweep
    # trigger never gets cross-tagged with an unrelated incident's event_id
    # just because it happens to share a location.
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


_NARRATIVE_SHARED_PREAMBLE = (
    "你會收到目前全市所有已觸發 SOP 事項的完整清單（每項含 decisionId、"
    "地點、kind、SOP 條號、給指揮官看的完整判斷理由 aiText、建議行動"
    "recommendedActions、預計恢復時間 estimatedRecovery、改道路徑 reroute、"
    "給市民看的一句話 publicMessage），以及使用者目前關注的地點（可能"
    "沒有）。這份清單裡的原始資料【不會被顯示在畫面上任何其他地方】——"
    "你產生的這份結構化摘要就是使用者唯一看得到的整合內容，絕對不能只做"
    "粗略摘要、遺漏細節。\n\n"
)

_NARRATIVE_SHARED_FIELDS = (
    "必須包含：\n"
    '- "headline"：一句話結論。\n'
    '- "text"：完整整合敘述段落，把清單裡每一項的重點（觸發原因、建議'
    "行動、預計恢復時間、主要改道路徑）都融入敘述中，不是只挑一兩項講、"
    "也不是叫讀者自己去查其他地方——這段文字本身就要是完整的決策文件"
    "或完整的路況說明。\n"
    '- "recommendedActions"：陣列，把清單裡所有項目的建議行動彙整、去重'
    "後列出。\n"
    '- "estimatedRecovery"：陣列，每個有預計恢復時間的項目各一筆'
    '{"decisionId", "locationId", "ete"}。\n'
    '- "prioritizedDecisionIds"：陣列，清單裡每一項的 decisionId，依處置'
    "優先順序排列——如果有關注地點，該地點自己的項目（如果有觸發）排最"
    "前面。\n\n"
)

_NARRATIVE_SHARED_FOCUS_RULES = (
    "如果有給關注地點：headline/text 都要先講該地點本身狀況（沒有觸發就"
    "說明狀況正常，但仍要考慮其他地方是否會影響到本地點，例如疏散路徑"
    "引導人流過來），再帶到其他觸發中地點；prioritizedDecisionIds 該地點"
    "自己的項目排最前面。\n"
    "如果沒有關注地點：對全市所有觸發項目做完整整合。\n"
)

_CITIZEN_NARRATIVE_SYSTEM_PROMPT = (
    "你是台北市交通應變指揮系統的市民版路況摘要產生器。" + _NARRATIVE_SHARED_PREAMBLE +
    "只能輸出一個 JSON 物件，格式：\n"
    '{"headline": "...", "text": "...", "recommendedActions": [...], '
    '"estimatedRecovery": [...], "prioritizedDecisionIds": [...]}\n\n' +
    _NARRATIVE_SHARED_FIELDS +
    "絕對不能出現 SOP 條號、門檻數字（飽和度/成長率等）、規則名稱、警力"
    "或號誌調度等內部術語。text 要用聊天口吻寫，像在跟朋友說「欸那邊"
    "塞車喔，走OO比較快」，不是公文、不是新聞稿，不要出現「請」「敬請」"
    "「特此」「茲」「本系統」「指揮官」這類公文詞，也不要用「請留意」"
    "「請避開」開頭——直接講重點、講人話，但一樣要完整涵蓋每個觸發項目"
    "的狀況，不能為了口語化而遺漏地點。\n\n" +
    _NARRATIVE_SHARED_FOCUS_RULES +
    "完全沒有任何觸發時：用一句話說明目前一切正常，其餘欄位皆為空陣列。"
)

_GOVERNMENT_NARRATIVE_SYSTEM_PROMPT = (
    "你是台北市交通應變指揮系統的指揮官版整合摘要產生器。" + _NARRATIVE_SHARED_PREAMBLE +
    "只能輸出一個 JSON 物件，格式：\n"
    '{"headline": "...", "text": "...", "recommendedActions": [...], '
    '"estimatedRecovery": [...], "prioritizedDecisionIds": [...], '
    '"sopRefs": [...], "signalCoordination": [...], '
    '"crossSystemCoordination": [...], "publicationEligibleLocationIds": [...]}\n\n' +
    _NARRATIVE_SHARED_FIELDS +
    "額外包含：\n"
    '- "sopRefs"：陣列，清單中出現過的所有 SOP 條號，去重。\n'
    '- "signalCoordination"：陣列，依 SOP 條文中提及號誌配時調整的項目'
    '（如第1條「長綠燈時制」、第2條主疏散路徑壅塞時），各生成'
    '{"intersectionName", "adjustPct", "goal"}，intersectionName 用該'
    "項目地點名稱或路口描述，adjustPct 依 SOP 條文（一般為 25），goal 簡述"
    "調整目的。沒有相關項目就輸出空陣列。\n"
    '- "crossSystemCoordination"：陣列，依 SOP 條文中提及跨機關協調的項目'
    "（第1/2條的警力調度、第3/4條的北捷/公車處接駁、第5條的警力人工指揮），"
    '各生成 {"agency", "text", "icon"}（icon 為 "train"/"bus"/"shield" 三選'
    "一），同機關的多個請求可合併成一項。沒有相關項目就輸出空陣列。\n"
    '- "publicationEligibleLocationIds"：陣列，清單中 kind 為'
    '"multilingual" 且已觸發之項目的 locationId。沒有就輸出空陣列。\n\n' +
    _NARRATIVE_SHARED_FOCUS_RULES +
    "完全沒有任何觸發時：headline/text 簡短回報「目前無需處置事項」，"
    "其餘欄位皆為空陣列。"
)


def narrate_for_focus(
    triggered_items: list[dict[str, Any]],
    focus_location_id: Optional[str],
    focus_location_name: Optional[str],
    *,
    llm_client: Optional[LLMClient] = None,
) -> Narrative:
    client = llm_client if llm_client is not None else get_configured_llm_client()
    if client is None:
        return _fallback_narrative(triggered_items, focus_location_id, focus_location_name)

    facts = {
        "triggeredItems": triggered_items,
        "focusLocationId": focus_location_id,
        "focusLocationName": focus_location_name,
    }
    prompt = f"=== 目前全市觸發清單 ===\n{json.dumps(facts, ensure_ascii=False, indent=2)}\n\n請依規則輸出一份結構化摘要。"

    # 2026-08-02: citizen/government used to be one combined call producing
    # both objects in a single JSON response -- government's content (every
    # triggered item's SOP reasoning/actions/ETE/reroute woven in full, plus
    # the rollup arrays) is far heavier than citizen's, so that single call's
    # wall-clock time scaled with the SUM of both objects' output tokens. A
    # real decision_latency run showed sweeps with 9-14 simultaneous
    # triggers taking 80-210s, well past the 60s replan budget. Splitting
    # into two independent calls run in parallel means wall-clock is bounded
    # by the SLOWER of the two (government, which needed its 8000-token
    # ceiling regardless) instead of their sum -- citizen's generation no
    # longer serializes after government's in the same output stream.
    def _citizen() -> NarrativeSummary:
        try:
            raw = client.complete(system=_CITIZEN_NARRATIVE_SYSTEM_PROMPT, prompt=prompt, max_tokens=3000)
            return _parse_summary(_parse_json_response(raw), focus_location_id, government=False)
        except Exception as exc:  # noqa: BLE001 - any failure here must fall back, never crash the request
            print(f"[agent.router_agent] narrate_for_focus (citizen) LLM call failed, falling back: {exc}", file=sys.stderr)
            return _fallback_narrative(triggered_items, focus_location_id, focus_location_name).citizen

    def _government() -> NarrativeSummary:
        try:
            raw = client.complete(system=_GOVERNMENT_NARRATIVE_SYSTEM_PROMPT, prompt=prompt, max_tokens=8000)
            return _parse_summary(_parse_json_response(raw), focus_location_id, government=True)
        except Exception as exc:  # noqa: BLE001 - any failure here must fall back, never crash the request
            print(f"[agent.router_agent] narrate_for_focus (government) LLM call failed, falling back: {exc}", file=sys.stderr)
            return _fallback_narrative(triggered_items, focus_location_id, focus_location_name).government

    with ThreadPoolExecutor(max_workers=2) as pool:
        citizen_future = pool.submit(_citizen)
        government_future = pool.submit(_government)
        citizen = citizen_future.result()
        government = government_future.result()

    return Narrative(citizen=citizen, government=government)


def _parse_summary(raw: dict[str, Any], focus_location_id: Optional[str], *, government: bool) -> NarrativeSummary:
    summary = NarrativeSummary(
        focus_location_id=focus_location_id,
        headline=raw["headline"],
        text=raw["text"],
        recommended_actions=raw.get("recommendedActions") or [],
        estimated_recovery=raw.get("estimatedRecovery") or [],
        prioritized_decision_ids=raw.get("prioritizedDecisionIds") or [],
    )
    if government:
        summary.sop_refs = raw.get("sopRefs") or []
        summary.signal_coordination = [
            SignalTiming(
                intersection_name=t["intersectionName"], adjust_pct=int(t["adjustPct"]), goal=t["goal"]
            )
            for t in (raw.get("signalCoordination") or [])
        ]
        summary.cross_system_coordination = [
            InterAgencyAction(agency=a["agency"], text=a["text"], icon=a["icon"])
            for a in (raw.get("crossSystemCoordination") or [])
        ]
        summary.publication_eligible_location_ids = raw.get("publicationEligibleLocationIds") or []
    return summary


def _fallback_narrative(
    triggered_items: list[dict[str, Any]],
    focus_location_id: Optional[str],
    focus_location_name: Optional[str],
) -> Narrative:
    """No LLM configured/failed -- just recombines the structured fields
    Phase B already generated (or its own rules/ fallback wording), rather
    than inventing new prose. Same compute/generate split as the rest of
    agent/: this fallback narrates, it doesn't judge or compose from
    scratch. Rollup fields (recommendedActions/estimatedRecovery/sopRefs/
    signalCoordination/crossSystemCoordination/publicationEligibleLocationIds)
    are recombined here too, same as the LLM path -- decisions[] is never
    rendered by the frontend (see decision_routing.decision_detail()'s
    docstring), so this is the only place that detail reaches a viewer,
    LLM-configured or not."""
    ordered = sorted(triggered_items, key=lambda i: i["locationId"] != focus_location_id)
    decision_ids = [i["decisionId"] for i in ordered if i.get("decisionId")]

    if not triggered_items:
        name = focus_location_name or focus_location_id
        citizen_headline = "現在很順，免驚。" if focus_location_id is None else f"{name}現在很順。"
        government_headline = "目前無需處置事項。"
        return Narrative(
            citizen=NarrativeSummary(focus_location_id, citizen_headline, citizen_headline),
            government=NarrativeSummary(focus_location_id, government_headline, government_headline),
        )

    def join(field_name: str, items: list[dict[str, Any]]) -> str:
        return " ".join(i[field_name] for i in items if i.get(field_name))

    def government_block(item: dict[str, Any]) -> str:
        parts = [f"【{item.get('locationId')}｜{'/'.join(item.get('sopRefs') or [])}】{item.get('aiText', '')}"]
        actions = item.get("recommendedActions") or []
        if actions:
            parts.append("建議行動：" + "；".join(actions))
        recovery = item.get("estimatedRecovery")
        if recovery is not None:
            parts.append(f"預計恢復時間：{recovery['ete']} 分鐘")
        reroute = item.get("reroute")
        if reroute:
            main_route = reroute.get("mainRoute")
            if main_route:
                parts.append(f"主疏散路徑：{main_route}")
            secondary = reroute.get("secondaryRoutes") or []
            if secondary:
                parts.append(f"次要疏散路徑：{'、'.join(secondary)}")
        return "。".join(parts)

    citizen_text = join("publicMessage", ordered)
    government_text = " ".join(government_block(i) for i in ordered)

    all_actions: list[str] = []
    for i in ordered:
        for a in i.get("recommendedActions") or []:
            if a not in all_actions:
                all_actions.append(a)

    estimated_recovery = [
        {"decisionId": i.get("decisionId"), "locationId": i["locationId"], "ete": i["estimatedRecovery"]["ete"]}
        for i in ordered
        if i.get("estimatedRecovery") is not None
    ]

    sop_refs: list[str] = []
    for i in ordered:
        for ref in i.get("sopRefs") or []:
            if ref not in sop_refs:
                sop_refs.append(ref)

    publication_eligible = [i["locationId"] for i in ordered if i.get("kind") == "multilingual"]

    citizen_headline = citizen_text.split("。")[0] + "。" if citizen_text else "目前狀況如下。"
    government_headline = f"共 {len(ordered)} 項觸發中事項。"

    return Narrative(
        citizen=NarrativeSummary(
            focus_location_id=focus_location_id,
            headline=citizen_headline,
            text=citizen_text,
            recommended_actions=all_actions,
            estimated_recovery=estimated_recovery,
            prioritized_decision_ids=decision_ids,
        ),
        government=NarrativeSummary(
            focus_location_id=focus_location_id,
            headline=government_headline,
            text=government_text,
            recommended_actions=all_actions,
            estimated_recovery=estimated_recovery,
            prioritized_decision_ids=decision_ids,
            sop_refs=sop_refs,
            publication_eligible_location_ids=publication_eligible,
            # signalCoordination/crossSystemCoordination need SOP-article-
            # specific judgment (which article implies which intersection/
            # agency action) -- the fallback path deliberately doesn't
            # duplicate that judgment in Python; it stays empty here and is
            # only ever populated by the real LLM call above.
        ),
    )


def _normalize_sop_section_id(raw: Any) -> Optional[str]:
    import re

    if raw is None:
        return None
    match = re.search(r"\d+", str(raw))
    return match.group(0) if match else None


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
        # inside string values -- caught live on the deployed chat Lambda
        # (agent/chat.py hit the exact same failure): a long text field
        # containing an actual newline instead of an escaped "\n" makes
        # json.loads()'s default strict mode reject the whole response
        # ("Expecting property name enclosed in double quotes"), even
        # though the content itself was fine. narrate_for_focus's text
        # fields are exactly this kind of long free-form content.
        return json.loads(text, strict=False)
    except json.JSONDecodeError:
        # narrate_for_focus's governmentText is long-form (up to 8000
        # tokens, every triggered item spelled out in full) -- caught live
        # against a real Bedrock call producing a trailing comma before a
        # closing brace, a common long-JSON-output slip that isn't a real
        # content problem, just strict json.loads() rejecting otherwise-valid
        # content. One retry with trailing commas stripped before giving up
        # and falling back (which would silently discard this whole
        # response, per narrate_for_focus's docstring on why that's costly).
        return json.loads(re.sub(r",(\s*[}\]])", r"\1", text), strict=False)

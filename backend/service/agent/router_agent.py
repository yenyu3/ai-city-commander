"""Focused narrative generation (Phase C) for decision-generator-worker's
3-phase pipeline (2026-08-01 redesign -- see decision_routing.py's module
docstring for the full picture).

2026-08-02: this module used to also hold Phase A (`route_triggers()`, a
router LLM call that triaged the entire city's snapshot into a trigger
list). Removed -- see decision_routing.py's module docstring for why:
§1/§6 candidacy turned out to be pure SOP-threshold arithmetic the model
was just being asked to re-echo, and doing that as one big enumeration
over dozens of candidates was measurably losing recall on busy ticks
(eval/router_precision_recall.py caught it at 0.44 recall / 1.0 precision
-- the model wasn't guessing wrong, it was under-listing). Phase A is now
`decision_routing._deterministic_city_sweep`, plain Python.

`narrate_for_focus()` blends the currently-triggered items (however Phase A
found them) into a `Narrative` (`.citizen` / `.government`, one
caller-supplied focus location, possibly none) -- this is what lets a
response say "your station's fine, but avoid Station B, it's congested"
instead of only ever answering about one isolated location.

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
call fails/returns unparseable JSON, falls back. `narrate_for_focus()`'s
fallback needs no RDS-backed data (it only recombines already-generated
structured fields from decision_detail() output), so it's self-contained.
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Optional

from .llm_client import LLMClient, get_configured_llm_client


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
class RoutingVariant:
    """One weighted citizen-facing message recommending a single reroute
    candidate -- see narrate_for_focus()'s docstring on why this exists:
    telling every resident the SAME "best" route just moves the jam onto
    that route. `weight` is a deterministic probability (computed from
    real capacity_vph/current_saturation in decision_routing.decision_
    detail()'s reroute.viableRoutes -- see agent/facts.py::decide_accident()
    -- never LLM-invented), meant for a caller to seed-select ONE variant
    per device so the same device sees the same recommendation across
    reloads while the population as a whole spreads across every viable
    route roughly proportional to its remaining capacity. Citizen only --
    government needs the full mainRoute/secondaryRoutes picture, not one
    randomly-assigned option."""

    segment_id: str
    text: str
    weight: float


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
    # citizen only -- see RoutingVariant. Additive: empty unless there's an
    # accident-kind item with 2+ viable reroute candidates worth splitting
    # citizens across (see narrate_for_focus). headline/text above are
    # UNCHANGED by this field's presence -- existing frontend consumers
    # that don't know about it see exactly the same summary they always did.
    routing_variants: list[RoutingVariant] = field(default_factory=list)


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


def _compute_routing_weights(viable_routes: list[dict[str, Any]]) -> dict[str, float]:
    """Deterministic crowd-split weight per reroute candidate -- NOT an LLM
    judgment (see RoutingVariant's docstring on why: recommending the same
    single "best" route to every citizen just relocates the jam onto that
    route). remaining_capacity = capacityVph * (1 - currentSaturation) --
    how much more traffic a route can absorb before it saturates too --
    normalized into a probability. All-saturated candidates fall back to a
    small floor (0.01) each rather than dividing by zero, so the split
    degrades to roughly uniform instead of breaking."""
    remaining = {
        r["segmentId"]: max((r.get("capacityVph") or 0.0) * (1 - (r.get("currentSaturation") or 0.0)), 0.01)
        for r in viable_routes
    }
    total = sum(remaining.values())
    return {segment_id: value / total for segment_id, value in remaining.items()}


_ROUTING_VARIANT_SYSTEM_PROMPT = (
    "你是台北市交通應變指揮系統的市民版分流訊息產生器。你會收到一個事故的"
    "多個可行疏散路徑候選，每個都已經算好一個機率權重（依剩餘道路容量算出，"
    "不是你要判斷或修改的東西，直接使用）。\n\n"
    "為每個候選各自產生一句口語化的市民版建議訊息，語氣跟平常的市民版摘要"
    "一致——像在跟朋友說「欸那邊塞車喔，走OO比較快」，不是公文、不要出現"
    "「請」「敬請」「本系統」這類公文詞。每個訊息各自獨立完整、只推薦自己"
    "那個候選路徑，不要互相比較或提到其他候選（因為每個使用者只會看到"
    "其中一則，依權重隨機分配到，不知道還有其他版本存在）。\n\n"
    "只能輸出一個 JSON 物件，格式：\n"
    '{"variants": [{"segmentId": "...", "text": "..."}, ...]}\n'
    "segmentId 要跟輸入的候選一一對應，每個候選都要有一則訊息，不要遺漏。"
)


def _deterministic_routing_variants(triggered_items: list[dict[str, Any]]) -> list[RoutingVariant]:
    """No-LLM-configured path for narrate_for_focus's routing-variant split
    -- weights are already deterministic (_compute_routing_weights), so the
    only thing this substitutes for is the LLM-written per-variant text,
    using the same template _routing_variant_texts falls back to per-item
    on a real LLM failure."""
    variants: list[RoutingVariant] = []
    for item in triggered_items:
        if item.get("kind") != "accident":
            continue
        viable_routes = (item.get("reroute") or {}).get("viableRoutes") or []
        if len(viable_routes) < 2:
            continue
        weights = _compute_routing_weights(viable_routes)
        location = item.get("title") or "事故路段"
        variants += [
            RoutingVariant(
                segment_id=r["segmentId"],
                text=f"{location}封閉中，建議改道經{r['name']}通行，並多預留通勤時間。",
                weight=weights[r["segmentId"]],
            )
            for r in viable_routes
        ]
    return variants


def _routing_variant_texts(
    client: LLMClient, item: dict[str, Any], viable_routes: list[dict[str, Any]], weights: dict[str, float]
) -> list[RoutingVariant]:
    def fallback_text(route: dict[str, Any]) -> str:
        location = item.get("title") or "事故路段"
        return f"{location}封閉中，建議改道經{route['name']}通行，並多預留通勤時間。"

    try:
        facts = {
            "incidentLocation": item.get("title"),
            "candidates": [
                {"segmentId": r["segmentId"], "name": r["name"], "weight": round(weights[r["segmentId"]], 3)}
                for r in viable_routes
            ],
        }
        prompt = f"=== 事故與候選路徑 ===\n{json.dumps(facts, ensure_ascii=False, indent=2)}\n\n請為每個候選各自產生一則市民版訊息。"
        raw = client.complete(system=_ROUTING_VARIANT_SYSTEM_PROMPT, prompt=prompt, max_tokens=1500)
        parsed = _parse_json_response(raw)
        texts_by_id = {v["segmentId"]: v["text"] for v in parsed.get("variants", []) if v.get("segmentId")}
        return [
            RoutingVariant(
                segment_id=r["segmentId"],
                text=texts_by_id.get(r["segmentId"]) or fallback_text(r),
                weight=weights[r["segmentId"]],
            )
            for r in viable_routes
        ]
    except Exception as exc:  # noqa: BLE001 - any failure here must fall back, never crash the request
        print(f"[agent.router_agent] narrate_for_focus (routing variants) LLM call failed, falling back: {exc}", file=sys.stderr)
        return [
            RoutingVariant(segment_id=r["segmentId"], text=fallback_text(r), weight=weights[r["segmentId"]])
            for r in viable_routes
        ]


def narrate_for_focus(
    triggered_items: list[dict[str, Any]],
    focus_location_id: Optional[str],
    focus_location_name: Optional[str],
    *,
    llm_client: Optional[LLMClient] = None,
) -> Narrative:
    client = llm_client if llm_client is not None else get_configured_llm_client()
    if client is None:
        narrative = _fallback_narrative(triggered_items, focus_location_id, focus_location_name)
        narrative.citizen.routing_variants = _deterministic_routing_variants(triggered_items)
        return narrative

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

    # Accident items with 2+ viable reroute candidates get a routing-variant
    # split (see RoutingVariant/_compute_routing_weights) -- one extra
    # parallel LLM call per such item, alongside citizen/government. Most
    # sweeps/incidents have zero of these (no accident, or only one viable
    # route with nothing to split), so this adds no cost in the common case.
    variant_jobs = [
        (item, item["reroute"]["viableRoutes"])
        for item in triggered_items
        if item.get("kind") == "accident" and len((item.get("reroute") or {}).get("viableRoutes") or []) >= 2
    ]

    def _variants_for(item: dict[str, Any], viable_routes: list[dict[str, Any]]):
        def run() -> list[RoutingVariant]:
            return _routing_variant_texts(client, item, viable_routes, _compute_routing_weights(viable_routes))
        return run

    with ThreadPoolExecutor(max_workers=2 + len(variant_jobs)) as pool:
        citizen_future = pool.submit(_citizen)
        government_future = pool.submit(_government)
        variant_futures = [pool.submit(_variants_for(item, routes)) for item, routes in variant_jobs]
        citizen = citizen_future.result()
        government = government_future.result()
        for future in variant_futures:
            citizen.routing_variants += future.result()

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
        pass
    try:
        # narrate_for_focus's governmentText is long-form (up to 8000
        # tokens, every triggered item spelled out in full) -- caught live
        # against a real Bedrock call producing a trailing comma before a
        # closing brace, a common long-JSON-output slip that isn't a real
        # content problem, just strict json.loads() rejecting otherwise-valid
        # content. One retry with trailing commas stripped before giving up
        # and falling back (which would silently discard this whole
        # response, per narrate_for_focus's docstring on why that's costly).
        return json.loads(re.sub(r",(\s*[}\]])", r"\1", text), strict=False)
    except json.JSONDecodeError:
        # "Extra data" -- a real Bedrock call returned a complete, valid
        # JSON object followed by stray trailing content. json.loads()
        # requires the ENTIRE string to be exactly one JSON document;
        # raw_decode() instead parses just the first complete value and
        # ignores whatever follows.
        obj, _end = json.JSONDecoder(strict=False).raw_decode(text)
        return obj

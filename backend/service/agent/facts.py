"""Per-scenario fact assembly + LLM decision calls.

Each `decide_*` function here does two things only: (1) build a dict of raw,
unclassified facts -- numeric values and structural properties (like
capacity/intersection membership) that require no judgment to compute -- and
(2) hand them to decision_agent.decide() along with instructions for what
this scenario needs decided. The actual classification/trigger/selection
judgment happens inside the LLM call, not here.

rules/*.py's deterministic functions are only used as each `decide_*`
function's `fallback` -- the safety net for when no LLM is configured or the
call fails. They are not called on the normal/primary path.
"""
from __future__ import annotations

from typing import Any, Optional

from rules import accident_response as _rules_accident
from rules import congestion_tier as _rules_congestion
from rules import dome_dispersal as _rules_dome
from rules import mrt_diversion as _rules_mrt
from rules import multilingual_check as _rules_multilingual
from rules import signal_failure as _rules_signal
from rules.ete import calc_ete
from rules.types import CrowdSnapshot, LiveIncident, RoadSegment

from .decision_agent import Decision, decide
from .llm_client import LLMClient


def decide_congestion(
    segment_id: str,
    segment_name: str,
    saturation_score: float,
    *,
    llm_client: Optional[LLMClient] = None,
) -> Decision:
    facts = {
        "segment_id": segment_id,
        "segment_name": segment_name,
        "saturation_score": saturation_score,
        "is_city_trigger_segment": segment_id in _rules_congestion.CITY_TRIGGER_SEGMENTS,
    }

    def fallback() -> Decision:
        tier = _rules_congestion.get_tier(saturation_score)
        city = _rules_congestion.check_city_response(segment_id, tier)
        return Decision(
            triggered=city is not None,
            sop_section_id="1" if city is not None else None,
            result={"tier": tier, "actions": city.actions if city is not None else []},
            reasoning="(fallback：無可用 LLM，依 SOP 第1條門檻值以確定性規則計算)",
            source="fallback",
            public_message=(
                f"{segment_name}周邊車流壅塞，建議改道通行或提前規劃行程。" if city is not None else ""
            ),
        )

    return decide(
        facts,
        instructions=(
            "依 SOP 第1條判斷：這個路段的飽和度屬於 Normal / B / A 哪一級？"
            "若是城市觸發路段（RD_TPE_001 或 RD_TPE_002）且達 B 級以上，"
            "應該啟動哪些處置動作？"
            'result 欄位請包含 "tier"（"Normal"/"B"/"A"）與 "actions"（字串陣列）。'
        ),
        fallback=fallback,
        llm_client=llm_client,
    )


def build_accident_candidates(
    incident: LiveIncident, segments: dict[str, RoadSegment], saturation: dict[str, float]
) -> list[dict[str, Any]]:
    """The structural facts about an incident's candidate alternative routes
    (capacity/direct-intersection/upstream/current saturation) -- shared by
    decide_accident()'s own prompt and, since building this costs nothing
    beyond data already on hand (no extra LLM/DB call), by
    decision_routing.py's Phase A router snapshot too, so the router can
    reason about accident candidates with real structural facts instead of
    just an incident's bare fields."""
    incident_seg = segments.get(incident.affected_segment)
    if incident_seg is None:
        return []
    candidates: list[dict[str, Any]] = []
    for alt_id in incident_seg.alternatives:
        alt = segments.get(alt_id)
        if alt is None:
            continue
        is_direct = alt_id in incident_seg.intersection_ids
        candidates.append(
            {
                "segment_id": alt_id,
                "name": alt.name,
                "capacity_vph": alt.capacity_vph,
                "is_direct_intersection": is_direct,
                "is_upstream": (
                    _rules_accident.is_upstream(alt_id, incident_seg, incident.location)
                    if is_direct
                    else None
                ),
                "current_saturation": saturation.get(alt_id),
            }
        )
    return candidates


def decide_accident(
    incident: LiveIncident,
    segments: dict[str, RoadSegment],
    saturation: dict[str, float],
    *,
    llm_client: Optional[LLMClient] = None,
) -> Decision:
    candidates = build_accident_candidates(incident, segments, saturation)
    incident_seg = segments.get(incident.affected_segment)

    facts = {
        "incident": {
            "event_id": incident.event_id,
            "type": incident.type,
            "location": incident.location,
            "affected_segment": incident.affected_segment,
            "status": incident.status,
            "severity": incident.severity,
            "description": incident.description,
        },
        "candidate_alternative_routes": candidates,
    }

    def fallback() -> Decision:
        triggered = _rules_accident.is_accident_trigger(incident)
        if not triggered or incident_seg is None:
            return Decision(
                triggered=triggered,
                sop_section_id="2" if triggered else None,
                result={},
                reasoning="(fallback：無可用 LLM，依 SOP 第2條規則計算)",
                source="fallback",
                public_message=(
                    f"{incident.location}路段封閉中，請改道通行並多預留通勤時間。" if triggered else ""
                ),
            )
        route = _rules_accident.select_evacuation_route(
            incident.affected_segment, incident.location, segments, saturation
        )
        alt_seg = segments.get(route.main_route) if route.main_route else None
        detour_text = f"，建議改道經{alt_seg.name}通行" if alt_seg is not None else "，請改道通行"
        return Decision(
            triggered=True,
            sop_section_id="2",
            result={
                "main_route": route.main_route,
                "secondary_routes": route.secondary_routes,
                "excluded": [
                    {"segment_id": e.segment_id, "reason": e.reason} for e in route.excluded
                ],
                "congestion_warning": route.congestion_warning,
                "recommend_public_transit": route.recommend_public_transit,
            },
            reasoning="(fallback：無可用 LLM，依 SOP 第2條規則計算)",
            source="fallback",
            public_message=f"{incident.location}路段封閉中{detour_text}，並多預留通勤時間。",
        )

    decision = decide(
        facts,
        instructions=(
            "依 SOP 第2條判斷：這是否為車禍/路障應變事件（三項觸發條件都要檢查）？"
            "若是，從 candidate_alternative_routes 中選出主疏散路徑"
            "（同時考量 capacity_vph、is_direct_intersection、is_upstream、current_saturation，"
            "依 SOP 條文的篩選與排序規則），並列出次要疏散路徑，以及被排除的候選及各自理由。\n"
            'result 請包含 "main_route"（segment_id 或 null）、"secondary_routes"（陣列）、'
            '"excluded"（陣列，每項含 segment_id 與 reason）、'
            '"congestion_warning"（布林）、"recommend_public_transit"（布林）。'
        ),
        fallback=fallback,
        llm_client=llm_client,
    )

    # SOP §7's ETE formula is pure arithmetic, not a judgment (see
    # feedback-agent-architecture-compute-vs-generate) -- computed the same
    # way regardless of whether the route decision above came from the LLM
    # or the fallback, and merged in here so callers (incl. the frontend)
    # never need their own copy of this formula either.
    if decision.triggered:
        main_route = decision.result.get("main_route")
        incident_saturation = saturation.get(incident.affected_segment, 0.0)
        main_saturation = (
            saturation.get(main_route, incident_saturation) if main_route else incident_saturation
        )
        avg_saturation = (
            (incident_saturation + main_saturation) / 2 if main_route else incident_saturation
        )
        ete_result = calc_ete(incident.severity, avg_saturation)
        decision.result = {
            **decision.result,
            "ete": ete_result.ete,
            "ete_base": ete_result.base,
            "ete_penalty": ete_result.penalty,
            "ete_breakdown": ete_result.breakdown,
        }

    return decision


def decide_mrt_diversion(
    snapshot: CrowdSnapshot, *, llm_client: Optional[LLMClient] = None
) -> Decision:
    facts = {
        "station_id": snapshot.station_id,
        "location_name": snapshot.location_name,
        "user_count": snapshot.user_count,
        "growth_rate": snapshot.growth_rate,
    }

    def fallback() -> Decision:
        triggered = _rules_mrt.check_mrt_diversion(snapshot)
        return Decision(
            triggered=triggered,
            sop_section_id="3" if triggered else None,
            result={},
            reasoning="(fallback：無可用 LLM，依 SOP 第3條規則計算)",
            source="fallback",
            public_message=(
                f"{snapshot.location_name}人潮較多，列車可能過站不停，建議改往鄰近站點或搭乘接駁車。"
                if triggered
                else ""
            ),
        )

    return decide(
        facts,
        instructions="依 SOP 第3條判斷：是否應觸發捷運過站不停與接駁分流？",
        fallback=fallback,
        llm_client=llm_client,
    )


def decide_dome_dispersal(
    history: list[CrowdSnapshot], current: CrowdSnapshot, *, llm_client: Optional[LLMClient] = None
) -> Decision:
    historical_peak = max([0] + [d.user_count for d in history])
    facts = {
        "historical_peak_user_count": historical_peak,
        "current_growth_rate": current.growth_rate,
        "current_user_count": current.user_count,
    }

    def fallback() -> Decision:
        triggered = _rules_dome.check_dome_dispersal(history, current)
        return Decision(
            triggered=triggered,
            sop_section_id="4" if triggered else None,
            result={},
            reasoning="(fallback：無可用 LLM，依 SOP 第4條規則計算)",
            source="fallback",
            public_message=(
                "場館周邊人潮增加，建議提前規劃離場動線，或稍後再離開。" if triggered else ""
            ),
        )

    return decide(
        facts,
        instructions="依 SOP 第4條判斷：是否應標記「散場啟動」並連動接駁機制？",
        fallback=fallback,
        llm_client=llm_client,
    )


def decide_signal_failure(
    incident: LiveIncident, *, llm_client: Optional[LLMClient] = None
) -> Decision:
    facts = {
        "type": incident.type,
        "description": incident.description,
        "affected_segment": incident.affected_segment,
    }

    def fallback() -> Decision:
        triggered = _rules_signal.check_signal_failure(incident)
        return Decision(
            triggered=triggered,
            sop_section_id="5" if triggered else None,
            result={},
            reasoning="(fallback：無可用 LLM，依 SOP 第5條規則計算)",
            source="fallback",
            public_message=(
                "號誌故障中，請依現場人員指揮通行，行經時多加留意。" if triggered else ""
            ),
        )

    return decide(
        facts,
        instructions="依 SOP 第5條判斷：是否為號誌故障事件，需要產出人工指揮派遣建議？",
        fallback=fallback,
        llm_client=llm_client,
    )


def decide_multilingual(
    stations: list[CrowdSnapshot], *, llm_client: Optional[LLMClient] = None
) -> Decision:
    facts = {
        "stations": [
            {
                "station_id": s.station_id,
                "location_name": s.location_name,
                "roaming_pct": s.roaming_pct,
            }
            for s in stations
        ]
    }

    def fallback() -> Decision:
        matched = _rules_multilingual.check_multilingual_needed(stations)
        return Decision(
            triggered=len(matched) > 0,
            sop_section_id="6" if matched else None,
            result={"stations": [s.station_id for s in matched]},
            reasoning="(fallback：無可用 LLM，依 SOP 第6條規則計算)",
            source="fallback",
            public_message=(
                "此區域已提供中英日韓多語言資訊播報，如需協助請洽現場工作人員。" if matched else ""
            ),
        )

    return decide(
        facts,
        instructions=(
            "依 SOP 第6條判斷：哪些基地台的漫遊用戶佔比達到需要發布多語通報的程度？"
            'result 請包含 "stations"（觸發門檻的 station_id 字串陣列）。'
        ),
        fallback=fallback,
        llm_client=llm_client,
    )

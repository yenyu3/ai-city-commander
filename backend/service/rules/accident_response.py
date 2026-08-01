"""SOP Article 2: accident / roadblock evacuation routing.

Ported from frontend/src/engine/accidentResponse.ts. One deliberate change
from that reference implementation: `RoadSegment.intersection_ids` here keeps
a `None` placeholder for names that don't resolve to a tracked segment (e.g.
正氣橋, see data/unmatched_intersection_names.json) instead of dropping them.
The frontend's loader filters unresolved names out of `intersectionIds`,
which silently shifts every later index relative to the (unfiltered)
`intersections` name array that `_find_incident_insertion_index` reads from --
that mismatch can flip an upstream/downstream classification whenever an
unresolved name sits before the incident's anchor point. Keeping the arrays
parallel (matching schema.sql's nullable `intersecting_segment_id` design)
avoids that.
"""
from __future__ import annotations

import re
from typing import Optional

from .types import EvacuationRouteResult, ExcludedCandidate, LiveIncident, RoadSegment

_STATUS_TRIGGER = {"Closed", "Blocked", "Restricted"}
_SEVERITY_TRIGGER = {"High", "Critical"}

_SUFFIX_PATTERN = re.compile(r"[一二三四五六七八九十]段$")
_FORWARD_PATTERN = re.compile("南下|東行")
_BACKWARD_PATTERN = re.compile("北上|西行")
_AFTER_PATTERN = re.compile("南側|東側|以南|以東")
_BEFORE_PATTERN = re.compile("北側|西側|以北|以西")


def is_accident_trigger(incident: LiveIncident) -> bool:
    """Trigger conditions (SOP §2): all three must hold.

    Deliberately checks only affected_segment's RD_ prefix -- affected_road is
    just a related field and must NOT be used to decide whether this rule
    applies (see the crowd-surge boundary case in ruleEngine.test.ts).
    """
    status_ok = incident.status in _STATUS_TRIGGER
    severity_ok = incident.severity in _SEVERITY_TRIGGER
    is_road = incident.affected_segment.startswith("RD_")
    return status_ok and severity_ok and is_road


def _is_travel_forward(flow_direction: str) -> bool:
    """Whether the `intersections` array order equals the direction of travel.

    Explicit assumption (SOP §2 note): `intersections` is already ordered
    north->south / west->east in the source JSON. If the description
    mentions 南下/東行 (southbound/eastbound), array order == direction of
    travel; if 北上/西行 (northbound/westbound), it's reversed. Default: array
    order == direction of travel.
    """
    if _FORWARD_PATTERN.search(flow_direction):
        return True
    if _BACKWARD_PATTERN.search(flow_direction):
        return False
    return True


def _find_incident_insertion_index(
    intersection_names: list[str], incident_location_hint: str
) -> float:
    """Locate where the incident sits within the ordered intersections array.

    May be a half-integer, meaning "between these two intersections". E.g.
    "光復南路與忠孝東路口南側" matches 忠孝東路四段's index, and because it's
    on the "south side" (= further along the array, since north->south
    arrays are ordered north-first), the insertion point is index + 0.5.
    """
    ref_index = -1
    for i, name in enumerate(intersection_names):
        # A name may be "忠孝東路四段" while the incident description only
        # says "忠孝東路" -- match on either the full or the shortened name.
        short_name = _SUFFIX_PATTERN.sub("", name)
        if name in incident_location_hint or short_name in incident_location_hint:
            ref_index = i
            break
    if ref_index == -1:
        return (len(intersection_names) - 1) / 2

    if _AFTER_PATTERN.search(incident_location_hint):
        return ref_index + 0.5
    if _BEFORE_PATTERN.search(incident_location_hint):
        return ref_index - 0.5
    return float(ref_index)


def is_upstream(
    candidate_segment_id: str,
    incident_seg: RoadSegment,
    incident_location_hint: str,
) -> bool:
    try:
        candidate_index = incident_seg.intersection_ids.index(candidate_segment_id)
    except ValueError:
        return False

    insertion_index = _find_incident_insertion_index(
        incident_seg.intersections, incident_location_hint
    )
    forward = _is_travel_forward(incident_seg.flow_direction)

    return candidate_index < insertion_index if forward else candidate_index > insertion_index


def select_evacuation_route(
    incident_segment_id: str,
    incident_location_hint: str,
    segments: dict[str, RoadSegment],
    current_saturation: dict[str, float],
) -> EvacuationRouteResult:
    incident_seg: Optional[RoadSegment] = segments.get(incident_segment_id)
    if incident_seg is None:
        return EvacuationRouteResult(
            main_route=None,
            secondary_routes=[],
            excluded=[],
            congestion_warning=False,
            recommend_public_transit=False,
        )

    excluded: list[ExcludedCandidate] = []
    passed: list[RoadSegment] = []

    for alt_id in incident_seg.alternatives:
        alt = segments.get(alt_id)
        if alt is None:
            continue

        if alt.capacity_vph < 1000:
            excluded.append(
                ExcludedCandidate(segment_id=alt_id, reason=f"容量 {alt.capacity_vph} < 1000")
            )
            continue
        if alt_id not in incident_seg.intersection_ids:
            excluded.append(
                ExcludedCandidate(
                    segment_id=alt_id,
                    reason=f"非直接相交路段（不在 {incident_segment_id} 之 intersections）",
                )
            )
            continue
        passed.append(alt)

    upstream_candidates = [
        c for c in passed if is_upstream(c.segment_id, incident_seg, incident_location_hint)
    ]
    downstream_candidates = [
        c for c in passed if not is_upstream(c.segment_id, incident_seg, incident_location_hint)
    ]

    sorted_upstream = sorted(
        upstream_candidates, key=lambda c: current_saturation.get(c.segment_id, 0)
    )
    main = sorted_upstream[0] if sorted_upstream else None
    still_congested = (
        current_saturation.get(main.segment_id, 0) >= 0.85 if main is not None else False
    )

    return EvacuationRouteResult(
        main_route=main.segment_id if main is not None else None,
        secondary_routes=[c.segment_id for c in downstream_candidates],
        excluded=excluded,
        congestion_warning=still_congested,
        recommend_public_transit=still_congested,
    )

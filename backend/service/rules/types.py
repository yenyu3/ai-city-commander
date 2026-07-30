"""Shared dataclasses for the SOP rule engine.

Mirrors frontend/src/types.ts one-to-one so the two implementations stay
comparable. Field names are snake_case; semantics are identical.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

Tier = Literal["Normal", "B", "A"]


@dataclass
class RoadSegment:
    segment_id: str
    name: str
    flow_direction: str
    # Raw road-name strings, upstream->downstream order as given by the source data.
    intersections: list[str]
    # Resolved segment_id per position, same length/order as `intersections`.
    # None where the name has no matching segment (e.g. 正氣橋 -- see
    # data/unmatched_intersection_names.json) -- positions are never dropped,
    # only left unresolved, so later indices don't shift. Mirrors schema.sql's
    # nullable road_segment_intersection_refs.intersecting_segment_id.
    intersection_ids: list[Optional[str]]
    capacity_vph: int
    alternatives: list[str]
    nearby_stations: list[str] = field(default_factory=list)


@dataclass
class TrafficSnapshot:
    timestamp: str
    segment_id: str
    road_name: str
    avg_speed: float
    vehicle_count: int
    saturation_score: float
    lane_status: str


@dataclass
class CrowdSnapshot:
    timestamp: str
    station_id: str
    location_name: str
    user_count: int
    stay_time_avg: float
    growth_rate: float
    roaming_pct: float  # 0~1 decimal


@dataclass
class LiveIncident:
    event_id: str
    type: str
    location: str
    affected_segment: str  # RD_ or BS_ prefixed
    status: str
    severity: str
    description: str
    timestamp: str
    affected_road: Optional[str] = None


@dataclass
class CityResponseResult:
    segment_id: str
    tier: Tier
    actions: list[str]


@dataclass
class ExcludedCandidate:
    segment_id: str
    reason: str


@dataclass
class EvacuationRouteResult:
    main_route: Optional[str]
    secondary_routes: list[str]
    excluded: list[ExcludedCandidate]
    congestion_warning: bool
    recommend_public_transit: bool


@dataclass
class EteResult:
    ete: int
    base: int
    penalty: float
    breakdown: str

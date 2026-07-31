"""Builds RoadSegment objects from road_network_geometry.json.

Standalone from the DB layer on purpose: this is usable both against the raw
competition data files (local dev, tests) and, once the schema is queried
directly, can be swapped for a loader that reads road_segments /
road_segment_intersection_refs instead -- the rule functions in this package
only depend on the RoadSegment shape, not on where it came from.
"""
from __future__ import annotations

import json
from pathlib import Path

from .types import RoadSegment


def build_segments_from_raw(raw: list[dict]) -> dict[str, RoadSegment]:
    """Same construction load_segments_from_geometry does, but from an
    already-parsed list (e.g. a JSON payload the frontend forwarded), not a
    file path."""
    name_to_id = {seg["name"]: seg["segment_id"] for seg in raw}

    segments: dict[str, RoadSegment] = {}
    for seg in raw:
        intersections = seg["intersections"]
        # Preserve position; None where the name isn't a tracked segment
        # (e.g. 正氣橋) -- see accident_response.py's module docstring for why
        # this must not be filtered out.
        intersection_ids = [name_to_id.get(name) for name in intersections]
        segments[seg["segment_id"]] = RoadSegment(
            segment_id=seg["segment_id"],
            name=seg["name"],
            flow_direction=seg["flow_direction"],
            intersections=intersections,
            intersection_ids=intersection_ids,
            capacity_vph=seg["capacity_vph"],
            alternatives=seg["alternatives"],
            nearby_stations=seg.get("nearby_stations", []),
        )
    return segments


def load_segments_from_geometry(path: Path) -> dict[str, RoadSegment]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return build_segments_from_raw(raw)

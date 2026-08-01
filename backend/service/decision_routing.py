"""Maps a `data/api.md`-style `locationId` to which SOP judgment applies.

`GET /api/decisions?scenarioAt&locationId` (decision/handler.py) and
decision-generator-worker/handler.py both need the same answer to "given
just a locationId, which decide_*() call (and which s3_cache key) is this?"
-- this module is the one place that answer lives, so the two Lambdas can't
drift.

Routing rule:
  RD_ segment that is an active incident's affected_segment at this
    scenario_at -> the incident checks (SOP §2 accident / §5 signal_failure)
  RD_ segment, otherwise                  -> congestion (SOP §1)
  BS_MRT_BL17                             -> mrt_diversion (SOP §3)
  BS_TPE_DOME                             -> dome_dispersal (SOP §4)
  any other BS_ station                   -> multilingual (SOP §6, batched)

`data/api.md`'s /api/decisions returns a single `aiDecision` per locationId,
but an incident's segment can independently trigger both §2 and §5 -- for
that case this module reports whichever one is actually triggered (or the
accident check, untriggered, if neither is) so callers still only need to
deal with one Decision.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import db
import s3_cache
from agent.decision_agent import Decision
from agent.facts import (
    decide_accident,
    decide_congestion,
    decide_dome_dispersal,
    decide_mrt_diversion,
    decide_multilingual,
    decide_signal_failure,
)

_MULTILINGUAL_CACHE_KEY = "_ALL_STATIONS_"


@dataclass
class LocationRoute:
    kind: str  # "congestion" | "incident" | "mrt_diversion" | "dome_dispersal" | "multilingual" | "unknown"
    event_id: Optional[str] = None  # set only when kind == "incident"


def resolve_location(conn, location_id: str, scenario_at: datetime) -> LocationRoute:
    if location_id.startswith("RD_"):
        incidents = db.fetch_active_incidents(conn, scenario_at)
        match = next((i for i in incidents if i.affected_segment == location_id), None)
        if match is not None:
            return LocationRoute(kind="incident", event_id=match.event_id)
        return LocationRoute(kind="congestion")
    if location_id == "BS_MRT_BL17":
        return LocationRoute(kind="mrt_diversion")
    if location_id == "BS_TPE_DOME":
        return LocationRoute(kind="dome_dispersal")
    if location_id.startswith("BS_"):
        return LocationRoute(kind="multilingual")
    return LocationRoute(kind="unknown")


def fetch_cached(route: LocationRoute, location_id: str, scenario_at: datetime) -> Optional[Decision]:
    """Cache-only lookup -- never computes. None means "not ready yet" (the
    caller should trigger decision-generator-worker and return 202)."""
    if route.kind == "congestion":
        return s3_cache.fetch_cached_congestion_decision(location_id, scenario_at)
    if route.kind == "incident":
        accident = s3_cache.fetch_cached_decision(route.event_id, scenario_at, "accident")
        signal = s3_cache.fetch_cached_decision(route.event_id, scenario_at, "signal_failure")
        if accident is None or signal is None:
            return None  # both checks must land before this locationId counts as "ready"
        return accident if accident.triggered else signal
    if route.kind in ("mrt_diversion", "dome_dispersal"):
        return s3_cache.fetch_cached_crowd_decision(location_id, scenario_at, route.kind)
    if route.kind == "multilingual":
        return _multilingual_for_station(location_id, scenario_at)
    return None


def _multilingual_for_station(location_id: str, scenario_at: datetime) -> Optional[Decision]:
    batch = s3_cache.fetch_cached_crowd_decision(_MULTILINGUAL_CACHE_KEY, scenario_at, "multilingual")
    if batch is None:
        return None
    triggered = location_id in (batch.result.get("stations") or [])
    return Decision(
        triggered=triggered,
        sop_section_id="6" if triggered else None,
        result=batch.result,
        reasoning=batch.reasoning,
        source=batch.source,
        public_message=batch.public_message if triggered else "",
    )


def compute_and_cache(conn, route: LocationRoute, location_id: str, scenario_at: datetime) -> Optional[Decision]:
    """Actually runs the matching decide_*() call and caches the result --
    decision-generator-worker's job. Checks the cache first too (a second
    invocation for the same locationId shouldn't re-invoke the LLM if
    another one already landed first)."""
    cached = fetch_cached(route, location_id, scenario_at)
    if cached is not None:
        return cached

    if route.kind == "congestion":
        traffic = db.fetch_latest_traffic_snapshots(conn, scenario_at)
        snapshot = next((t for t in traffic if t.segment_id == location_id), None)
        if snapshot is None:
            return None
        decision = decide_congestion(location_id, snapshot.road_name, snapshot.saturation_score)
        s3_cache.save_congestion_decision(segment_id=location_id, scenario_at=scenario_at, decision=decision)
        return decision

    if route.kind == "incident":
        incident = db.fetch_incident(conn, route.event_id)
        if incident is None:
            return None
        segments = db.fetch_road_segments(conn)
        traffic = db.fetch_latest_traffic_snapshots(conn, scenario_at)
        saturation = {t.segment_id: t.saturation_score for t in traffic}

        accident_decision = decide_accident(incident, segments, saturation)
        s3_cache.save_decision(
            event_id=route.event_id, scenario_at=scenario_at, alert_kind="accident",
            title=incident.location, decision=accident_decision,
        )
        signal_decision = decide_signal_failure(incident)
        s3_cache.save_decision(
            event_id=route.event_id, scenario_at=scenario_at, alert_kind="signal_failure",
            title=incident.location, decision=signal_decision,
        )
        return accident_decision if accident_decision.triggered else signal_decision

    if route.kind == "mrt_diversion":
        crowd = db.fetch_latest_crowd_snapshots(conn, scenario_at)
        snapshot = next((c for c in crowd if c.station_id == location_id), None)
        if snapshot is None:
            return None
        decision = decide_mrt_diversion(snapshot)
        s3_cache.save_crowd_decision(
            station_id=location_id, scenario_at=scenario_at,
            decision_kind="mrt_diversion", decision=decision,
        )
        return decision

    if route.kind == "dome_dispersal":
        history = db.fetch_crowd_history(conn, location_id, scenario_at)
        current = next(
            (c for c in db.fetch_latest_crowd_snapshots(conn, scenario_at) if c.station_id == location_id), None
        )
        if current is None:
            return None
        decision = decide_dome_dispersal(history, current)
        s3_cache.save_crowd_decision(
            station_id=location_id, scenario_at=scenario_at,
            decision_kind="dome_dispersal", decision=decision,
        )
        return decision

    if route.kind == "multilingual":
        # SOP §6 is a single batch judgment across every visible station,
        # not per-station -- see agent/facts.py::decide_multilingual and
        # s3_cache.py's "all.json" key. Compute+cache the whole batch once,
        # then report just this locationId's slice of it.
        crowd = db.fetch_latest_crowd_snapshots(conn, scenario_at)
        decision = decide_multilingual(crowd)
        s3_cache.save_crowd_decision(
            station_id=_MULTILINGUAL_CACHE_KEY, scenario_at=scenario_at,
            decision_kind="multilingual", decision=decision,
        )
        return _multilingual_for_station(location_id, scenario_at)

    return None

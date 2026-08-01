"""Orchestrates decision-generator-worker's 3-phase pipeline for one
`scenario_at` (2026-08-01 redesign, replacing the old one-locationId-at-a-time
design -- see git history / decision-generator-worker/WORKFLOW.md for the
before/after).

User's correction that drove this rewrite: don't fragment context into tiny
per-location LLM calls. The old design called e.g. `decide_congestion()`
once per segment, each time only knowing that one segment's own number --
zero cross-location awareness, and `locationId` was *required* (no way to
ask "what's going on city-wide"). The new design:

  Phase A -- Router (agent/router_agent.py::route_triggers): one LLM call
    given the ENTIRE city's current + previous-tick snapshot (all segments,
    all stations, all active incidents) decides which SOP articles are
    triggered and where. Cached once per scenario_at (`_ensure_city_sweep`).
  Phase B -- Focused generation (agent/facts.py's existing decide_*()
    functions, unchanged): for each Phase A candidate, generate the real
    reasoning/result/public_message. Phase B's own `triggered` is
    authoritative, not Phase A's guess (`_ensure_decisions`).
  Phase C -- Focused narrative (agent/router_agent.py::narrate_for_focus):
    blends every currently-triggered item into one piece of text, optionally
    centered on a caller-supplied focus location -- "your station's fine,
    but avoid Station B" (`_ensure_narrative`). `locationId` is now optional
    on the public API: given, the text focuses there while staying aware of
    everything else; omitted, it's a global summary.

`GET /api/decisions` (decision/handler.py) only ever does a cache-only read
(`fetch_cached_view`) -- never touches RDS or an LLM directly, same
cache-aside contract as before, just reshaped around a sweep instead of a
single location. `decision-generator-worker/handler.py` is the only caller
of `run_worker_phases`, which does the real (possibly RDS + multiple LLM
calls) work.

SOP §3 (`BS_MRT_BL17`) and §4 (`BS_TPE_DOME`) are deliberately *not* part of
Phase A's LLM judgment -- there are only ever these two fixed stations, and
§4's trigger condition needs full crowd history (historical peak >= 30000)
that Phase A's cheap current+previous snapshot can't see. They're always
added as Phase B candidates unconditionally (`_always_on_triggers`); Phase
B's `decide_mrt_diversion`/`decide_dome_dispersal` (which do fetch what they
need) remain the real authority on whether either actually triggered --
exactly how they already worked before this rewrite, just no longer gated
by an upfront per-location routing decision.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import db
import report_builder
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
from agent.router_agent import Trigger, narrate_for_focus, route_triggers
from rules.types import CrowdSnapshot, LiveIncident, RoadSegment, TrafficSnapshot

_MULTILINGUAL_CACHE_KEY = "_ALL_STATIONS_"
_GLOBAL_NARRATIVE_KEY = "_global"
# The three live_incidents.json event types map 1:1 onto SOP §2/§3/§5 (per
# data/(中華電信) 命題解說...md's data table) -- these are the only articles
# that get a 交控中心建議書 written (report_builder.py), keyed by event_id.
# §1/§4/§6 have no incident to key a report under and aren't reported this
# way per the brief anyway (congestion -> dashboard tier, multilingual ->
# publication's citizen notice).
_INCIDENT_RESPONSE_SOP_SECTIONS = {"2", "3", "5"}


@dataclass
class _CityData:
    current_traffic: dict[str, TrafficSnapshot]
    previous_traffic: dict[str, TrafficSnapshot]
    current_crowd: dict[str, CrowdSnapshot]
    previous_crowd: dict[str, CrowdSnapshot]
    incidents: dict[str, LiveIncident]  # by event_id
    segments: dict[str, RoadSegment] = field(default_factory=dict)  # full network graph, for decide_accident


def _fetch_city_data(conn, scenario_at: datetime) -> _CityData:
    current_traffic = {t.segment_id: t for t in db.fetch_latest_traffic_snapshots(conn, scenario_at)}
    prev_traffic_ts = db.fetch_previous_traffic_timestamp(conn, scenario_at)
    previous_traffic = (
        {t.segment_id: t for t in db.fetch_latest_traffic_snapshots(conn, prev_traffic_ts)}
        if prev_traffic_ts
        else {}
    )

    current_crowd = {c.station_id: c for c in db.fetch_latest_crowd_snapshots(conn, scenario_at)}
    prev_crowd_ts = db.fetch_previous_crowd_timestamp(conn, scenario_at)
    previous_crowd = (
        {c.station_id: c for c in db.fetch_latest_crowd_snapshots(conn, prev_crowd_ts)} if prev_crowd_ts else {}
    )

    incidents = {i.event_id: i for i in db.fetch_active_incidents(conn, scenario_at)}
    segments = db.fetch_road_segments(conn)

    return _CityData(current_traffic, previous_traffic, current_crowd, previous_crowd, incidents, segments)


def _traffic_point(t: TrafficSnapshot) -> dict:
    return {
        "saturationScore": t.saturation_score,
        "avgSpeed": t.avg_speed,
        "vehicleCount": t.vehicle_count,
        "laneStatus": t.lane_status,
    }


def _crowd_point(c: CrowdSnapshot) -> dict:
    return {
        "userCount": c.user_count,
        "growthRate": c.growth_rate,
        "roamingPct": c.roaming_pct,
        "stayTimeAvg": c.stay_time_avg,
    }


def _snapshot_json(data: _CityData) -> dict:
    return {
        "segments": [
            {
                "segment_id": t.segment_id,
                "segment_name": t.road_name,
                "current": _traffic_point(t),
                "previous": _traffic_point(data.previous_traffic[t.segment_id])
                if t.segment_id in data.previous_traffic
                else None,
            }
            for t in data.current_traffic.values()
        ],
        "stations": [
            {
                "station_id": c.station_id,
                "location_name": c.location_name,
                "current": _crowd_point(c),
                "previous": _crowd_point(data.previous_crowd[c.station_id])
                if c.station_id in data.previous_crowd
                else None,
            }
            for c in data.current_crowd.values()
        ],
        "active_incidents": [
            {
                "event_id": i.event_id,
                "type": i.type,
                "location": i.location,
                "affected_segment": i.affected_segment,
                "status": i.status,
                "severity": i.severity,
                "description": i.description,
            }
            for i in data.incidents.values()
        ],
    }


def _eager_trigger_scan(conn, data: _CityData, scenario_at: datetime) -> list[Trigger]:
    """Phase A's no-LLM fallback -- exactly today's brute-force behavior
    (call every existing decide_*() eagerly, keep the triggered ones), just
    orchestrated as one sweep instead of driven by external per-location
    queries. Each decide_*() call independently falls back to rules/ too
    (no LLM configured propagates all the way down), so this stays a pure
    deterministic path end to end."""
    triggers: list[Trigger] = []

    for segment_id, t in data.current_traffic.items():
        if decide_congestion(segment_id, t.road_name, t.saturation_score).triggered:
            triggers.append(Trigger(sop_section_id="1", location_id=segment_id))

    if data.current_crowd:
        multilingual = decide_multilingual(list(data.current_crowd.values()))
        for station_id in multilingual.result.get("stations") or []:
            triggers.append(Trigger(sop_section_id="6", location_id=station_id))

    saturation = {sid: t.saturation_score for sid, t in data.current_traffic.items()}
    for incident in data.incidents.values():
        if decide_accident(incident, data.segments, saturation).triggered:
            triggers.append(Trigger(sop_section_id="2", location_id=incident.affected_segment))
        if decide_signal_failure(incident).triggered:
            triggers.append(Trigger(sop_section_id="5", location_id=incident.affected_segment))

    return triggers


def _always_on_triggers(data: _CityData) -> list[Trigger]:
    """SOP §3/§4 candidates -- always evaluated in Phase B regardless of what
    Phase A said (see module docstring for why)."""
    triggers = []
    if "BS_MRT_BL17" in data.current_crowd:
        triggers.append(Trigger(sop_section_id="3", location_id="BS_MRT_BL17"))
    if "BS_TPE_DOME" in data.current_crowd:
        triggers.append(Trigger(sop_section_id="4", location_id="BS_TPE_DOME"))
    return triggers


def _attach_event_ids(triggers: list[Trigger], data: _CityData) -> list[Trigger]:
    """Tags any trigger whose location_id is an active incident's
    affected_segment with that incident's event_id -- regardless of SOP
    article/kind. This is what lets e.g. TPE_2026_EVT_002 (Crowd_Surge_Injury,
    SOP §3, affected_segment=BS_MRT_BL17) get its own report even though §3's
    *decision* is computed the same way whether or not an incident is tied to
    it (see report_builder integration in _compute_decision_for_trigger)."""
    by_segment = {i.affected_segment: i.event_id for i in data.incidents.values()}
    return [
        Trigger(sop_section_id=t.sop_section_id, location_id=t.location_id, event_id=by_segment[t.location_id])
        if t.location_id in by_segment
        else t
        for t in triggers
    ]


def _ensure_city_sweep(conn, scenario_at: datetime, data: _CityData, *, force_refresh: bool) -> list[Trigger]:
    if not force_refresh:
        cached = s3_cache.fetch_cached_triggers(scenario_at)
        if cached is not None:
            return cached

    snapshot = _snapshot_json(data)

    def fallback() -> list[Trigger]:
        return _eager_trigger_scan(conn, data, scenario_at)

    triggers = route_triggers(snapshot, fallback=fallback) + _always_on_triggers(data)
    triggers = _attach_event_ids(triggers, data)
    s3_cache.save_triggers(scenario_at=scenario_at, triggers=triggers)
    return triggers


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


def _fetch_cached_decision_for_trigger(trig: Trigger, scenario_at: datetime) -> Optional[Decision]:
    if trig.kind == "congestion":
        return s3_cache.fetch_cached_congestion_decision(trig.location_id, scenario_at)
    if trig.kind in ("accident", "signal_failure"):
        if trig.event_id is None:
            return None
        return s3_cache.fetch_cached_decision(trig.event_id, scenario_at, trig.kind)
    if trig.kind in ("mrt_diversion", "dome_dispersal"):
        return s3_cache.fetch_cached_crowd_decision(trig.location_id, scenario_at, trig.kind)
    if trig.kind == "multilingual":
        return _multilingual_for_station(trig.location_id, scenario_at)
    return None


def _maybe_write_report(scenario_at: datetime, data: _CityData, trig: Trigger, decision: Decision) -> None:
    if trig.event_id is None or not decision.triggered or trig.sop_section_id not in _INCIDENT_RESPONSE_SOP_SECTIONS:
        return
    incident = data.incidents.get(trig.event_id)
    if incident is None:
        return
    report_builder.build_and_save_report(incident=incident, decision=decision, scenario_at=scenario_at)


def _compute_decision_for_trigger(
    conn, scenario_at: datetime, data: _CityData, trig: Trigger
) -> Optional[Decision]:
    if trig.kind == "congestion":
        t = data.current_traffic.get(trig.location_id)
        if t is None:
            return None
        decision = decide_congestion(trig.location_id, t.road_name, t.saturation_score)
        s3_cache.save_congestion_decision(segment_id=trig.location_id, scenario_at=scenario_at, decision=decision)

    elif trig.kind in ("accident", "signal_failure"):
        incident = data.incidents.get(trig.event_id) if trig.event_id else None
        if incident is None:
            return None
        if trig.kind == "accident":
            saturation = {sid: t.saturation_score for sid, t in data.current_traffic.items()}
            decision = decide_accident(incident, data.segments, saturation)
        else:
            decision = decide_signal_failure(incident)
        s3_cache.save_decision(
            event_id=trig.event_id, scenario_at=scenario_at, alert_kind=trig.kind,
            title=incident.location, decision=decision,
        )

    elif trig.kind == "mrt_diversion":
        c = data.current_crowd.get(trig.location_id)
        if c is None:
            return None
        decision = decide_mrt_diversion(c)
        s3_cache.save_crowd_decision(
            station_id=trig.location_id, scenario_at=scenario_at, decision_kind="mrt_diversion", decision=decision,
        )

    elif trig.kind == "dome_dispersal":
        c = data.current_crowd.get(trig.location_id)
        if c is None:
            return None
        history = db.fetch_crowd_history(conn, trig.location_id, scenario_at)
        decision = decide_dome_dispersal(history, c)
        s3_cache.save_crowd_decision(
            station_id=trig.location_id, scenario_at=scenario_at, decision_kind="dome_dispersal", decision=decision,
        )

    elif trig.kind == "multilingual":
        decision = decide_multilingual(list(data.current_crowd.values()))
        s3_cache.save_crowd_decision(
            station_id=_MULTILINGUAL_CACHE_KEY, scenario_at=scenario_at, decision_kind="multilingual", decision=decision,
        )
        decision = _multilingual_for_station(trig.location_id, scenario_at)
        if decision is None:
            return None

    else:
        return None

    _maybe_write_report(scenario_at, data, trig, decision)
    return decision


def _ensure_decisions(
    conn, scenario_at: datetime, data: _CityData, triggers: list[Trigger]
) -> list[tuple[Trigger, Decision]]:
    """Phase B -- cache-aside per candidate. Only triggers whose Decision
    actually came back `triggered=True` are returned (Phase B is
    authoritative, not Phase A's guess); non-triggered ones are still
    computed+cached so a repeat sweep doesn't redo the work, just excluded
    from what callers see."""
    pairs: list[tuple[Trigger, Decision]] = []
    for trig in triggers:
        decision = _fetch_cached_decision_for_trigger(trig, scenario_at)
        if decision is None:
            decision = _compute_decision_for_trigger(conn, scenario_at, data, trig)
        if decision is not None and decision.triggered:
            pairs.append((trig, decision))
    return pairs


def _location_name(data: _CityData, location_id: str) -> str:
    if location_id in data.current_traffic:
        return data.current_traffic[location_id].road_name
    if location_id in data.current_crowd:
        return data.current_crowd[location_id].location_name
    return location_id


def _ensure_narrative(
    scenario_at: datetime, data: _CityData, pairs: list[tuple[Trigger, Decision]], location_id: Optional[str]
) -> str:
    location_key = location_id if location_id is not None else _GLOBAL_NARRATIVE_KEY
    cached = s3_cache.fetch_cached_narrative(scenario_at, location_key)
    if cached is not None:
        return cached

    items = [
        {"locationId": trig.location_id, "publicMessage": decision.public_message}
        for trig, decision in pairs
    ]
    focus_name = _location_name(data, location_id) if location_id is not None else None
    narrative = narrate_for_focus(items, location_id, focus_name)
    s3_cache.save_narrative(scenario_at=scenario_at, location_key=location_key, narrative=narrative)
    return narrative


def run_worker_phases(
    conn, scenario_at: datetime, location_id: Optional[str], *, force_refresh: bool = False
) -> tuple[list[tuple[Trigger, Decision]], str]:
    """decision-generator-worker's full pipeline for one scenario_at --
    ensures Phase A (sweep) and Phase B (every triggered item's decision)
    exist, then generates Phase C's narrative for this invocation's specific
    focus. Every invocation guarantees A+B are done before doing its own
    (cheap) C, so a second caller asking about a different focus for the
    same scenario_at reuses the cached sweep/decisions."""
    data = _fetch_city_data(conn, scenario_at)
    triggers = _ensure_city_sweep(conn, scenario_at, data, force_refresh=force_refresh)
    pairs = _ensure_decisions(conn, scenario_at, data, triggers)
    narrative = _ensure_narrative(scenario_at, data, pairs, location_id)
    return pairs, narrative


def fetch_cached_view(
    scenario_at: datetime, location_id: Optional[str]
) -> Optional[tuple[list[tuple[Trigger, Decision]], str]]:
    """Cache-only read for GET /api/decisions -- never touches RDS or an
    LLM. None means "not ready yet" (caller should 202 + trigger the
    worker)."""
    triggers = s3_cache.fetch_cached_triggers(scenario_at)
    if triggers is None:
        return None

    location_key = location_id if location_id is not None else _GLOBAL_NARRATIVE_KEY
    narrative = s3_cache.fetch_cached_narrative(scenario_at, location_key)
    if narrative is None:
        return None

    pairs: list[tuple[Trigger, Decision]] = []
    for trig in triggers:
        decision = _fetch_cached_decision_for_trigger(trig, scenario_at)
        if decision is None:
            return None  # sweep says candidate, Phase B hasn't landed yet
        if decision.triggered:
            pairs.append((trig, decision))
    return pairs, narrative

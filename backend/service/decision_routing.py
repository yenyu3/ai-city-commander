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
of both entries below, which do the real (possibly RDS + multiple LLM
calls) work, chosen by the invoking API:

  decision-generator-worker `mode: "decision"`  (from GET /api/decisions)
    -> run_worker_phases() -- the general city sweep, writes decisions/ only.
  decision-generator-worker `mode: "incident"`  (from POST /api/incidents)
    -> run_incident_flow() -- one injected event's §2/§3/§5 judgment + report,
       writes incidents/{date}/{eventId}/decisions/... and emergency-reports/.

The decision-vs-incident split is decided by which API invoked the worker
(`mode`), never by SOP kind or event_id presence -- see _INCIDENT_RESPONSE_KINDS.

2026-08-01 perf: Phase B's cache-miss computations (_ensure_decisions) and
run_incident_flow's up-to-3 SOP checks are each independent LLM calls with no
shared mutable state, so both now run their misses/checks in parallel via
ThreadPoolExecutor instead of a sequential loop -- targeting the brief's
60-second replan requirement (N sequential ~5-20s LLM calls collapsing to
roughly one call's duration). psycopg connections aren't thread-safe, so any
DB read a parallelized branch needs (only dome_dispersal's crowd history) is
fetched sequentially before the parallel section starts, not from inside it.

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

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Optional

import db
import report_builder
import s3_cache
from agent.decision_agent import Decision
from agent.facts import (
    build_accident_candidates,
    decide_accident,
    decide_congestion,
    decide_dome_dispersal,
    decide_mrt_diversion,
    decide_multilingual,
    decide_signal_failure,
)
from agent.router_agent import Trigger, narrate_for_focus, route_triggers
from rules.congestion_tier import CITY_TRIGGER_SEGMENTS
from rules.types import CrowdSnapshot, LiveIncident, RoadSegment, TrafficSnapshot

_MULTILINGUAL_CACHE_KEY = "_ALL_STATIONS_"
_GLOBAL_NARRATIVE_KEY = "_global"
# Decision-vs-incident is decided by which API invoked the worker, NOT by SOP
# kind or event_id presence (decision-generator-worker/handler.py branches on
# `mode`). The decision API's city sweep (`run_worker_phases`) only ever
# produces general decisions -- congestion/mrt/dome/multilingual -- and never
# the per-incident SOP §2/§5 responses. Those are produced only by the
# incident API entry (`run_incident_flow`, fired by POST /api/incidents) and
# written under incidents/{date}/{eventId}/... + emergency-reports/, never
# under decisions/. This filter keeps the two API entry points disjoint.
_INCIDENT_RESPONSE_KINDS = {"accident", "signal_failure"}


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
    # Both of these are already-fetched data reshaped, not new DB/LLM calls
    # -- cheap to hand Phase A the same structural facts Phase B's decide_*()
    # functions use, instead of making it re-derive them (e.g. from reading
    # the SOP text) or guess blind. See agent/router_agent.py's system
    # prompt for how these are used.
    saturation = {sid: t.saturation_score for sid, t in data.current_traffic.items()}

    return {
        "segments": [
            {
                "segment_id": t.segment_id,
                "segment_name": t.road_name,
                "is_city_trigger_segment": t.segment_id in CITY_TRIGGER_SEGMENTS,
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
                "candidate_alternative_routes": build_accident_candidates(i, data.segments, saturation),
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
    # Decision API entry only: drop the per-incident §2/§5 responses (both the
    # router's output and _eager_trigger_scan's fallback feed through here) --
    # those are the incident entry's job (run_incident_flow), see the
    # _INCIDENT_RESPONSE_KINDS note.
    triggers = [t for t in triggers if t.kind not in _INCIDENT_RESPONSE_KINDS]
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
    # Decision-API entry only -- no accident/signal_failure branch on purpose
    # (those never appear in the city sweep, see _INCIDENT_RESPONSE_KINDS).
    if trig.kind == "congestion":
        return s3_cache.fetch_cached_congestion_decision(trig.location_id, scenario_at)
    if trig.kind in ("mrt_diversion", "dome_dispersal"):
        return s3_cache.fetch_cached_crowd_decision(trig.location_id, scenario_at, trig.kind)
    if trig.kind == "multilingual":
        return _multilingual_for_station(trig.location_id, scenario_at)
    return None


def _compute_decision_for_trigger(
    scenario_at: datetime, data: _CityData, trig: Trigger, dome_history: dict[str, list[CrowdSnapshot]]
) -> Optional[Decision]:
    """Decision-API entry only (see _INCIDENT_RESPONSE_KINDS) -- no accident/
    signal_failure branches and no report writing here; the per-incident
    §2/§5/§3 judgments + 交控中心建議書 are produced by run_incident_flow
    (the incident API entry) instead.

    Deliberately takes no `conn` -- this runs inside a ThreadPoolExecutor
    (see _ensure_decisions), and psycopg connections aren't safe to share
    across threads. `dome_history` is pre-fetched sequentially by the caller
    before parallelizing (dome_dispersal is the only branch that ever needs
    RDS beyond what `data` already carries)."""
    if trig.kind == "congestion":
        t = data.current_traffic.get(trig.location_id)
        if t is None:
            return None
        decision = decide_congestion(trig.location_id, t.road_name, t.saturation_score)
        s3_cache.save_congestion_decision(segment_id=trig.location_id, scenario_at=scenario_at, decision=decision)

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
        history = dome_history.get(trig.location_id, [])
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

    return decision


# Bounded so a pathological sweep (many simultaneous triggers) doesn't open
# an unbounded number of concurrent LLM/S3 calls -- these are I/O-bound
# (network) calls, so threads (not processes) are the right tool, and 8 is
# comfortably above the handful of triggers a real scenario_at produces
# today while still capping worst-case fan-out.
_MAX_PARALLEL_DECISIONS = 8


def _ensure_decisions(
    conn, scenario_at: datetime, data: _CityData, triggers: list[Trigger]
) -> list[tuple[Trigger, Decision]]:
    """Phase B -- cache-aside per candidate. Only triggers whose Decision
    actually came back `triggered=True` are returned (Phase B is
    authoritative, not Phase A's guess); non-triggered ones are still
    computed+cached so a repeat sweep doesn't redo the work, just excluded
    from what callers see.

    2026-08-01: cache misses are computed in parallel (ThreadPoolExecutor) --
    each miss is an independent LLM call plus its own S3 write, so with N
    simultaneous triggers this collapses from N sequential ~5-20s calls to
    roughly the duration of the single slowest one, directly targeting the
    brief's 60-second replan requirement. Cache hits are read sequentially
    first (cheap, no reason to parallelize S3 GETs that usually all hit)."""
    results: dict[int, Optional[Decision]] = {}
    misses: list[tuple[int, Trigger]] = []
    for i, trig in enumerate(triggers):
        decision = _fetch_cached_decision_for_trigger(trig, scenario_at)
        if decision is not None:
            results[i] = decision
        else:
            misses.append((i, trig))

    # dome_dispersal's history query is the only place this function still
    # needs `conn` -- fetched sequentially, before handing off to worker
    # threads, since only one station (BS_TPE_DOME) can ever need it.
    dome_history = {
        trig.location_id: db.fetch_crowd_history(conn, trig.location_id, scenario_at)
        for _i, trig in misses
        if trig.kind == "dome_dispersal"
    }

    if misses:
        with ThreadPoolExecutor(max_workers=min(_MAX_PARALLEL_DECISIONS, len(misses))) as pool:
            futures = {
                pool.submit(_compute_decision_for_trigger, scenario_at, data, trig, dome_history): i
                for i, trig in misses
            }
            for future, i in futures.items():
                results[i] = future.result()

    pairs: list[tuple[Trigger, Decision]] = []
    for i, trig in enumerate(triggers):
        decision = results.get(i)
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
    """Decision API entry -- the city-wide sweep for GET /api/decisions
    (triggered on a cache miss). Ensures Phase A (sweep) and Phase B (every
    triggered *general* decision: congestion/mrt/dome/multilingual) exist,
    then generates Phase C's narrative for this invocation's specific focus.
    Never produces per-incident §2/§5 responses or reports -- that's the
    incident API entry (run_incident_flow), per the API-entry-decides rule.
    Every invocation guarantees A+B are done before doing its own (cheap) C,
    so a second caller asking about a different focus for the same scenario_at
    reuses the cached sweep/decisions."""
    data = _fetch_city_data(conn, scenario_at)
    triggers = _ensure_city_sweep(conn, scenario_at, data, force_refresh=force_refresh)
    pairs = _ensure_decisions(conn, scenario_at, data, triggers)
    narrative = _ensure_narrative(scenario_at, data, pairs, location_id)
    return pairs, narrative


def run_incident_flow(conn, scenario_at: datetime, event_id: str) -> list[tuple[Trigger, Decision]]:
    """Incident API entry -- fired by POST /api/incidents for ONE injected
    event. Computes that incident's SOP judgments (a single incident may trip
    several: §2 accident + §5 signal failure are always checked, §3 mrt
    diversion only when its affected_segment is a station in the crowd data),
    caches each triggered one under
    incidents/{date}/{eventId}/decisions/{scenarioAt}/{kind}.json, and writes
    the 交控中心建議書 to emergency-reports/ (report_builder.py) -- the exact
    key GET /api/incidents/{eventId}/report polls.

    This is deliberately disjoint from run_worker_phases (the decision API
    entry): the decision-vs-incident split is decided by which API invoked
    the worker, not by SOP kind or event_id presence. Returns the triggered
    (trigger, decision) pairs so the worker's response can report a count.

    2026-08-01: the up-to-3 SOP checks below are independent LLM calls (no
    shared mutable state, `conn` isn't touched by any of them -- all their
    inputs already live in `data`/`incident`) and are run in parallel via
    ThreadPoolExecutor, same rationale as _ensure_decisions. S3 writes
    (decision cache + report) happen sequentially afterward, per triggered
    result -- those are fast relative to the LLM calls and keep the
    S3-write-order simple to reason about."""
    data = _fetch_city_data(conn, scenario_at)
    incident = data.incidents.get(event_id)
    if incident is None:
        return []

    date = incident.timestamp.split("T")[0].split(" ")[0]
    saturation = {sid: t.saturation_score for sid, t in data.current_traffic.items()}

    checks: list[tuple[str, Callable[[], Decision]]] = [
        ("accident", lambda: decide_accident(incident, data.segments, saturation)),
        ("signal_failure", lambda: decide_signal_failure(incident)),
    ]
    station = data.current_crowd.get(incident.affected_segment)
    if station is not None:
        checks.append(("mrt_diversion", lambda: decide_mrt_diversion(station)))

    with ThreadPoolExecutor(max_workers=len(checks)) as pool:
        futures = {pool.submit(run): kind for kind, run in checks}
        decisions = [(futures[future], future.result()) for future in futures]

    pairs: list[tuple[Trigger, Decision]] = []
    for kind, decision in decisions:
        if not decision.triggered:
            continue
        s3_cache.save_incident_decision(
            event_id=event_id, date=date, scenario_at=scenario_at,
            alert_kind=kind, title=incident.location, decision=decision,
        )
        report_builder.build_and_save_report(incident=incident, decision=decision, scenario_at=scenario_at)
        pairs.append(
            (
                Trigger(
                    sop_section_id=decision.sop_section_id or "2",
                    location_id=incident.affected_segment,
                    event_id=event_id,
                ),
                decision,
            )
        )
    return pairs


def fetch_cached_view(
    scenario_at: datetime, location_id: Optional[str]
) -> Optional[tuple[list[tuple[Trigger, Decision]], str]]:
    """Cache-only read for GET /api/decisions -- never touches RDS or an
    LLM. Returns the general (decision-API) pairs only; per-incident §2/§5
    responses never appear here. None means "not ready yet" (caller should
    202 + trigger the worker)."""
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

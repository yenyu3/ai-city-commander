"""PostgreSQL access layer.

Connects to the RDS instance provisioned by backend/terraform/ (or a local
Postgres for dev/test -- see backend/README.md's "本機 DB 測試" section).
Reads `DATABASE_URL` (postgresql://user:pass@host:port/dbname); in the real
Lambda deployment this would instead be assembled from
`DATABASE_SECRET_ARN` via Secrets Manager (not implemented here yet -- see
backend/terraform/lambda.tf for the env var already wired in).

Query functions take an explicit `psycopg.Connection` rather than opening
their own, so callers (and tests) control the connection/transaction
lifecycle.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime
from typing import Any, Optional

import psycopg
from psycopg.rows import dict_row

from agent.decision_agent import Decision
from rules.types import CrowdSnapshot, LiveIncident, RoadSegment, TrafficSnapshot


def connect() -> psycopg.Connection:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError(
            "DATABASE_URL is not set. For local dev: "
            "postgresql://postgres:aicity@localhost:5432/aicity"
        )
    return psycopg.connect(database_url, row_factory=dict_row)


def fetch_latest_traffic_snapshots(
    conn: psycopg.Connection, scenario_at: datetime
) -> list[TrafficSnapshot]:
    """Latest snapshot at-or-before scenario_at, one row per segment."""
    rows = conn.execute(
        """
        SELECT DISTINCT ON (ts.segment_id)
            ts.segment_id, rs.name AS road_name, ts.observed_at,
            ts.avg_speed_kph, ts.vehicle_count, ts.saturation_score, ts.lane_status
        FROM traffic_snapshots ts
        JOIN road_segments rs ON rs.segment_id = ts.segment_id
        WHERE ts.observed_at <= %(scenario_at)s
        ORDER BY ts.segment_id, ts.observed_at DESC
        """,
        {"scenario_at": scenario_at},
    ).fetchall()
    return [
        TrafficSnapshot(
            timestamp=row["observed_at"].isoformat(),
            segment_id=row["segment_id"],
            road_name=row["road_name"],
            avg_speed=float(row["avg_speed_kph"]),
            vehicle_count=row["vehicle_count"],
            saturation_score=float(row["saturation_score"]),
            lane_status=row["lane_status"],
        )
        for row in rows
    ]


def fetch_latest_crowd_snapshots(
    conn: psycopg.Connection, scenario_at: datetime
) -> list[CrowdSnapshot]:
    """Latest snapshot at-or-before scenario_at, one row per station."""
    rows = conn.execute(
        """
        SELECT DISTINCT ON (cs.station_id)
            cs.station_id, st.name AS location_name, cs.observed_at,
            cs.user_count, cs.stay_time_avg_minutes, cs.growth_rate, cs.roaming_user_pct
        FROM crowd_snapshots cs
        JOIN stations st ON st.station_id = cs.station_id
        WHERE cs.observed_at <= %(scenario_at)s
        ORDER BY cs.station_id, cs.observed_at DESC
        """,
        {"scenario_at": scenario_at},
    ).fetchall()
    return [
        CrowdSnapshot(
            timestamp=row["observed_at"].isoformat(),
            station_id=row["station_id"],
            location_name=row["location_name"],
            user_count=row["user_count"],
            stay_time_avg=float(row["stay_time_avg_minutes"]),
            growth_rate=float(row["growth_rate"]),
            roaming_pct=float(row["roaming_user_pct"]),
        )
        for row in rows
    ]


def fetch_crowd_history(
    conn: psycopg.Connection, station_id: str, scenario_at: datetime
) -> list[CrowdSnapshot]:
    """All snapshots strictly before scenario_at for one station (used for
    the dome-dispersal historical-peak check, which needs the whole series,
    not just the latest point)."""
    rows = conn.execute(
        """
        SELECT cs.station_id, st.name AS location_name, cs.observed_at,
               cs.user_count, cs.stay_time_avg_minutes, cs.growth_rate, cs.roaming_user_pct
        FROM crowd_snapshots cs
        JOIN stations st ON st.station_id = cs.station_id
        WHERE cs.station_id = %(station_id)s AND cs.observed_at < %(scenario_at)s
        ORDER BY cs.observed_at ASC
        """,
        {"station_id": station_id, "scenario_at": scenario_at},
    ).fetchall()
    return [
        CrowdSnapshot(
            timestamp=row["observed_at"].isoformat(),
            station_id=row["station_id"],
            location_name=row["location_name"],
            user_count=row["user_count"],
            stay_time_avg=float(row["stay_time_avg_minutes"]),
            growth_rate=float(row["growth_rate"]),
            roaming_pct=float(row["roaming_user_pct"]),
        )
        for row in rows
    ]


def fetch_road_segments(conn: psycopg.Connection) -> dict[str, RoadSegment]:
    """Reconstructs the RoadSegment graph from the normalized tables
    (road_segments + road_segment_alternatives + road_segment_intersection_refs)
    instead of road_network_geometry.json -- same shape rules.network_loader
    produces from the file, including the None-preserving intersection_ids
    (nullable `intersecting_segment_id`, e.g. 正氣橋) that
    accident_response.py's algorithm depends on.
    """
    segment_rows = conn.execute(
        "SELECT segment_id, name, flow_direction, capacity_vph FROM road_segments"
    ).fetchall()

    alternatives_by_segment: dict[str, list[str]] = {}
    for row in conn.execute(
        "SELECT segment_id, alternative_segment_id FROM road_segment_alternatives "
        "ORDER BY segment_id, priority"
    ).fetchall():
        alternatives_by_segment.setdefault(row["segment_id"], []).append(
            row["alternative_segment_id"]
        )

    intersections_by_segment: dict[str, list[tuple[str, Optional[str]]]] = {}
    for row in conn.execute(
        "SELECT segment_id, intersecting_road_name, intersecting_segment_id "
        "FROM road_segment_intersection_refs ORDER BY segment_id, sequence_no"
    ).fetchall():
        intersections_by_segment.setdefault(row["segment_id"], []).append(
            (row["intersecting_road_name"], row["intersecting_segment_id"])
        )

    nearby_stations_by_segment: dict[str, list[str]] = {}
    for row in conn.execute(
        "SELECT segment_id, station_id FROM road_segment_nearby_stations"
    ).fetchall():
        nearby_stations_by_segment.setdefault(row["segment_id"], []).append(row["station_id"])

    segments: dict[str, RoadSegment] = {}
    for row in segment_rows:
        segment_id = row["segment_id"]
        pairs = intersections_by_segment.get(segment_id, [])
        segments[segment_id] = RoadSegment(
            segment_id=segment_id,
            name=row["name"],
            flow_direction=row["flow_direction"],
            intersections=[name for name, _ in pairs],
            intersection_ids=[sid for _, sid in pairs],
            capacity_vph=row["capacity_vph"],
            alternatives=alternatives_by_segment.get(segment_id, []),
            nearby_stations=nearby_stations_by_segment.get(segment_id, []),
        )
    return segments


def fetch_active_incidents(
    conn: psycopg.Connection, scenario_at: datetime
) -> list[LiveIncident]:
    """Incidents that have occurred at-or-before scenario_at.

    Reconstructed from `source_payload` (the original flat event shape) --
    `rules.types.LiveIncident` mirrors that shape directly, and
    incident_road_impacts/incident_station_impacts are the normalized query
    surface for "which incidents touch segment X", not needed here.
    """
    rows = conn.execute(
        """
        SELECT event_id, incident_type, location_description, status, severity,
               description, occurred_at, source_payload
        FROM incidents
        WHERE occurred_at <= %(scenario_at)s
        ORDER BY occurred_at DESC
        """,
        {"scenario_at": scenario_at},
    ).fetchall()
    return [_incident_from_row(row) for row in rows]


def fetch_incident(conn: psycopg.Connection, event_id: str) -> Optional[LiveIncident]:
    row = conn.execute(
        """
        SELECT event_id, incident_type, location_description, status, severity,
               description, occurred_at, source_payload
        FROM incidents
        WHERE event_id = %(event_id)s
        """,
        {"event_id": event_id},
    ).fetchone()
    return _incident_from_row(row) if row else None


def _incident_from_row(row: dict[str, Any]) -> LiveIncident:
    payload = row["source_payload"] or {}
    return LiveIncident(
        event_id=row["event_id"],
        type=payload.get("type", row["incident_type"]),
        location=payload.get("location", row["location_description"]),
        affected_segment=payload.get("affected_segment", ""),
        affected_road=payload.get("affected_road"),
        status=row["status"],
        severity=row["severity"],
        description=row["description"],
        timestamp=payload.get("timestamp", row["occurred_at"].isoformat()),
    )


def insert_incident(
    conn: psycopg.Connection,
    incident: LiveIncident,
    *,
    occurred_at: datetime,
    road_segment_ids: list[str],
    station_ids: list[str],
) -> None:
    """Inserts a new incident plus its road/station impact rows.

    `incident.affected_segment` already tells you which of road_segment_ids /
    station_ids it belongs to (RD_ vs BS_ prefix) -- callers pass both
    explicitly so this function doesn't need to guess.
    """
    source_payload = {
        "event_id": incident.event_id,
        "type": incident.type,
        "location": incident.location,
        "affected_segment": incident.affected_segment,
        "affected_road": incident.affected_road,
        "status": incident.status,
        "severity": incident.severity,
        "description": incident.description,
        "timestamp": incident.timestamp,
    }
    conn.execute(
        """
        INSERT INTO incidents
            (event_id, incident_type, location_description, status, severity,
             description, occurred_at, source_payload)
        VALUES (%(event_id)s, %(incident_type)s, %(location)s, %(status)s, %(severity)s,
                %(description)s, %(occurred_at)s, %(source_payload)s)
        ON CONFLICT (event_id) DO UPDATE SET
            status = EXCLUDED.status,
            severity = EXCLUDED.severity,
            description = EXCLUDED.description,
            source_payload = EXCLUDED.source_payload,
            updated_at = now()
        """,
        {
            "event_id": incident.event_id,
            "incident_type": incident.type,
            "location": incident.location,
            "status": incident.status,
            "severity": incident.severity,
            "description": incident.description,
            "occurred_at": occurred_at,
            "source_payload": json.dumps(source_payload, ensure_ascii=False),
        },
    )
    for segment_id in road_segment_ids:
        conn.execute(
            """
            INSERT INTO incident_road_impacts (event_id, segment_id, impact_role)
            VALUES (%(event_id)s, %(segment_id)s, 'primary')
            ON CONFLICT (event_id, segment_id) DO NOTHING
            """,
            {"event_id": incident.event_id, "segment_id": segment_id},
        )
    for station_id in station_ids:
        conn.execute(
            """
            INSERT INTO incident_station_impacts (event_id, station_id, impact_role)
            VALUES (%(event_id)s, %(station_id)s, 'primary')
            ON CONFLICT (event_id, station_id) DO NOTHING
            """,
            {"event_id": incident.event_id, "station_id": station_id},
        )


def fetch_cached_decision(
    conn: psycopg.Connection, event_id: str, scenario_at: datetime, alert_kind: str
) -> Optional[Decision]:
    """Returns a previously-computed Decision for this exact
    (event_id, scenario_at, alert_kind) triple, or None if it hasn't been
    checked yet. `alert_kind` distinguishes which SOP-shaped check this is
    (e.g. "accident" vs "signal_failure") -- one incident can independently
    trigger more than one, so each is cached separately.

    This is the cache lookup: re-requesting an evaluation for a scenario
    time already analyzed must not re-invoke the LLM (see backend/PIPELINES.md).
    """
    row = conn.execute(
        """
        SELECT rule_summary, llm_text, sop_section_id, reasoning_steps
        FROM response_alerts
        WHERE event_id = %(event_id)s AND scenario_at = %(scenario_at)s
          AND alert_kind = %(alert_kind)s
        """,
        {"event_id": event_id, "scenario_at": scenario_at, "alert_kind": alert_kind},
    ).fetchone()
    if row is None:
        return None
    result = json.loads(row["rule_summary"])
    return Decision(
        triggered=result.get("triggered", True),
        sop_section_id=row["sop_section_id"],
        result=result.get("result", {}),
        reasoning=row["llm_text"] or "",
        source=result.get("source", "cache"),
    )


def save_decision(
    conn: psycopg.Connection,
    *,
    event_id: str,
    scenario_at: datetime,
    alert_kind: str,
    title: str,
    decision: Decision,
) -> None:
    """Caches a computed Decision keyed by (event_id, scenario_at, alert_kind).
    Upserts so re-evaluating (e.g. after a manual force-refresh) overwrites
    cleanly.
    """
    conn.execute(
        """
        INSERT INTO response_alerts
            (alert_id, event_id, alert_kind, title, rule_summary, llm_text,
             sop_section_id, reasoning_steps, scenario_at)
        VALUES (%(alert_id)s, %(event_id)s, %(alert_kind)s, %(title)s, %(rule_summary)s,
                %(llm_text)s, %(sop_section_id)s, %(reasoning_steps)s, %(scenario_at)s)
        ON CONFLICT (event_id, scenario_at, alert_kind) DO UPDATE SET
            rule_summary = EXCLUDED.rule_summary,
            llm_text = EXCLUDED.llm_text,
            sop_section_id = EXCLUDED.sop_section_id,
            title = EXCLUDED.title
        """,
        {
            "alert_id": f"ALT_{uuid.uuid4().hex[:12]}",
            "event_id": event_id,
            "alert_kind": alert_kind,
            "title": title,
            "rule_summary": json.dumps(
                {"triggered": decision.triggered, "result": decision.result, "source": decision.source},
                ensure_ascii=False,
            ),
            "llm_text": decision.reasoning,
            "sop_section_id": decision.sop_section_id,
            "reasoning_steps": "[]",
            "scenario_at": scenario_at,
        },
    )


def fetch_cached_congestion_decision(
    conn: psycopg.Connection, segment_id: str, scenario_at: datetime
) -> Optional[Decision]:
    """Cache lookup for GET /api/city-state's per-segment SOP §1 judgment --
    separate from fetch_cached_decision because this isn't tied to an
    incident (see congestion_decisions in schema.sql)."""
    row = conn.execute(
        """
        SELECT triggered, result, reasoning, source
        FROM congestion_decisions
        WHERE segment_id = %(segment_id)s AND scenario_at = %(scenario_at)s
        """,
        {"segment_id": segment_id, "scenario_at": scenario_at},
    ).fetchone()
    if row is None:
        return None
    return Decision(
        triggered=row["triggered"],
        sop_section_id="1" if row["triggered"] else None,
        result=row["result"],
        reasoning=row["reasoning"] or "",
        source=row["source"],
    )


def save_congestion_decision(
    conn: psycopg.Connection, *, segment_id: str, scenario_at: datetime, decision: Decision
) -> None:
    conn.execute(
        """
        INSERT INTO congestion_decisions (segment_id, scenario_at, triggered, result, reasoning, source)
        VALUES (%(segment_id)s, %(scenario_at)s, %(triggered)s, %(result)s, %(reasoning)s, %(source)s)
        ON CONFLICT (segment_id, scenario_at) DO UPDATE SET
            triggered = EXCLUDED.triggered,
            result = EXCLUDED.result,
            reasoning = EXCLUDED.reasoning,
            source = EXCLUDED.source
        """,
        {
            "segment_id": segment_id,
            "scenario_at": scenario_at,
            "triggered": decision.triggered,
            "result": json.dumps(decision.result, ensure_ascii=False),
            "reasoning": decision.reasoning,
            "source": decision.source,
        },
    )


def fetch_cached_crowd_decision(
    conn: psycopg.Connection, station_id: str, scenario_at: datetime, decision_kind: str
) -> Optional[Decision]:
    """Cache lookup for GET /api/city-state's per-station crowd judgments
    (SOP §3 mrt_diversion / §4 dome_dispersal / §6 multilingual) -- see
    crowd_decisions in schema.sql."""
    row = conn.execute(
        """
        SELECT triggered, result, reasoning, source
        FROM crowd_decisions
        WHERE station_id = %(station_id)s AND scenario_at = %(scenario_at)s
          AND decision_kind = %(decision_kind)s
        """,
        {"station_id": station_id, "scenario_at": scenario_at, "decision_kind": decision_kind},
    ).fetchone()
    if row is None:
        return None
    return Decision(
        triggered=row["triggered"],
        sop_section_id=None,
        result=row["result"],
        reasoning=row["reasoning"] or "",
        source=row["source"],
    )


def save_crowd_decision(
    conn: psycopg.Connection,
    *,
    station_id: str,
    scenario_at: datetime,
    decision_kind: str,
    decision: Decision,
) -> None:
    conn.execute(
        """
        INSERT INTO crowd_decisions (station_id, scenario_at, decision_kind, triggered, result, reasoning, source)
        VALUES (%(station_id)s, %(scenario_at)s, %(decision_kind)s, %(triggered)s, %(result)s, %(reasoning)s, %(source)s)
        ON CONFLICT (station_id, scenario_at, decision_kind) DO UPDATE SET
            triggered = EXCLUDED.triggered,
            result = EXCLUDED.result,
            reasoning = EXCLUDED.reasoning,
            source = EXCLUDED.source
        """,
        {
            "station_id": station_id,
            "scenario_at": scenario_at,
            "decision_kind": decision_kind,
            "triggered": decision.triggered,
            "result": json.dumps(decision.result, ensure_ascii=False),
            "reasoning": decision.reasoning,
            "source": decision.source,
        },
    )

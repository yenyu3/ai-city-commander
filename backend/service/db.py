"""PostgreSQL access layer for operational source-of-truth data (road/station
reference data, traffic/crowd snapshots, incidents).

Connects to the RDS instance provisioned by backend/terraform/ (or a local
Postgres for dev/test -- see backend/README.md's "本機 DB 測試" section).
Reads `DATABASE_URL` (postgresql://user:pass@host:port/dbname); in the real
Lambda deployment this would instead be assembled from
`DATABASE_SECRET_ARN` via Secrets Manager (not implemented here yet -- see
backend/terraform/compute.tf for the env var already wired in).

Decision *results* (the LLM/rules judgment cache) are not stored here --
see s3_cache.py, which caches Decision objects in S3 instead (2026-08-01:
moved off Postgres). This module only ever reads/writes RDS's own tables.

Query functions take an explicit `psycopg.Connection` rather than opening
their own, so callers (and tests) control the connection/transaction
lifecycle.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any, Optional

import psycopg
from psycopg.rows import dict_row

from rules.network_loader import build_segments_from_raw
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


def fetch_previous_traffic_timestamp(
    conn: psycopg.Connection, scenario_at: datetime
) -> Optional[datetime]:
    """The most recent sampled tick strictly before scenario_at, shared
    across every segment (city_traffic_flow.csv samples all 15 segments on
    the same tick) -- one query answers "what was the previous snapshot" for
    the whole city at once, rather than per-segment. None if scenario_at is
    at/before the first tick. Used to build the router agent's trend view
    (current vs. previous), not just a single point-in-time snapshot."""
    row = conn.execute(
        """
        SELECT DISTINCT observed_at FROM traffic_snapshots
        WHERE observed_at < %(scenario_at)s
        ORDER BY observed_at DESC LIMIT 1
        """,
        {"scenario_at": scenario_at},
    ).fetchone()
    return row["observed_at"] if row else None


def fetch_previous_crowd_timestamp(
    conn: psycopg.Connection, scenario_at: datetime
) -> Optional[datetime]:
    """Same idea as fetch_previous_traffic_timestamp, for crowd_snapshots."""
    row = conn.execute(
        """
        SELECT DISTINCT observed_at FROM crowd_snapshots
        WHERE observed_at < %(scenario_at)s
        ORDER BY observed_at DESC LIMIT 1
        """,
        {"scenario_at": scenario_at},
    ).fetchone()
    return row["observed_at"] if row else None


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
    """Reconstructs the RoadSegment graph from road_segments' inline columns
    (intersections jsonb, alternative_segment_ids/nearby_station_ids text[]
    -- the same flat shape road_network_geometry.json has, per
    load_demo_data.py's upsert). `intersections` holds raw upstream road
    *names*, not resolved segment_ids (name resolution -- including the
    None-preserving handling for unmatched names like 正氣橋 that
    accident_response.py's algorithm depends on -- is
    rules.network_loader.build_segments_from_raw's job, reused here instead
    of duplicated, so the DB-backed and file-backed loaders can't drift.
    """
    rows = conn.execute(
        "SELECT segment_id, name, flow_direction, capacity_vph, "
        "intersections, alternative_segment_ids, nearby_station_ids "
        "FROM road_segments"
    ).fetchall()
    raw = [
        {
            "segment_id": row["segment_id"],
            "name": row["name"],
            "flow_direction": row["flow_direction"],
            "capacity_vph": row["capacity_vph"],
            "intersections": row["intersections"],
            "alternatives": row["alternative_segment_ids"],
            "nearby_stations": row["nearby_station_ids"],
        }
        for row in rows
    ]
    return build_segments_from_raw(raw)


def fetch_active_incidents(
    conn: psycopg.Connection, scenario_at: datetime
) -> list[LiveIncident]:
    """Incidents that have occurred at-or-before scenario_at.

    Reconstructed from `source_payload` (the original flat event shape) --
    `rules.types.LiveIncident` mirrors that shape directly. Which
    segments/stations an incident touches lives only in `source_payload`
    (affected_segment/affected_road) -- there's no separate junction table
    (road/station impacts are 1:1 with an incident in this dataset, not
    many:many, so normalizing them added a join with no real query benefit).
    """
    rows = conn.execute(
        """
        SELECT event_id, incident_type, location, status, severity,
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
        SELECT event_id, incident_type, location, status, severity,
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
        location=payload.get("location", row["location"]),
        affected_segment=payload.get("affected_segment", ""),
        affected_road=payload.get("affected_road"),
        status=row["status"],
        severity=row["severity"],
        description=row["description"],
        timestamp=payload.get("timestamp", row["occurred_at"].isoformat()),
    )


def insert_incident(
    conn: psycopg.Connection, incident: LiveIncident, *, occurred_at: datetime
) -> None:
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
            (event_id, incident_type, location, affected_segment, affected_road,
             status, severity, description, occurred_at, source_payload)
        VALUES (%(event_id)s, %(incident_type)s, %(location)s, %(affected_segment)s,
                %(affected_road)s, %(status)s, %(severity)s, %(description)s,
                %(occurred_at)s, %(source_payload)s)
        ON CONFLICT (event_id) DO UPDATE SET
            status = EXCLUDED.status,
            severity = EXCLUDED.severity,
            description = EXCLUDED.description,
            source_payload = EXCLUDED.source_payload
        """,
        {
            "event_id": incident.event_id,
            "incident_type": incident.type,
            "location": incident.location,
            "affected_segment": incident.affected_segment,
            "affected_road": incident.affected_road,
            "status": incident.status,
            "severity": incident.severity,
            "description": incident.description,
            "occurred_at": occurred_at,
            "source_payload": json.dumps(source_payload, ensure_ascii=False),
        },
    )


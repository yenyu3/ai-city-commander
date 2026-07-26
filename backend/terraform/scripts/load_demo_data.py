#!/usr/bin/env python3
"""Create the PostgreSQL schema and load the AI City Commander demo dataset.

Usage:
    DATABASE_URL='postgresql://user:password@localhost:5432/ai_city' \
      python3 scripts/load_demo_data.py

The script is safe to run again: dimensions and facts are upserted by their
natural primary keys. It deliberately does not delete records that no longer
exist in the source files.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import psycopg
except ImportError as error:
    raise SystemExit(
        "Missing dependency: install it with `python3 -m pip install -r "
        "backend/terraform/scripts/requirements.txt`."
    ) from error


ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "frontend" / "public" / "data"
SCHEMA_FILE = ROOT / "backend" / "terraform" / "database" / "schema.sql"
TAIPEI_TZ = "+08:00"


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as file:
        return json.load(file)


def load_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as file:
        return list(csv.DictReader(file))


def taipei_timestamp(value: str) -> datetime:
    """Make the source's offset-less Taipei timestamp an aware datetime."""
    return datetime.fromisoformat(value.replace(" ", "T") + TAIPEI_TZ)


def number(value: str) -> float:
    return float(value.strip().removesuffix("%"))


def apply_schema(conn: psycopg.Connection[Any]) -> None:
    exists = conn.execute("SELECT to_regclass('public.road_segments')").fetchone()[0]
    if exists:
        return
    conn.execute(SCHEMA_FILE.read_text(encoding="utf-8"))


def load_road_network(conn: psycopg.Connection[Any]) -> dict[str, str]:
    roads = load_json(DATA / "road_network_geometry.json")
    paths = {
        item["segment_id"]: item for item in load_json(DATA / "road_paths.json")
    }
    name_to_id = {road["name"]: road["segment_id"] for road in roads}

    for road in roads:
        path = paths.get(road["segment_id"])
        route_geojson = (
            json.dumps({"type": "LineString", "coordinates": path["path"]})
            if path
            else None
        )
        conn.execute(
            """
            INSERT INTO road_segments (
              segment_id, name, flow_direction, capacity_vph, route_geojson,
              is_dashed_on_map
            ) VALUES (%s, %s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (segment_id) DO UPDATE SET
              name = EXCLUDED.name,
              flow_direction = EXCLUDED.flow_direction,
              capacity_vph = EXCLUDED.capacity_vph,
              route_geojson = EXCLUDED.route_geojson,
              is_dashed_on_map = EXCLUDED.is_dashed_on_map,
              updated_at = now()
            """,
            (
                road["segment_id"], road["name"], road["flow_direction"],
                road["capacity_vph"], route_geojson,
                path["dashed"] if path else False,
            ),
        )

    for road in roads:
        conn.execute(
            "DELETE FROM road_segment_intersection_refs WHERE segment_id = %s",
            (road["segment_id"],),
        )
        conn.execute(
            "DELETE FROM road_segment_alternatives WHERE segment_id = %s",
            (road["segment_id"],),
        )
        for sequence_no, road_name in enumerate(road["intersections"], start=1):
            conn.execute(
                """
                INSERT INTO road_segment_intersection_refs
                  (segment_id, sequence_no, intersecting_road_name, intersecting_segment_id)
                VALUES (%s, %s, %s, %s)
                """,
                (road["segment_id"], sequence_no, road_name, name_to_id.get(road_name)),
            )
        for priority, alternative_id in enumerate(road["alternatives"], start=1):
            conn.execute(
                """
                INSERT INTO road_segment_alternatives
                  (segment_id, alternative_segment_id, priority)
                VALUES (%s, %s, %s)
                """,
                (road["segment_id"], alternative_id, priority),
            )
    return name_to_id


def load_stations(conn: psycopg.Connection[Any]) -> None:
    crowd_rows = load_csv(DATA / "signaling_crowd_density.csv")
    names = {row["BS_ID"]: row["Location_Name"] for row in crowd_rows}
    coordinates = load_json(DATA / "station_coords.json")["stations"]

    for station_id in sorted(set(names) | set(coordinates)):
        longitude, latitude = coordinates.get(station_id, (None, None))
        conn.execute(
            """
            INSERT INTO stations (station_id, name, longitude, latitude)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (station_id) DO UPDATE SET
              name = EXCLUDED.name,
              longitude = EXCLUDED.longitude,
              latitude = EXCLUDED.latitude,
              updated_at = now()
            """,
            (station_id, names.get(station_id, station_id), longitude, latitude),
        )

    roads = load_json(DATA / "road_network_geometry.json")
    for road in roads:
        conn.execute(
            "DELETE FROM road_segment_nearby_stations WHERE segment_id = %s",
            (road["segment_id"],),
        )
        for station_id in road["nearby_stations"]:
            conn.execute(
                """
                INSERT INTO road_segment_nearby_stations (segment_id, station_id)
                VALUES (%s, %s)
                """,
                (road["segment_id"], station_id),
            )


def load_snapshots(conn: psycopg.Connection[Any]) -> None:
    for row in load_csv(DATA / "city_traffic_flow.csv"):
        conn.execute(
            """
            INSERT INTO traffic_snapshots (
              observed_at, segment_id, avg_speed_kph, vehicle_count,
              saturation_score, lane_status
            ) VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (observed_at, segment_id) DO UPDATE SET
              avg_speed_kph = EXCLUDED.avg_speed_kph,
              vehicle_count = EXCLUDED.vehicle_count,
              saturation_score = EXCLUDED.saturation_score,
              lane_status = EXCLUDED.lane_status,
              ingested_at = now()
            """,
            (
                taipei_timestamp(row["Timestamp"]), row["Segment_ID"],
                number(row["Avg_Speed"]), int(row["Vehicle_Count"]),
                number(row["Saturation_Score"]), row["Lane_Status"],
            ),
        )

    for row in load_csv(DATA / "signaling_crowd_density.csv"):
        conn.execute(
            """
            INSERT INTO crowd_snapshots (
              observed_at, station_id, user_count, stay_time_avg_minutes,
              growth_rate, roaming_user_pct
            ) VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (observed_at, station_id) DO UPDATE SET
              user_count = EXCLUDED.user_count,
              stay_time_avg_minutes = EXCLUDED.stay_time_avg_minutes,
              growth_rate = EXCLUDED.growth_rate,
              roaming_user_pct = EXCLUDED.roaming_user_pct,
              ingested_at = now()
            """,
            (
                taipei_timestamp(row["Timestamp"]), row["BS_ID"],
                int(row["User_Count"]), number(row["Stay_Time_Avg"]),
                number(row["Growth_Rate"]), number(row["Roaming_User_Pct"]) / 100,
            ),
        )


def load_incidents(conn: psycopg.Connection[Any]) -> None:
    for item in load_json(DATA / "live_incidents.json"):
        conn.execute(
            """
            INSERT INTO incidents (
              event_id, incident_type, location_description, status, severity,
              description, occurred_at, source_payload
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            ON CONFLICT (event_id) DO UPDATE SET
              incident_type = EXCLUDED.incident_type,
              location_description = EXCLUDED.location_description,
              status = EXCLUDED.status,
              severity = EXCLUDED.severity,
              description = EXCLUDED.description,
              occurred_at = EXCLUDED.occurred_at,
              source_payload = EXCLUDED.source_payload,
              updated_at = now()
            """,
            (
                item["event_id"], item["type"], item["location"], item["status"],
                item["severity"], item["description"], taipei_timestamp(item["timestamp"]),
                json.dumps(item, ensure_ascii=False),
            ),
        )
        conn.execute("DELETE FROM incident_road_impacts WHERE event_id = %s", (item["event_id"],))
        conn.execute("DELETE FROM incident_station_impacts WHERE event_id = %s", (item["event_id"],))

        affected_id = item["affected_segment"]
        if affected_id.startswith("RD_"):
            conn.execute(
                "INSERT INTO incident_road_impacts (event_id, segment_id) VALUES (%s, %s)",
                (item["event_id"], affected_id),
            )
        elif affected_id.startswith("BS_"):
            conn.execute(
                "INSERT INTO incident_station_impacts (event_id, station_id) VALUES (%s, %s)",
                (item["event_id"], affected_id),
            )
        else:
            raise ValueError(f"Unsupported affected_segment identifier: {affected_id}")

        affected_road = item.get("affected_road")
        if affected_road and affected_road != affected_id:
            conn.execute(
                """
                INSERT INTO incident_road_impacts (event_id, segment_id, impact_role)
                VALUES (%s, %s, 'secondary')
                ON CONFLICT (event_id, segment_id) DO UPDATE SET impact_role = EXCLUDED.impact_role
                """,
                (item["event_id"], affected_road),
            )


def load_sop(conn: psycopg.Connection[Any]) -> None:
    body = (DATA / "emergency_traffic_sop.txt").read_text(encoding="utf-8")
    conn.execute(
        """
        INSERT INTO sop_documents (document_name, version, body)
        VALUES ('emergency_traffic_sop', 'demo-2026-05-20', %s)
        ON CONFLICT (document_name, version) DO UPDATE SET body = EXCLUDED.body
        """,
        (body,),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--database-url", default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL connection URL (defaults to DATABASE_URL)",
    )
    args = parser.parse_args()
    if not args.database_url:
        parser.error("Set DATABASE_URL or pass --database-url.")

    with psycopg.connect(args.database_url) as conn:
        apply_schema(conn)
        load_road_network(conn)
        load_stations(conn)
        load_snapshots(conn)
        load_incidents(conn)
        load_sop(conn)

    print("Schema applied and demo data loaded successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""GET /api/city-state?scenarioAt={scenarioAt} -- see data/api.md §1.

Per the spec: raw traffic/crowd state as of scenarioAt, no SOP judgment
content. `tier` is the cheap deterministic threshold label
(rules/congestion_tier.py::get_tier(), pure arithmetic on saturation_score),
not a decide_congestion() LLM call -- that heavier per-location judgment now
lives behind GET /api/decisions (see ../decision/handler.py), queried
separately per locationId. This endpoint's only job is "what does RDS say
right now", cheap and always-fast.

Known gap (not solved here, see the merge plan this was built from): the
spec's API table has no "list active incidents" endpoint, so there's no
documented way for a caller to discover which locationIds even need a
GET /api/decisions follow-up call. Not inventing an undocumented field to
paper over this -- flagging it here so it's visible next time this is read.
"""
from __future__ import annotations

import logging
from typing import Any

import api_common
import db
from rules.congestion_tier import get_tier


logger = logging.getLogger(__name__)


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    query = event.get("queryStringParameters") or {}
    if "scenarioAt" not in query:
        return api_common.response(400, {"error": "missing query param: 'scenarioAt'"})
    try:
        scenario_at = api_common.parse_scenario_at(query["scenarioAt"])
    except ValueError:
        return api_common.response(400, {"error": f"invalid scenarioAt: {query['scenarioAt']!r}"})

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return api_common.response(503, {"error": str(exc)})

    try:
        traffic = db.fetch_latest_traffic_snapshots(conn, scenario_at)
        crowd = db.fetch_latest_crowd_snapshots(conn, scenario_at)
    except Exception:  # noqa: BLE001 - do not leak database details to API callers
        logger.exception("city_state database query failed")
        return api_common.response(503, {"error": "city-state data is temporarily unavailable"})
    finally:
        conn.close()

    logger.info(
        "city_state served scenario_at=%s traffic_count=%d crowd_count=%d",
        query["scenarioAt"],
        len(traffic),
        len(crowd),
    )

    return api_common.response(
        200,
        {
            "meta": {"scenarioAt": query["scenarioAt"], "generatedAt": api_common.now_iso(), "dataMode": "demo"},
            "traffic": [
                {
                    "segmentId": t.segment_id,
                    "observedAt": t.timestamp,
                    "avgSpeedKph": t.avg_speed,
                    "vehicleCount": t.vehicle_count,
                    "saturationScore": t.saturation_score,
                    "laneStatus": t.lane_status,
                    "tier": get_tier(t.saturation_score),
                }
                for t in traffic
            ],
            "crowd": [
                {
                    "stationId": c.station_id,
                    "observedAt": c.timestamp,
                    "userCount": c.user_count,
                    "stayTimeAvgMinutes": c.stay_time_avg,
                    "growthRate": c.growth_rate,
                    "roamingUserPct": c.roaming_pct,
                }
                for c in crowd
            ],
        },
    )

"""decision-generator-worker -- see data/api.md §7.

Two invocation shapes:

  Reactive: {"scenarioAt": "...", "locationId": "..."} -- fired by
    decision/handler.py (cache miss) or incident/handler.py (best-effort
    cache warm right after creation), via worker_invoke.invoke_async.
    Resolves the locationId with decision_routing, runs the matching
    decide_*() call, caches the result to S3.

  Scheduled: {"source": "eventbridge", "mode": "scheduled"} -- automation.tf's
    rate(5 minutes) EventBridge rule ("決策預先產生" per the doc's API table).
    Left as a documented no-op for now: this demo's whole model runs on a
    simulated `scenarioAt` supplied by the caller, not real wall-clock time,
    so a periodic wall-clock trigger has no obvious answer to "which
    scenario_at should I pre-generate for". Not inventing one -- doing so
    would be guessing at semantics the spec doesn't define for this demo's
    architecture. Acknowledges receipt and returns, same as this file's
    previous placeholder behavior.
"""
from __future__ import annotations

import json
from typing import Any

import db
from api_common import parse_scenario_at
from decision_routing import compute_and_cache, resolve_location


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if event.get("source") == "eventbridge":
        return {
            "statusCode": 200,
            "body": json.dumps({"status": "accepted", "source": "eventbridge", "mode": event.get("mode")}),
        }

    scenario_at_raw = event.get("scenarioAt")
    location_id = event.get("locationId")
    if not scenario_at_raw or not location_id:
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "reactive invocation needs 'scenarioAt' and 'locationId'"}),
        }

    scenario_at = parse_scenario_at(scenario_at_raw)

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return {"statusCode": 503, "body": json.dumps({"error": str(exc)})}
    try:
        route = resolve_location(conn, location_id, scenario_at)
        if route.kind == "unknown":
            return {"statusCode": 400, "body": json.dumps({"error": f"unrecognized locationId: {location_id!r}"})}
        decision = compute_and_cache(conn, route, location_id, scenario_at)
        conn.commit()
    finally:
        conn.close()

    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "status": "ready" if decision is not None else "failed",
                "locationId": location_id,
                "scenarioAt": scenario_at_raw,
                "triggered": decision.triggered if decision is not None else None,
            }
        ),
    }

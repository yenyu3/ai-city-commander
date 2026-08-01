"""decision-generator-worker -- see data/api.md §7 (2026-08-01: response
shape/invocation contract changed, see below -- I'll hand the user the exact
data/api.md diff separately rather than editing the doc myself).

Two invocation shapes:

  Reactive: {"scenarioAt": "...", "locationId": "..." | omitted,
    "forceRefresh": true | omitted} -- fired by decision/handler.py (cache
    miss) or incident/handler.py (best-effort cache warm right after
    creation), via worker_invoke.invoke_async. `locationId` is now optional
    -- omitted means "give me the city-wide view," not an error (2026-08-01
    redesign: the whole point is the agent sees every segment/station/
    incident in one shot regardless of what focus the caller asked about;
    `locationId` only steers which focused *narrative* gets generated, see
    decision_routing.py's module docstring for the full 3-phase pipeline).
    `forceRefresh` busts Phase A's cached sweep even if one already exists
    for this scenario_at -- used by incident/handler.py right after creating
    an incident, since a sweep cached moments earlier wouldn't know about it
    yet otherwise (known limitation, not silently papered over: only the
    caller that just changed the data knows to ask for this).

  Scheduled: {"source": "eventbridge", "mode": "scheduled"} -- automation.tf's
    rate(5 minutes) EventBridge rule ("決策預先產生" per the doc's API table).
    Left as a documented no-op for now: this demo's whole model runs on a
    simulated `scenarioAt` supplied by the caller, not real wall-clock time,
    so a periodic wall-clock trigger has no obvious answer to "which
    scenario_at should I sweep proactively". Not inventing one -- doing so
    would be guessing at semantics the spec doesn't define for this demo's
    architecture. Acknowledges receipt and returns, same as this file's
    previous placeholder behavior.
"""
from __future__ import annotations

import json
from typing import Any

import db
from api_common import parse_scenario_at
from decision_routing import run_worker_phases


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if event.get("source") == "eventbridge":
        return {
            "statusCode": 200,
            "body": json.dumps({"status": "accepted", "source": "eventbridge", "mode": event.get("mode")}),
        }

    scenario_at_raw = event.get("scenarioAt")
    if not scenario_at_raw:
        return {"statusCode": 400, "body": json.dumps({"error": "reactive invocation needs 'scenarioAt'"})}

    location_id = event.get("locationId")  # optional: None/omitted -> global view
    force_refresh = bool(event.get("forceRefresh"))
    scenario_at = parse_scenario_at(scenario_at_raw)

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return {"statusCode": 503, "body": json.dumps({"error": str(exc)})}
    try:
        pairs, _narrative = run_worker_phases(conn, scenario_at, location_id, force_refresh=force_refresh)
        conn.commit()
    finally:
        conn.close()

    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "status": "ready",
                "locationId": location_id,
                "scenarioAt": scenario_at_raw,
                "triggeredCount": len(pairs),
            }
        ),
    }

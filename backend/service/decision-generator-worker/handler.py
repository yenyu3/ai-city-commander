"""decision-generator-worker -- see data/api.md §7 (2026-08-01: response
shape/invocation contract changed, see below -- I'll hand the user the exact
data/api.md diff separately rather than editing the doc myself).

Two invocation shapes:

  Reactive -- which API invoked the worker decides decision vs incident
  (this is the whole point; never inferred from SOP kind or event_id):

    {"mode": "decision", "scenarioAt": "...", "locationId": "..." | omitted}
      fired by decision/handler.py on a cache miss. Runs the general city
      sweep (decision_routing.run_worker_phases): congestion/mrt/dome/
      multilingual only, written under decisions/{scenarioAt}/. `locationId`
      is optional -- omitted means "give me the city-wide view," not an error
      (the agent sees every segment/station/incident in one shot regardless;
      `locationId` only steers which focused narrative gets generated, see
      decision_routing.py's module docstring for the 3-phase pipeline).

    {"mode": "incident", "scenarioAt": "...", "eventId": "..."}
      fired by incident/handler.py right after creating an incident. Runs
      decision_routing.run_incident_flow for ONLY this event: its SOP
      judgment(s) written under incidents/{date}/{eventId}/decisions/... and
      the 交控中心建議書 under emergency-reports/, which
      GET /api/incidents/{eventId}/report then serves from S3. Never touches
      the decisions/ keyspace.

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
from api_common import decision_snapshot_at, parse_scenario_at
from decision_routing import run_incident_flow, run_worker_phases


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if event.get("source") == "eventbridge":
        return {
            "statusCode": 200,
            "body": json.dumps({"status": "accepted", "source": "eventbridge", "mode": event.get("mode")}),
        }

    scenario_at_raw = event.get("scenarioAt")
    if not scenario_at_raw:
        return {"statusCode": 400, "body": json.dumps({"error": "reactive invocation needs 'scenarioAt'"})}

    # Which API entry this came from decides what the worker computes and
    # where it writes (decision_routing.py). Default to "decision" so a
    # payload without `mode` keeps the historical city-sweep behavior.
    mode = event.get("mode", "decision")
    event_id = event.get("eventId")
    if mode == "incident" and not event_id:
        return {"statusCode": 400, "body": json.dumps({"error": "incident invocation needs 'eventId'"})}

    scenario_at = decision_snapshot_at(parse_scenario_at(scenario_at_raw))

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return {"statusCode": 503, "body": json.dumps({"error": str(exc)})}
    try:
        if mode == "incident":
            pairs = run_incident_flow(conn, scenario_at, event_id)
            conn.commit()
            result: dict[str, Any] = {
                "status": "ready",
                "mode": "incident",
                "eventId": event_id,
                "scenarioAt": scenario_at_raw,
                "resolvedScenarioAt": scenario_at.isoformat(),
                "triggeredCount": len(pairs),
            }
        else:
            location_id = event.get("locationId")  # optional: None/omitted -> global view
            pairs, _narrative = run_worker_phases(conn, scenario_at, location_id)
            conn.commit()
            result = {
                "status": "ready",
                "mode": "decision",
                "locationId": location_id,
                "scenarioAt": scenario_at_raw,
                "resolvedScenarioAt": scenario_at.isoformat(),
                "triggeredCount": len(pairs),
            }
    finally:
        conn.close()

    return {"statusCode": 200, "body": json.dumps(result)}

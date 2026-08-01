"""POST /api/incidents -- see data/api.md §2.

Creates the incident in RDS (operational source of truth), writes the raw
payload to S3 (internal-results/incidents/{date}/{eventId}.json, per the
doc's data flow), and best-effort warms the decision cache for this
scenario_at (see worker_invoke.py -- this is optional/non-blocking, not
required for correctness).

2026-08-01: the warm-up call no longer targets a single locationId --
decision-generator-worker now sweeps the whole city per scenario_at (see
decision_routing.py). It's called with `forceRefresh: true` because a sweep
for this exact scenario_at could already be cached from moments earlier
(e.g. someone polled GET /api/city-state just before this incident was
created) and wouldn't know about this brand-new incident otherwise --
without forcing, that stale sweep would silently miss it until a different
scenario_at happened to be queried. This is best-effort/non-blocking, same
as before -- if it fails, the next real GET /api/decisions call still
computes fresh (just without the head start).

Always returns 202 -- per the doc, this never waits for judgment/report/
publication to finish. `publication.status` stays "pending": there's no
emergency-report/notice-generation pipeline built yet (see report/handler.py
and publication/handler.py's own docstrings), so reporting it as "pending"
is honest; nothing here fabricates a "published" status.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import api_common
import db
import s3_common
import worker_invoke
from rules.types import LiveIncident


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    try:
        payload = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return api_common.response(400, {"error": "invalid JSON body"})

    context = payload.get("context", {})
    incident_payload = payload.get("incident")
    if "scenarioAt" not in context:
        return api_common.response(400, {"error": "missing field: 'context.scenarioAt'"})
    if incident_payload is None:
        return api_common.response(400, {"error": "missing field: 'incident'"})

    try:
        scenario_at = api_common.parse_scenario_at(context["scenarioAt"])
        occurred_at = (
            api_common.parse_scenario_at(incident_payload["occurredAt"])
            if incident_payload.get("occurredAt")
            else scenario_at
        )
        event_id = incident_payload["eventId"]
        affected_segment = incident_payload["affectedSegmentId"]
        incident = LiveIncident(
            event_id=event_id,
            type=incident_payload["type"],
            location=incident_payload["location"],
            affected_segment=affected_segment,
            status=incident_payload["status"],
            severity=incident_payload["severity"],
            description=incident_payload["description"],
            timestamp=occurred_at.isoformat(),
        )
    except KeyError as exc:
        return api_common.response(400, {"error": f"missing field: {exc}"})

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return api_common.response(503, {"error": str(exc)})
    try:
        db.insert_incident(conn, incident, occurred_at=occurred_at)
        conn.commit()
    finally:
        conn.close()

    date = occurred_at.date().isoformat()
    s3_common.client().put_object(
        Bucket=s3_common.internal_bucket(),
        Key=f"incidents/{date}/{event_id}.json",
        Body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
    )

    # Best-effort cache warm -- not required for correctness (a GET
    # /api/decisions that lands before this finishes just computes it itself
    # instead of hitting a warm cache). forceRefresh=True busts any sweep
    # already cached for this scenario_at that predates this incident.
    worker_invoke.invoke_async({"scenarioAt": context["scenarioAt"], "forceRefresh": True})

    generated_at = api_common.now_iso()
    return api_common.response(
        202,
        {
            "meta": {"scenarioAt": context["scenarioAt"], "generatedAt": generated_at, "dataMode": "demo"},
            "incident": incident_payload,
            "processing": {
                "jobId": f"ERJ_{event_id}",
                "status": "queued",
                "processor": "incident-decision-worker",
                "queuedAt": context["scenarioAt"],
            },
            "publication": {
                "status": "pending",
                "expectedNoticeId": f"PUB_{event_id}",
                "publicManifestUrl": f"/public/{date}/manifest.json",
            },
        },
    )

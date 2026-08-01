"""POST /api/incidents -- see data/api.md §2.

Creates the incident in RDS (operational source of truth), writes the raw
payload to S3 (internal-results/incidents/{date}/{eventId}.json, per the
doc's data flow), and best-effort warms this incident's judgment + report
(worker_invoke.py, mode="incident" -- see below; optional/non-blocking, not
required for correctness).

2026-08-01: the warm-up call is now `mode="incident"` with this incident's
eventId -- the shared worker (decision-generator-worker/handler.py) processes
ONLY this one event and writes its judgment + 交控中心建議書 (JSON+PDF) under
the incident's own S3 folder (incidents/{date}/{eventId}/decisions/... +
emergency-reports/), served by GET /api/incidents/{eventId}/report. It is
NOT the decision API's city sweep: which API invoked the worker decides
decision-vs-incident (see decision_routing.py's run_incident_flow). This is
best-effort/non-blocking, same as before -- if it fails, the report simply
isn't warm when the government queries it (still "processing").

Always returns 202: AI judgment, the internal report, AND the public notice
are all now produced asynchronously by the worker
(decision_routing.run_incident_flow -> _write_incident_report_and_notice),
once every one of this incident's SOP checks has finished -- NOT written
here in this handler's own thread anymore. That earlier version published a
templated one-liner notice immediately, before any real judgment existed;
the user's direction is the notice must carry the exact same
government/citizen/decisions shape GET /api/decisions returns (see
decision_item_json/summary_json), which only exists after the worker's SOP
checks complete. `publication.status` is honestly "pending" here for the
same reason -- nothing has been published yet at the time this response is
built.
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
    # instead of hitting a warm cache). mode="incident" tells the shared
    # worker to process ONLY this one event: compute its SOP judgment(s),
    # write the 交控中心建議書 (JSON+PDF) to emergency-reports/, AND publish
    # the public notice -- all three happen together once every check
    # finishes (see decision_routing.run_incident_flow /
    # _write_incident_report_and_notice). This is the incident API entry --
    # decision-vs-incident is decided by which API invoked the worker, not
    # by SOP kind (see decision_routing.py's run_incident_flow).
    worker_invoke.invoke_async({"mode": "incident", "scenarioAt": context["scenarioAt"], "eventId": event_id})

    generated_at = api_common.now_iso()
    notice_id = f"PUB_{event_id}_v1"
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
                "expectedNoticeId": notice_id,
                "publicManifestUrl": f"/{s3_common.public_manifest_key(date)}",
            },
        },
    )

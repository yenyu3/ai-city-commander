"""POST /api/incidents -- see data/api.md §2.

Creates the incident in RDS (operational source of truth), writes the raw
payload to S3 (internal-results/incidents/{date}/{eventId}.json, per the
doc's data flow), and best-effort warms this incident's judgment + report
(worker_invoke.py, mode="incident" -- see below; optional/non-blocking, not
required for correctness).

2026-08-01: the warm-up call is now `mode="incident"` with this incident's
eventId -- the shared worker (decision-generator-worker/handler.py) processes
ONLY this one event and writes its judgment + 交控中心建議書 under the
incident's own S3 folder (incidents/{date}/{eventId}/decisions/... +
emergency-reports/), served by GET /api/incidents/{eventId}/report. It is
NOT the decision API's city sweep: which API invoked the worker decides
decision-vs-incident (see decision_routing.py's run_incident_flow). This is
best-effort/non-blocking, same as before -- if it fails, the report simply
isn't warm when the government queries it (still "processing").

Always returns 202: AI judgment and the internal report remain asynchronous.
The public-safe notice and its daily manifest entry are written before the
response so citizen clients polling CloudFront can discover the event without
waiting for the longer internal decision/report pipeline.
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

    # Publish the public-safe notice immediately. Frontends poll this day's
    # CloudFront-served manifest and fetch this immutable notice by noticeId.
    notice_id = f"PUB_{event_id}_v1"
    public_notice = {
        "noticeId": notice_id,
        "alertId": event_id,
        "eventId": event_id,
        "publishedAt": context["scenarioAt"],
        "location": incident.location,
        "type": incident.type,
        "severity": incident.severity,
        "languages": ["zh"],
        "messages": {
            "zh": f"{incident.location}發生交通事件，請改道通行並預留額外時間。",
        },
    }
    manifest_key, notice_key = s3_common.publish_public_notice(
        date=date,
        notice_id=notice_id,
        alert_id=event_id,
        notice=public_notice,
    )

    # Best-effort cache warm -- not required for correctness (a GET
    # /api/decisions that lands before this finishes just computes it itself
    # instead of hitting a warm cache). mode="incident" tells the shared
    # worker to process ONLY this one event: compute its SOP judgment under
    # incidents/{date}/{eventId}/decisions/... and write the 交控中心建議書 to
    # emergency-reports/ (GET /api/incidents/{eventId}/report then serves it
    # from S3). This is the incident API entry -- decision-vs-incident is
    # decided by which API invoked the worker, not by SOP kind (see
    # decision_routing.py's run_incident_flow).
    worker_invoke.invoke_async({"mode": "incident", "scenarioAt": context["scenarioAt"], "eventId": event_id})

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
                "status": "published",
                "noticeId": notice_id,
                "publicManifestUrl": f"/{manifest_key}",
                "publicNoticeUrl": f"/{notice_key}",
            },
        },
    )

"""GET /api/incidents/{eventId}/report?format={format}&scenarioAt={scenarioAt}
-- see data/api.md §3.

Read-only: checks S3 for an already-generated report (emergency-reports/
{date}/{eventId}/report-v1.{format}), never re-runs SOP rules or calls an
LLM, per the doc. `{date}` isn't in the request -- looked up from the
incident's own `occurred_at` in RDS instead.

Always returns the doc's `202 processing` shape right now: nothing in this
codebase generates emergency-reports/ yet (that's a "Decision Worker Lambda"
the doc describes but that doesn't exist here) -- honestly reporting
"processing" forever is correct given that, not a bug to silently paper
over. Wire this up to 200+downloadUrl once a report-generation pipeline
exists.
"""
from __future__ import annotations

from typing import Any

import api_common
import db
import s3_common


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    event_id = (event.get("pathParameters") or {}).get("eventId")
    query = event.get("queryStringParameters") or {}
    if not event_id:
        return api_common.response(400, {"error": "missing path parameter: 'eventId'"})
    if query.get("format") not in ("json", "pdf"):
        return api_common.response(400, {"error": "query param 'format' must be 'json' or 'pdf'"})

    try:
        conn = db.connect()
    except RuntimeError as exc:
        return api_common.response(503, {"error": str(exc)})
    try:
        incident = db.fetch_incident(conn, event_id)
    finally:
        conn.close()

    retrieved_at = api_common.now_iso()
    meta = {"scenarioAt": query.get("scenarioAt"), "retrievedAt": retrieved_at, "dataMode": "demo"}

    if incident is None:
        return api_common.response(404, {"meta": meta, "error": {"code": "INCIDENT_NOT_FOUND", "eventId": event_id}})

    date = incident.timestamp.split("T")[0].split(" ")[0]
    key = f"emergency-reports/{date}/{event_id}/report-v1.{query['format']}"
    try:
        s3_common.client().head_object(Bucket=s3_common.internal_bucket(), Key=key)
        exists = True
    except Exception:  # noqa: BLE001 - any head_object failure means "not ready", not a hard error
        exists = False

    if not exists:
        return api_common.response(
            202,
            {
                "meta": meta,
                "report": {
                    "eventId": event_id,
                    "jobId": f"ERJ_{event_id}",
                    "status": "processing",
                    "retryAfterSeconds": 3,
                },
            },
        )

    return api_common.response(
        200,
        {
            "meta": {**meta, "source": "internal_report"},
            "report": {
                "eventId": event_id,
                "jobId": f"ERJ_{event_id}",
                "status": "ready",
                "version": "v1",
                "format": query["format"],
                "generatedAt": retrieved_at,
                "downloadUrl": f"/internal/{key}",
            },
        },
    )

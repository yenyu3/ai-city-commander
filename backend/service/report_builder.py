"""Builds the "交控中心建議書" (traffic control center recommendation report)
required by the competition brief's 必做 "自動化指令產出" task, and writes it
to S3 -- the exact key report/handler.py polls for (data/api.md §3).

Called only from decision_routing.run_incident_flow -- the incident API
entry (POST /api/incidents -> worker, `mode="incident"`), right after an
injected event's SOP §2/§3/§5 judgment comes back triggered. The decision
API's city sweep (run_worker_phases) never calls this -- decision-vs-incident
is decided by which API invoked the worker (see decision_routing.py). The
write happens so a report exists by the time the government polls
GET /api/incidents/{eventId}/report -- report/handler.py itself stays
read-only, per its own docstring. Congestion (SOP §1) and the multilingual
batch (SOP §6) never key a report under this endpoint per the doc anyway
(congestion shows via the dashboard tier/color, multilingual via
publication/handler.py's citizen notice instead).

Only ever writes the JSON format; report/handler.py's `format=pdf` stays
perpetually "processing" (out of scope -- the brief allows any report format,
so JSON alone already satisfies "報告呈現格式不拘").
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

import s3_common
from agent.decision_agent import Decision
from rules.types import LiveIncident


def build_and_save_report(*, incident: LiveIncident, decision: Decision, scenario_at: datetime) -> None:
    date = incident.timestamp.split("T")[0].split(" ")[0]
    report: dict[str, Any] = {
        "eventId": incident.event_id,
        "sopSectionId": decision.sop_section_id,
        "generatedAt": scenario_at.isoformat(),
        "incident": {
            "type": incident.type,
            "location": incident.location,
            "affectedSegment": incident.affected_segment,
            "status": incident.status,
            "severity": incident.severity,
            "description": incident.description,
        },
        "classification": decision.result,
        "reasoning": decision.reasoning,
        "publicMessage": decision.public_message,
        "source": decision.source,
    }
    s3_common.client().put_object(
        Bucket=s3_common.internal_bucket(),
        Key=f"emergency-reports/{date}/{incident.event_id}/report-v1.json",
        Body=json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
    )

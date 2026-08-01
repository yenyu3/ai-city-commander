"""S3-backed cache for LLM/rules decision results (2026-08-01: moved off
Postgres -- see backend/README.md's "決策快取（S3）" section for why).

RDS (db.py) stays the operational source of truth for road/station/
snapshot/incident data; this module is purely a
(scenario_at, location_id[, kind]) -> Decision cache, one JSON object per
key, matching data/api.md's internal-results bucket layout:

    decisions/{scenario_at}/{segment_id}.json                  congestion (SOP §1)
    decisions/{scenario_at}/{station_id}__{decision_kind}.json mrt/dome diversion (SOP §3/§4)
    decisions/{scenario_at}/all.json                            multilingual (SOP §6, batched across all stations)
    decisions/{scenario_at}/{event_id}__{alert_kind}.json      incident SOP checks (SOP §2/§5)

`:` in scenario_at's ISO8601 string is replaced with `-` (S3 keys allow
colons, but some HTTP clients/tools handle them poorly) -- mirrors the
`2026-05-20T22-10-00+08-00` example in data/api.md.

Auth is the same IAM Role as agent/llm_client.py::BedrockLLMClient -- no
credential is read or stored here; boto3 resolves the caller's identity via
the standard AWS credential chain (Lambda execution role in prod, local
`aws configure`/`AWS_PROFILE` for dev).
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

import s3_common
from agent.decision_agent import Decision

# SOP §6's multilingual judgment runs once per poll across every visible
# station, not per station -- "all" names that it's the one cross-cutting
# decision for this scenario_at, not a specific location.
_MULTILINGUAL_LOCATION_ID = "all"


def _key(scenario_at: datetime, location_id: str) -> str:
    at = scenario_at.isoformat().replace(":", "-")
    return f"decisions/{at}/{location_id}.json"


def _crowd_location_id(station_id: str, decision_kind: str) -> str:
    if decision_kind == "multilingual":
        return _MULTILINGUAL_LOCATION_ID
    return f"{station_id}__{decision_kind}"


def _incident_location_id(event_id: str, alert_kind: str) -> str:
    return f"{event_id}__{alert_kind}"


def _decision_from_json(payload: dict) -> Decision:
    return Decision(
        triggered=payload["triggered"],
        sop_section_id=payload.get("sopSectionId"),
        result=payload.get("result", {}) or {},
        reasoning=payload.get("reasoning", ""),
        source=payload.get("source", "cache"),
        public_message=payload.get("publicMessage", ""),
    )


def _decision_to_json(decision: Decision, *, title: Optional[str] = None) -> dict:
    payload = {
        "triggered": decision.triggered,
        "sopSectionId": decision.sop_section_id,
        "result": decision.result,
        "reasoning": decision.reasoning,
        "publicMessage": decision.public_message,
        "source": decision.source,
    }
    if title is not None:
        payload["title"] = title
    return payload


def _fetch(location_id: str, scenario_at: datetime) -> Optional[Decision]:
    from botocore.exceptions import ClientError

    try:
        obj = s3_common.client().get_object(Bucket=s3_common.internal_bucket(), Key=_key(scenario_at, location_id))
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        raise
    payload = json.loads(obj["Body"].read())
    return _decision_from_json(payload)


def _save(location_id: str, scenario_at: datetime, decision: Decision, *, title: Optional[str] = None) -> None:
    body = json.dumps(_decision_to_json(decision, title=title), ensure_ascii=False).encode("utf-8")
    s3_common.client().put_object(
        Bucket=s3_common.internal_bucket(),
        Key=_key(scenario_at, location_id),
        Body=body,
        ContentType="application/json; charset=utf-8",
    )


# --- SOP §1: per-segment congestion tier (GET /api/city-state) -------------


def fetch_cached_congestion_decision(segment_id: str, scenario_at: datetime) -> Optional[Decision]:
    return _fetch(segment_id, scenario_at)


def save_congestion_decision(*, segment_id: str, scenario_at: datetime, decision: Decision) -> None:
    _save(segment_id, scenario_at, decision)


# --- SOP §3/§4/§6: per-station crowd judgments (GET /api/city-state) -------


def fetch_cached_crowd_decision(
    station_id: str, scenario_at: datetime, decision_kind: str
) -> Optional[Decision]:
    return _fetch(_crowd_location_id(station_id, decision_kind), scenario_at)


def save_crowd_decision(
    *, station_id: str, scenario_at: datetime, decision_kind: str, decision: Decision
) -> None:
    _save(_crowd_location_id(station_id, decision_kind), scenario_at, decision)


# --- SOP §2/§5: per-incident checks (POST /api/incidents/{id}/evaluate) ----


def fetch_cached_decision(event_id: str, scenario_at: datetime, alert_kind: str) -> Optional[Decision]:
    return _fetch(_incident_location_id(event_id, alert_kind), scenario_at)


def save_decision(
    *, event_id: str, scenario_at: datetime, alert_kind: str, title: str, decision: Decision
) -> None:
    _save(_incident_location_id(event_id, alert_kind), scenario_at, decision, title=title)

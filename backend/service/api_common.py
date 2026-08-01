"""Tiny helpers shared by every per-service Lambda handler (backend/service/
{city_state,incident,decision,chat,publication,report,decision-generator-worker}/
handler.py) -- API Gateway response envelope + scenarioAt parsing, nothing
route-specific.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

_JSON_HEADERS = {"content-type": "application/json; charset=utf-8"}


def response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": _JSON_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }


def parse_scenario_at(raw: str) -> datetime:
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

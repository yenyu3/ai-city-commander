"""API Gateway (HTTP API, payload format 2.0) Lambda handler.

Routes, declared in backend/terraform/api_gateway.tf:
  GET  /api/health
  GET  /api/schema
  POST /api/agent

/api/agent request body shape: {"action": "...", ...action-specific fields}.
See _handle_agent below for the three actions currently implemented. Every
action falls back to canned text when no LLM is configured yet (see
agent/llm_client.py) -- it never 500s for lack of credentials.
"""
from __future__ import annotations

import json
from typing import Any

from agent.narrator import StructuredEvent, answer_what_if, generate_multilingual, summarize

_JSON_HEADERS = {"content-type": "application/json; charset=utf-8"}


def _response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": _JSON_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }


def _handle_health() -> dict[str, Any]:
    return _response(200, {"message": "AI City Commander API is running"})


def _handle_schema() -> dict[str, Any]:
    return _response(
        200,
        {
            "actions": ["summarize", "answer_what_if", "generate_multilingual"],
            "note": "See backend/service/agent/narrator.py for request/response shapes.",
        },
    )


def _handle_agent(event: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "invalid JSON body"})

    action = payload.get("action")

    if action == "summarize":
        try:
            structured = StructuredEvent(
                kind=payload["kind"],
                title=payload.get("title", ""),
                data=payload.get("data", {}),
                sop_ref=payload.get("sopRef"),
            )
        except KeyError as exc:
            return _response(400, {"error": f"missing field: {exc}"})
        return _response(200, {"text": summarize(structured)})

    if action == "answer_what_if":
        if "question" not in payload:
            return _response(400, {"error": "missing field: 'question'"})
        text = answer_what_if(
            payload["question"],
            payload.get("ruleResult"),
            payload.get("sopExcerpt", ""),
        )
        return _response(200, {"text": text})

    if action == "generate_multilingual":
        if "messageType" not in payload:
            return _response(400, {"error": "missing field: 'messageType'"})
        messages = generate_multilingual(payload["messageType"], payload.get("values", {}))
        return _response(200, {"messages": messages})

    return _response(400, {"error": f"unknown action: {action!r}"})


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "")

    if path.endswith("/api/health"):
        return _handle_health()
    if path.endswith("/api/schema"):
        return _handle_schema()
    if path.endswith("/api/agent") and method == "POST":
        return _handle_agent(event)

    return _response(404, {"error": "not found"})

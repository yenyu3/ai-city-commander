"""Fires decision-generator-worker asynchronously -- used by incident/
handler.py (best-effort cache warm right after an incident is created) and
decision/handler.py (data/api.md §4's cache-aside flow: on a cache miss,
kick off the worker and return 202 without waiting for it).

In a real deployment, uses boto3's Lambda Invoke with
InvocationType="Event" (fire-and-forget -- the caller's own Lambda returns
immediately, the worker runs as a separate invocation). Locally, there's no
separate Lambda process to invoke, so it loads decision-generator-worker/
handler.py directly (by file path, since the directory name has a hyphen
and isn't a valid Python package name) and runs it in a background thread,
close enough to real async semantics for local dev.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
from typing import Any

_WORKER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "decision-generator-worker")
_WORKER_MODULE_NAME = "decision_generator_worker_handler"


def _load_worker_handler():
    if _WORKER_MODULE_NAME in sys.modules:
        return sys.modules[_WORKER_MODULE_NAME].handler
    spec = importlib.util.spec_from_file_location(
        _WORKER_MODULE_NAME, os.path.join(_WORKER_DIR, "handler.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[_WORKER_MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module.handler


def invoke_async(payload: dict[str, Any]) -> None:
    """Best-effort: a failure here must never break the caller's response --
    worst case, the next GET /api/decisions call for this locationId just
    does the compute-and-cache itself instead of finding a warm cache."""
    try:
        function_name = os.environ.get("DECISION_GENERATOR_WORKER_FUNCTION_NAME")
        if function_name:
            import boto3

            boto3.client("lambda").invoke(
                FunctionName=function_name,
                InvocationType="Event",
                Payload=json.dumps(payload).encode("utf-8"),
            )
            return
        handler_fn = _load_worker_handler()
        threading.Thread(target=handler_fn, args=(payload, None), daemon=True).start()
    except Exception:  # noqa: BLE001 - best-effort cache warm, never fail the caller over this
        pass

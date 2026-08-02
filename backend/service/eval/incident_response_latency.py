"""Measures incident response latency -- the worker's actual compute time
for one injected event, from `run_incident_flow()`'s SOP checks through the
交控中心建議書 (JSON+PDF) and public notice write, against the competition
brief's "60 秒內完成路網重規劃" (60-second replan) requirement.

Calls decision_routing.run_incident_flow() directly and times it, rather
than hitting POST /api/incidents and polling GET /api/incidents/{eventId}/
report -- polling would mostly measure poll-interval noise, not actual
compute time, since the API layer is fire-and-forget (see incident/
handler.py). This is the same function decision-generator-worker/handler.py
calls in mode="incident", so the timing is the real worker's real cost, not
a proxy.

Unlike decision_latency.py (the decision API's city sweep), no cache needs
clearing before each measurement: run_incident_flow() always recomputes
every SOP check fresh on every call (write-through to S3, not cache-aside --
see its own docstring), so every run here is already a genuine cold
measurement.

Uses the three real seeded incidents in data/live_incidents.json --
TPE_2026_ACC_001 (§2 accident), TPE_2026_EVT_002 (§3 mrt_diversion, since
its affected_segment BS_MRT_BL17 is a crowd-monitored station),
TPE_2026_EVT_003 (§5 signal_failure) -- covering the three incident-tied SOP
paths run_incident_flow can take, not synthetic data.

Requires a real LLM configured -- without one, every check falls through to
the deterministic rules/ fallback, which is near-instant and would only
measure DB/S3 round-trip time, not the LLM-call-bound latency this is meant
to characterize.

Usage (from backend/service/, with DATABASE_URL, INTERNAL_RESULTS_BUCKET,
and an LLM configured):

    python3 -m eval.incident_response_latency
    python3 -m eval.incident_response_latency --scenario-at "2026-05-20T22:30:00+08:00" --repeat 3
"""
from __future__ import annotations

import argparse
import time

import api_common
import db
from decision_routing import run_incident_flow

_SEEDED_EVENT_IDS = ["TPE_2026_ACC_001", "TPE_2026_EVT_002", "TPE_2026_EVT_003"]


def _time_one_incident(conn, scenario_at, event_id: str) -> tuple[float, int]:
    started = time.monotonic()
    pairs = run_incident_flow(conn, scenario_at, event_id)
    conn.commit()
    return time.monotonic() - started, len(pairs)


def evaluate(event_ids: list[str], scenario_at_str: str, repeat: int = 1) -> list[tuple[str, float, int]]:
    conn = db.connect()
    try:
        scenario_at = api_common.parse_scenario_at(scenario_at_str)
        results = []
        for event_id in event_ids:
            for i in range(repeat):
                elapsed, triggered_count = _time_one_incident(conn, scenario_at, event_id)
                results.append((event_id, elapsed, triggered_count))
                print(f"  {event_id} (run {i + 1}/{repeat}): {elapsed:.2f}s, {triggered_count} SOP article(s) triggered")
        return results
    finally:
        conn.close()


def _percentile(sorted_values: list[float], pct: float) -> float:
    if not sorted_values:
        return float("nan")
    k = (len(sorted_values) - 1) * pct
    f, c = int(k), min(int(k) + 1, len(sorted_values) - 1)
    if f == c:
        return sorted_values[f]
    return sorted_values[f] + (sorted_values[c] - sorted_values[f]) * (k - f)


def summarize(results: list[tuple[str, float, int]], *, budget_seconds: float = 60.0) -> None:
    if not results:
        print("No measurements collected.")
        return
    durations = sorted(elapsed for _event_id, elapsed, _count in results)
    p50 = _percentile(durations, 0.50)
    p95 = _percentile(durations, 0.95)
    over_budget = sum(1 for d in durations if d > budget_seconds)

    print()
    print(f"Runs measured    : {len(durations)}")
    print(f"Min / Max        : {min(durations):.2f}s / {max(durations):.2f}s")
    print(f"p50              : {p50:.2f}s")
    print(f"p95              : {p95:.2f}s")
    print(f"Over {budget_seconds:.0f}s budget  : {over_budget}/{len(durations)}")

    zero_trigger = [event_id for event_id, _elapsed, count in results if count == 0]
    if zero_trigger:
        print()
        print(f"No SOP article triggered for: {', '.join(zero_trigger)} (unexpected for these seeded incidents)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario-at", default="2026-05-20T22:30:00+08:00",
        help="scenario time to evaluate each seeded incident at (all three occurred before this by default)",
    )
    parser.add_argument("--repeat", type=int, default=1, help="repetitions per incident (default 1)")
    parser.add_argument("--budget-seconds", type=float, default=60.0)
    args = parser.parse_args()

    results = evaluate(_SEEDED_EVENT_IDS, args.scenario_at, repeat=args.repeat)
    summarize(results, budget_seconds=args.budget_seconds)


if __name__ == "__main__":
    main()

"""Measures end-to-end decision-generation latency (p50/p95/p99) -- the
worker's actual compute time from a cold cache to a fully-populated
decisions/{scenarioAt}/ sweep, directly against the competition brief's "60
秒內完成路網重規劃" (60-second replan) requirement.

Calls decision_routing.run_worker_phases() directly and times it, rather
than hitting GET /api/decisions and polling for a 200 -- polling would
mostly measure poll-interval noise, not actual compute time, since the API
layer is fire-and-forget (see decision/handler.py). This is the same
function decision-generator-worker/handler.py calls in mode="decision", so
the timing is the real worker's real cost, not a proxy.

Each repetition clears the previous run's cache first (reusing
clear_cache.py's S3-key-clearing logic) so every measurement is a genuine
cold-cache computation, not a cache hit -- repeated runs at the SAME
scenario_at would otherwise just measure S3 GET latency after the first one.

Requires a real LLM configured -- without one, every run falls through to
the deterministic rules/ fallback, which is near-instant and would only
measure DB/S3 round-trip time, not the LLM-call-bound latency this is meant
to characterize.

Usage (from backend/service/, with DATABASE_URL, INTERNAL_RESULTS_BUCKET,
and an LLM configured):

    python3 -m eval.decision_latency --scenario-at "2026-05-20T22:10:00+08:00" --repeat 5
    python3 -m eval.decision_latency --all-timestamps  # once per real dataset timestamp
"""
from __future__ import annotations

import argparse
import time

import api_common
import db
import s3_common
from clear_cache import _list_keys
from decision_routing import run_worker_phases

_PREFIX = "decisions/"


def _clear_slot(scenario_at) -> None:
    at_prefix = f"{_PREFIX}{scenario_at.isoformat().replace(':', '-')}/"
    keys = _list_keys(at_prefix)
    if not keys:
        return
    client = s3_common.client()
    bucket = s3_common.internal_bucket()
    client.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in keys]})


def _time_one_sweep(conn, scenario_at) -> float:
    _clear_slot(scenario_at)
    started = time.monotonic()
    run_worker_phases(conn, scenario_at, location_id=None)
    conn.commit()
    return time.monotonic() - started


def evaluate(scenario_ats: list, repeat: int = 1) -> list[float]:
    conn = db.connect()
    try:
        durations = []
        for scenario_at in scenario_ats:
            for i in range(repeat):
                elapsed = _time_one_sweep(conn, scenario_at)
                durations.append(elapsed)
                print(f"  {scenario_at} (run {i + 1}/{repeat}): {elapsed:.2f}s")
        return durations
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


def summarize(durations: list[float], *, budget_seconds: float = 60.0) -> None:
    if not durations:
        print("No measurements collected.")
        return
    sorted_durations = sorted(durations)
    p50 = _percentile(sorted_durations, 0.50)
    p95 = _percentile(sorted_durations, 0.95)
    p99 = _percentile(sorted_durations, 0.99)
    over_budget = sum(1 for d in durations if d > budget_seconds)

    print()
    print(f"Runs measured    : {len(durations)}")
    print(f"Min / Max        : {min(durations):.2f}s / {max(durations):.2f}s")
    print(f"p50              : {p50:.2f}s")
    print(f"p95              : {p95:.2f}s")
    print(f"p99              : {p99:.2f}s")
    print(f"Over {budget_seconds:.0f}s budget  : {over_budget}/{len(durations)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario-at", help="ISO8601 scenario time to repeat-measure")
    parser.add_argument("--repeat", type=int, default=3, help="repetitions per scenario_at (default 3)")
    parser.add_argument(
        "--all-timestamps", action="store_true",
        help="measure once per distinct timestamp actually present in the demo dataset",
    )
    parser.add_argument("--budget-seconds", type=float, default=60.0)
    args = parser.parse_args()

    if args.all_timestamps:
        conn = db.connect()
        try:
            rows = conn.execute(
                "SELECT DISTINCT observed_at FROM traffic_snapshots ORDER BY observed_at"
            ).fetchall()
            scenario_ats = [row["observed_at"] for row in rows]
        finally:
            conn.close()
        durations = evaluate(scenario_ats, repeat=1)
    elif args.scenario_at:
        scenario_at = api_common.parse_scenario_at(args.scenario_at)
        durations = evaluate([scenario_at], repeat=args.repeat)
    else:
        parser.error("need --scenario-at or --all-timestamps")
        return

    summarize(durations, budget_seconds=args.budget_seconds)


if __name__ == "__main__":
    main()

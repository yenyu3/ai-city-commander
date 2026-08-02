"""Compares the LLM judgment path (agent/facts.py's decide_*()) against its
own deterministic fallback (rules/*.py) across every real timestamp in the
demo dataset -- i.e. "does the LLM actually understand the SOP thresholds it
was given the full text of, or does it disagree with the ground-truth
arithmetic". This is a genuinely useful accuracy claim: `rules/` is a
faithful, tested port of the SOP's own numeric thresholds (see
tests/test_rules.py), so it's a legitimate ground truth to score the LLM's
triggered/tier/section decisions against -- not a proxy or approximation.

Requires a real LLM configured (BEDROCK_MODEL_ID/ANTHROPIC_API_KEY/
OMNIROUTE_BASE_URL) -- without one, decide_*() calls its OWN fallback (the
same rules/ functions), so LLM vs rules would trivially agree 100% of the
time and the comparison would be meaningless.

Scores each SOP article independently (§1 congestion, §3 mrt_diversion, §4
dome_dispersal, §5 signal_failure, §6 multilingual) with a confusion matrix
over `triggered` (true/false), plus tier agreement for §1 specifically (SOP
§1 has three tiers, not just triggered/not). §2 (accident) is scored
separately since its ground truth is triggered + which main_route was
selected, not just a boolean.

2026-08-02: every decide_*() call is an independent LLM call with no shared
state, so they're dispatched through a ThreadPoolExecutor instead of a plain
sequential loop -- same rationale (and same _MAX_PARALLEL ceiling) as
decision_routing.py's _ensure_decisions. Only DB reads (db.fetch_latest_
traffic_snapshots/fetch_latest_crowd_snapshots/fetch_crowd_history/
fetch_active_incidents) stay on the main thread first, building a flat list
of "work items" -- psycopg connections aren't thread-safe, so `conn` is
never touched from inside a worker. Scoring (mutating the shared
_ArticleScore dict) also stays on the main thread, after every future has
resolved, for the same reason. This cut a real run from ~15 sequential
minutes (one segment/station at a time) to a few minutes.

Usage (from backend/service/, with DATABASE_URL and an LLM configured):

    python3 -m eval.llm_vs_rules_consistency
    python3 -m eval.llm_vs_rules_consistency --limit 5
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Callable

import db
from agent.facts import decide_accident, decide_congestion, decide_dome_dispersal, decide_mrt_diversion, decide_multilingual, decide_signal_failure
from rules import accident_response as _rules_accident
from rules import congestion_tier as _rules_congestion
from rules import dome_dispersal as _rules_dome
from rules import mrt_diversion as _rules_mrt
from rules import multilingual_check as _rules_multilingual
from rules import signal_failure as _rules_signal

# Bounded so a large demo dataset doesn't open an unbounded number of
# concurrent LLM calls -- same ceiling as decision_routing.py's
# _MAX_PARALLEL_DECISIONS, for the same reason (comfortable headroom over
# what's actually been observed, capping worst-case fan-out).
_MAX_PARALLEL = 20


@dataclass
class _ArticleScore:
    true_positive: int = 0
    true_negative: int = 0
    false_positive: int = 0  # LLM says triggered, rules/ says not
    false_negative: int = 0  # LLM says not triggered, rules/ says triggered
    tier_mismatches: list[str] = field(default_factory=list)  # §1 only: same triggered, different tier

    @property
    def total(self) -> int:
        return self.true_positive + self.true_negative + self.false_positive + self.false_negative

    @property
    def agreement_rate(self) -> float:
        return (self.true_positive + self.true_negative) / self.total if self.total else float("nan")

    def record(self, llm_triggered: bool, rules_triggered: bool) -> None:
        if llm_triggered and rules_triggered:
            self.true_positive += 1
        elif not llm_triggered and not rules_triggered:
            self.true_negative += 1
        elif llm_triggered and not rules_triggered:
            self.false_positive += 1
        else:
            self.false_negative += 1


def _run_parallel(label: str, jobs: list[Callable[[], Any]]) -> list[Any]:
    """Runs every job (each a zero-arg closure doing one decide_*() call) in
    a bounded thread pool, printing progress as each completes (not as each
    is dispatched, since completion order isn't submission order under a
    pool). Returns results in the SAME order as `jobs`, not completion
    order, so callers can zip them back against whatever context built each
    job."""
    results: list[Any] = [None] * len(jobs)
    print(f"  {label}: {len(jobs)} LLM call(s), up to {_MAX_PARALLEL} in parallel...", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=min(_MAX_PARALLEL, len(jobs) or 1)) as pool:
        future_to_index = {pool.submit(job): i for i, job in enumerate(jobs)}
        done = 0
        for future in as_completed(future_to_index):
            results[future_to_index[future]] = future.result()
            done += 1
            if done % 20 == 0 or done == len(jobs):
                print(f"    {label}: {done}/{len(jobs)} done", file=sys.stderr, flush=True)
    return results


def _score_congestion(conn, timestamps, scores: dict[str, _ArticleScore]) -> None:
    score = scores["§1 congestion"]
    items = [(scenario_at, t) for scenario_at in timestamps for t in db.fetch_latest_traffic_snapshots(conn, scenario_at)]

    def job(scenario_at, t):
        def run():
            llm = decide_congestion(t.segment_id, t.road_name, t.saturation_score)
            rules_tier = _rules_congestion.get_tier(t.saturation_score)
            rules_city = _rules_congestion.check_city_response(t.segment_id, rules_tier)
            return llm, rules_tier, rules_city is not None
        return run

    results = _run_parallel("§1 congestion", [job(scenario_at, t) for scenario_at, t in items])
    for (scenario_at, t), (llm, rules_tier, rules_triggered) in zip(items, results):
        score.record(llm.triggered, rules_triggered)
        if llm.triggered and rules_triggered:
            llm_tier = llm.result.get("tier")
            if llm_tier != rules_tier:
                score.tier_mismatches.append(
                    f"{scenario_at} {t.segment_id}: LLM said {llm_tier!r}, rules/ said {rules_tier!r} "
                    f"(saturation={t.saturation_score})"
                )


def _score_multilingual(conn, timestamps, scores: dict[str, _ArticleScore]) -> None:
    score = scores["§6 multilingual"]
    per_tick_stations = [db.fetch_latest_crowd_snapshots(conn, scenario_at) for scenario_at in timestamps]
    ticks_with_stations = [stations for stations in per_tick_stations if stations]

    results = _run_parallel(
        "§6 multilingual", [(lambda stations=stations: decide_multilingual(stations)) for stations in ticks_with_stations]
    )
    for stations, llm in zip(ticks_with_stations, results):
        llm_flagged = set(llm.result.get("stations") or [])
        rules_flagged = {s.station_id for s in _rules_multilingual.check_multilingual_needed(stations)}
        for s in stations:
            score.record(s.station_id in llm_flagged, s.station_id in rules_flagged)


def _score_mrt_and_dome(conn, timestamps, scores: dict[str, _ArticleScore]) -> None:
    mrt_score = scores["§3 mrt_diversion"]
    dome_score = scores["§4 dome_dispersal"]

    mrt_items = []
    dome_items = []
    for scenario_at in timestamps:
        stations = {s.station_id: s for s in db.fetch_latest_crowd_snapshots(conn, scenario_at)}
        if "BS_MRT_BL17" in stations:
            mrt_items.append(stations["BS_MRT_BL17"])
        if "BS_TPE_DOME" in stations:
            dome = stations["BS_TPE_DOME"]
            history = db.fetch_crowd_history(conn, "BS_TPE_DOME", scenario_at)
            dome_items.append((history, dome))

    mrt_results = _run_parallel("§3 mrt_diversion", [(lambda s=s: decide_mrt_diversion(s)) for s in mrt_items])
    for bl17, llm in zip(mrt_items, mrt_results):
        mrt_score.record(llm.triggered, _rules_mrt.check_mrt_diversion(bl17))

    dome_results = _run_parallel(
        "§4 dome_dispersal", [(lambda h=h, d=d: decide_dome_dispersal(h, d)) for h, d in dome_items]
    )
    for (history, dome), llm in zip(dome_items, dome_results):
        dome_score.record(llm.triggered, _rules_dome.check_dome_dispersal(history, dome))


def _score_signal_failure(conn, scores: dict[str, _ArticleScore]) -> None:
    """Scored against live_incidents.json's real (few) events, not every
    timestamp -- signal_failure judges a specific injected incident, not a
    per-tick snapshot."""
    score = scores["§5 signal_failure"]
    # fetch_active_incidents needs a scenario_at; use the latest possible tick
    # so every seeded incident is "active" (occurred_at <= scenario_at).
    latest = conn.execute("SELECT MAX(occurred_at) AS latest FROM incidents").fetchone()
    if not latest or latest["latest"] is None:
        return
    incidents = db.fetch_active_incidents(conn, latest["latest"])
    results = _run_parallel("§5 signal_failure", [(lambda i=i: decide_signal_failure(i)) for i in incidents])
    for incident, llm in zip(incidents, results):
        score.record(llm.triggered, _rules_signal.check_signal_failure(incident))


def evaluate(limit: int | None = None) -> dict[str, _ArticleScore]:
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT DISTINCT observed_at FROM traffic_snapshots ORDER BY observed_at"
        ).fetchall()
        timestamps = [row["observed_at"] for row in rows]
        if limit:
            timestamps = timestamps[:limit]

        scores: dict[str, _ArticleScore] = defaultdict(_ArticleScore)
        print(f"Scoring §1/§6/§3/§4 across {len(timestamps)} timestamps...", file=sys.stderr)
        _score_congestion(conn, timestamps, scores)
        _score_multilingual(conn, timestamps, scores)
        _score_mrt_and_dome(conn, timestamps, scores)
        print("Scoring §5 against seeded incidents...", file=sys.stderr)
        _score_signal_failure(conn, scores)
        conn.commit()
        return dict(scores)
    finally:
        conn.close()


def summarize(scores: dict[str, _ArticleScore]) -> None:
    print()
    print(f"{'Article':<22}{'N':>6}{'Agree':>8}{'TP':>6}{'TN':>6}{'FP':>6}{'FN':>6}")
    for name, score in scores.items():
        print(
            f"{name:<22}{score.total:>6}{score.agreement_rate:>8.3f}"
            f"{score.true_positive:>6}{score.true_negative:>6}"
            f"{score.false_positive:>6}{score.false_negative:>6}"
        )

    congestion = scores.get("§1 congestion")
    if congestion and congestion.tier_mismatches:
        print()
        print(f"§1 tier mismatches (both agreed triggered=true, tier differed): {len(congestion.tier_mismatches)}")
        for line in congestion.tier_mismatches:
            print(f"  {line}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None, help="only evaluate the first N timestamps")
    args = parser.parse_args()

    scores = evaluate(limit=args.limit)
    summarize(scores)


if __name__ == "__main__":
    main()

"""Evaluates Phase A (the router agent)'s precision/recall against Phase B
(the per-item decide_*() functions), which is authoritative -- see
decision_routing.py's module docstring for the two-phase design this is
measuring.

Router precision/recall is a natural free metric here: Phase A makes one
cheap LLM call to GUESS which SOP articles are triggered where; Phase B then
independently confirms/denies each guess with its own full judgment call.
This script runs Phase A and the full Phase B sweep against every real
timestamp in the demo dataset and compares:

  - precision = of what Phase A flagged, how much did Phase B confirm?
  - recall    = of what Phase B actually confirmed, how much did Phase A catch?

High recall matters more than high precision here (see router_agent.py's
system prompt: "多列不影響正確性；但漏掉真的有觸發的比較不好，請寧可多列" --
over-flagging just costs one extra Phase B call per false positive, but a
missed trigger never gets a chance to be judged by Phase B at all).

mrt_diversion (§3) and dome_dispersal (§4) are excluded from both sets --
these are deliberately NOT part of the router's judgment (see
decision_routing.py's module docstring: "_always_on_triggers" adds them
unconditionally regardless of what the router said), so scoring the router
against them would penalize it for a decision it was never asked to make.

Requires a real LLM configured (BEDROCK_MODEL_ID/ANTHROPIC_API_KEY/
OMNIROUTE_BASE_URL) -- without one, Phase A's fallback IS today's
Phase-B-equivalent eager scan (_eager_trigger_scan calls the same decide_*()
functions), so precision/recall would trivially be 1.0/1.0 and prove
nothing about the router's actual judgment quality.

Usage (from backend/service/, with DATABASE_URL and an LLM configured):

    python3 -m eval.router_precision_recall
    python3 -m eval.router_precision_recall --limit 5   # first N timestamps only
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

import db
from decision_routing import (
    _always_on_triggers,
    _attach_event_ids,
    _CityData,
    _ensure_decisions,
    _fetch_city_data,
    _INCIDENT_RESPONSE_KINDS,
    _snapshot_json,
)
from agent.router_agent import Trigger, route_triggers


@dataclass
class _TickResult:
    scenario_at: str
    router_set: set[tuple[str, str]]  # (kind, location_id)
    authoritative_set: set[tuple[str, str]]


def _authoritative_sweep(conn, data: _CityData, scenario_at) -> set[tuple[str, str]]:
    """Phase B's ground truth: every candidate that COULD trigger, eagerly
    evaluated for real (not the router's guess). Reuses _eager_trigger_scan's
    same decide_*() calls plus the always-on §3/§4 candidates, run through
    _ensure_decisions so caching/kind-filtering behavior matches production
    exactly -- this is deliberately the same code path run_worker_phases
    uses, just fed every possible candidate instead of only the router's
    picks, so nothing Phase B would have confirmed is left unchecked."""
    from agent.facts import decide_accident, decide_congestion, decide_multilingual, decide_signal_failure

    candidates: list[Trigger] = []
    for segment_id in data.current_traffic:
        candidates.append(Trigger(sop_section_id="1", location_id=segment_id))
    for station_id in data.current_crowd:
        candidates.append(Trigger(sop_section_id="6", location_id=station_id))
    candidates += _always_on_triggers(data)
    for incident in data.incidents.values():
        candidates.append(Trigger(sop_section_id="2", location_id=incident.affected_segment))
        candidates.append(Trigger(sop_section_id="5", location_id=incident.affected_segment))
    candidates = [t for t in candidates if t.kind not in _EXCLUDED_KINDS]
    candidates = _attach_event_ids(candidates, data)

    pairs = _ensure_decisions(conn, scenario_at, data, candidates)
    return {(trig.kind, trig.location_id) for trig, _decision in pairs}


# Excluded from the router's scoring entirely: accident/signal_failure are
# the incident API's job (never part of a decision-sweep candidate set, see
# _INCIDENT_RESPONSE_KINDS), and mrt_diversion/dome_dispersal are always-on
# regardless of what the router said (see the module docstring above).
_EXCLUDED_KINDS = _INCIDENT_RESPONSE_KINDS | {"mrt_diversion", "dome_dispersal"}


def _router_guess(data: _CityData) -> set[tuple[str, str]]:
    snapshot = _snapshot_json(data)
    triggers = route_triggers(snapshot, fallback=lambda: [])
    triggers = [t for t in triggers if t.kind not in _EXCLUDED_KINDS]
    return {(t.kind, t.location_id) for t in triggers}


def evaluate(limit: int | None = None) -> list[_TickResult]:
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT DISTINCT observed_at FROM traffic_snapshots ORDER BY observed_at"
        ).fetchall()
        timestamps = [row["observed_at"] for row in rows]
        if limit:
            timestamps = timestamps[:limit]

        results = []
        for scenario_at in timestamps:
            data = _fetch_city_data(conn, scenario_at)
            router_set = _router_guess(data)
            authoritative_set = _authoritative_sweep(conn, data, scenario_at)
            conn.commit()  # release each tick's S3-cache-writing side effects promptly
            results.append(_TickResult(scenario_at.isoformat(), router_set, authoritative_set))
            print(
                f"  {scenario_at}: router guessed {len(router_set)}, "
                f"phase B confirmed {len(authoritative_set)}",
                file=sys.stderr,
            )
        return results
    finally:
        conn.close()


def summarize(results: list[_TickResult]) -> None:
    true_positive = false_positive = false_negative = 0
    for r in results:
        true_positive += len(r.router_set & r.authoritative_set)
        false_positive += len(r.router_set - r.authoritative_set)
        false_negative += len(r.authoritative_set - r.router_set)

    precision = true_positive / (true_positive + false_positive) if (true_positive + false_positive) else float("nan")
    recall = true_positive / (true_positive + false_negative) if (true_positive + false_negative) else float("nan")
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall > 0 and precision == precision and recall == recall
        else float("nan")
    )

    print()
    print(f"Timestamps evaluated : {len(results)}")
    print(f"True positives        : {true_positive}")
    print(f"False positives        : {false_positive}  (router flagged, Phase B denied)")
    print(f"False negatives        : {false_negative}  (Phase B confirmed, router missed)")
    print(f"Precision              : {precision:.3f}")
    print(f"Recall                 : {recall:.3f}")
    print(f"F1                     : {f1:.3f}")

    if false_negative:
        print()
        print("Missed by the router (false negatives) -- the costly failure mode:")
        for r in results:
            missed = r.authoritative_set - r.router_set
            for kind, location_id in sorted(missed):
                print(f"  {r.scenario_at}: {kind} @ {location_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None, help="only evaluate the first N timestamps")
    args = parser.parse_args()

    results = evaluate(limit=args.limit)
    summarize(results)


if __name__ == "__main__":
    main()

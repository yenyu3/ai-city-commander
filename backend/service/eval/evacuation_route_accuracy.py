"""Evaluates decide_accident()'s (SOP §2) main/secondary evacuation route
selection against rules/accident_response.py's deterministic algorithm --
the same ground-truth relationship used by llm_vs_rules_consistency.py, but
scoped specifically to route selection since live_incidents.json only has
ONE real accident (TPE_2026_ACC_001), far too small a sample to say anything
about route-selection accuracy on its own.

Synthesizes one candidate accident per real road segment (15 segments in
road_network_geometry.json, all with alternatives) instead: same
Closed/Critical shape as the real accident (guaranteed to satisfy SOP §2's
three trigger conditions), affected_segment set to each segment in turn,
saturation scores taken from a real traffic snapshot at a fixed scenario_at
so candidate-route saturation comparisons are grounded in real data, not
invented numbers. This is NOT claiming these are real accidents -- it's
purely a synthetic stress test of the route-selection LOGIC across every
segment the real network defines, using SOP §2's actual selection criteria
(capacity_vph / is_direct_intersection / is_upstream / current_saturation)
that build_accident_candidates() already assembles.

Scores, per segment:
  - triggered agreement (did both sides agree this constitutes an accident
    trigger at all -- should always be yes here, since every synthetic
    incident is Closed+Critical+RD_-prefixed by construction; a mismatch
    here would mean the LLM contradicts SOP §2's stated trigger conditions)
  - main_route exact match
  - secondary_routes set match

Requires a real LLM configured -- otherwise decide_accident() calls its own
rules/ fallback and this would trivially agree 100% with itself.

2026-08-02: `segments`/`traffic`/`saturation` are all fetched from `conn`
ONCE before the loop, and the loop body never touches `conn` again -- so
the 15 decide_accident() calls (each an independent LLM call) are safe to
run through a ThreadPoolExecutor instead of a plain sequential loop, same
pattern (and same _MAX_PARALLEL ceiling) as decision_routing.py's
_ensure_decisions / eval/llm_vs_rules_consistency.py.

Usage (from backend/service/, with DATABASE_URL and an LLM configured):

    python3 -m eval.evacuation_route_accuracy
    python3 -m eval.evacuation_route_accuracy --scenario-at "2026-05-20T22:10:00+08:00"
"""
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

import api_common
import db
from agent.facts import decide_accident
from rules import accident_response as _rules_accident

# Same ceiling as decision_routing.py's _MAX_PARALLEL_DECISIONS / eval/
# llm_vs_rules_consistency.py's _MAX_PARALLEL -- comfortable headroom over
# this eval's fixed 15-segment candidate set.
_MAX_PARALLEL = 20


@dataclass
class _RouteResult:
    segment_id: str
    triggered_agree: bool
    main_route_match: bool
    secondary_match: bool
    llm_main: str | None
    rules_main: str | None
    llm_secondary: list[str]
    rules_secondary: list[str]


def _synthetic_incident(segment_id: str):
    from rules.types import LiveIncident

    # Same shape as the real seeded accident (TPE_2026_ACC_001) -- Closed +
    # Critical + RD_-prefixed segment guarantees all three of SOP §2's
    # trigger conditions are satisfied by construction, so this isolates
    # route-SELECTION accuracy from trigger-detection accuracy (already
    # covered by llm_vs_rules_consistency.py).
    return LiveIncident(
        event_id=f"SYNTH_{segment_id}",
        type="Road_Collapse_Accident",
        location=f"{segment_id}（合成測試事故）",
        affected_segment=segment_id,
        status="Closed",
        severity="Critical",
        description="評估腳本合成事故，用於路徑選擇正確率測試。",
        timestamp="2026-05-20T22:00:00+08:00",
    )


def evaluate(scenario_at_str: str = "2026-05-20T22:10:00+08:00") -> list[_RouteResult]:
    conn = db.connect()
    try:
        scenario_at = api_common.parse_scenario_at(scenario_at_str)
        segments = db.fetch_road_segments(conn)
        traffic = db.fetch_latest_traffic_snapshots(conn, scenario_at)
        saturation = {t.segment_id: t.saturation_score for t in traffic}

        candidates = [sid for sid, seg in segments.items() if seg.alternatives]

        def score_one(segment_id: str) -> _RouteResult:
            incident = _synthetic_incident(segment_id)
            llm = decide_accident(incident, segments, saturation)
            rules_route = _rules_accident.select_evacuation_route(
                segment_id, incident.location, segments, saturation
            )
            rules_triggered = _rules_accident.is_accident_trigger(incident)

            llm_main = llm.result.get("main_route") if llm.triggered else None
            llm_secondary = sorted(llm.result.get("secondary_routes") or []) if llm.triggered else []
            rules_secondary = sorted(rules_route.secondary_routes)

            return _RouteResult(
                segment_id=segment_id,
                triggered_agree=(llm.triggered == rules_triggered),
                main_route_match=(llm_main == rules_route.main_route),
                secondary_match=(llm_secondary == rules_secondary),
                llm_main=llm_main,
                rules_main=rules_route.main_route,
                llm_secondary=llm_secondary,
                rules_secondary=rules_secondary,
            )

        results: list[_RouteResult] = [None] * len(candidates)  # type: ignore[list-item]
        print(f"  {len(candidates)} segment(s), up to {_MAX_PARALLEL} in parallel...", file=sys.stderr)
        with ThreadPoolExecutor(max_workers=min(_MAX_PARALLEL, len(candidates) or 1)) as pool:
            future_to_index = {pool.submit(score_one, sid): i for i, sid in enumerate(candidates)}
            done = 0
            for future in as_completed(future_to_index):
                r = future.result()
                results[future_to_index[future]] = r
                done += 1
                match_label = "match" if r.main_route_match else "MISMATCH"
                print(f"  [{done}/{len(candidates)}] {r.segment_id} ... main={r.llm_main!r} ({match_label})", file=sys.stderr)
        conn.commit()
        return results
    finally:
        conn.close()


def summarize(results: list[_RouteResult]) -> None:
    n = len(results)
    trigger_agree = sum(r.triggered_agree for r in results)
    main_match = sum(r.main_route_match for r in results)
    secondary_match = sum(r.secondary_match for r in results)

    print()
    print(f"Segments evaluated       : {n}")
    print(f"Trigger agreement        : {trigger_agree}/{n} ({trigger_agree/n:.1%})" if n else "n/a")
    print(f"Main route exact match   : {main_match}/{n} ({main_match/n:.1%})" if n else "n/a")
    print(f"Secondary routes match   : {secondary_match}/{n} ({secondary_match/n:.1%})" if n else "n/a")

    mismatches = [r for r in results if not r.main_route_match]
    if mismatches:
        print()
        print("Main route mismatches:")
        for r in mismatches:
            print(f"  {r.segment_id}: LLM chose {r.llm_main!r}, rules/ chose {r.rules_main!r}")

    secondary_mismatches = [r for r in results if not r.secondary_match]
    if secondary_mismatches:
        print()
        print("Secondary route mismatches:")
        for r in secondary_mismatches:
            print(f"  {r.segment_id}: LLM chose {r.llm_secondary!r}, rules/ chose {r.rules_secondary!r}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario-at", default="2026-05-20T22:10:00+08:00",
        help="which real traffic snapshot's saturation scores to use for candidate comparison",
    )
    args = parser.parse_args()

    results = evaluate(args.scenario_at)
    summarize(results)


if __name__ == "__main__":
    main()

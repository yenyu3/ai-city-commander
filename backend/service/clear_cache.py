"""Dev-only CLI for clearing cached SOP decisions during local testing.

The three cache tables (see schema.sql) all key on scenario_at, so
re-testing the same scenario time after changing a prompt/model/fallback
needs the old cached row cleared first, or the API just serves the stale
cached answer instead of recomputing. Not used in production.

Usage (from backend/service/, with DATABASE_URL set):

    # clear everything cached at one simulated moment (all 3 tables)
    python3 clear_cache.py --scenario-at "2026-05-20T22:10:00+08:00"

    # clear only one incident's cached SOP checks (any scenario time)
    python3 clear_cache.py --event-id TPE_2026_ACC_001

    # clear one incident at one specific scenario time
    python3 clear_cache.py --event-id TPE_2026_ACC_001 --scenario-at "2026-05-20T22:10:00+08:00"

    # nuke all cached decisions, every table, every time
    python3 clear_cache.py --all
"""
from __future__ import annotations

import argparse

import db
from handler import _parse_scenario_at


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario-at", help="ISO8601 scenario time, e.g. 2026-05-20T22:10:00+08:00")
    parser.add_argument("--event-id", help="only clear response_alerts for this incident")
    parser.add_argument("--all", action="store_true", help="clear every cache table entirely")
    args = parser.parse_args()

    if not (args.all or args.scenario_at or args.event_id):
        parser.error("need at least one of --scenario-at, --event-id, --all")

    conn = db.connect()
    total = 0

    if args.all:
        for table in ("response_alerts", "congestion_decisions", "crowd_decisions"):
            cur = conn.execute(f"DELETE FROM {table}")
            print(f"  {table}: {cur.rowcount} row(s) deleted")
            total += cur.rowcount
    else:
        scenario_at = _parse_scenario_at(args.scenario_at) if args.scenario_at else None

        if args.event_id:
            if scenario_at is not None:
                cur = conn.execute(
                    "DELETE FROM response_alerts WHERE event_id = %(e)s AND scenario_at = %(t)s",
                    {"e": args.event_id, "t": scenario_at},
                )
            else:
                cur = conn.execute(
                    "DELETE FROM response_alerts WHERE event_id = %(e)s", {"e": args.event_id}
                )
            print(f"  response_alerts: {cur.rowcount} row(s) deleted")
            total += cur.rowcount
        elif scenario_at is not None:
            for table in ("response_alerts", "congestion_decisions", "crowd_decisions"):
                cur = conn.execute(f"DELETE FROM {table} WHERE scenario_at = %(t)s", {"t": scenario_at})
                print(f"  {table}: {cur.rowcount} row(s) deleted")
                total += cur.rowcount

    conn.commit()
    conn.close()
    print(f"done, {total} row(s) total")


if __name__ == "__main__":
    main()

"""Dev-only CLI for clearing cached SOP decisions during local testing.

Decisions are cached in S3 (see s3_cache.py), one JSON object per
(scenario_at, location_id[, kind]) under decisions/{scenario_at}/. Re-testing
the same scenario time after changing a prompt/model/fallback needs the old
cached object cleared first, or the API just serves the stale cached answer
instead of recomputing. Not used in production.

Usage (from backend/service/, with INTERNAL_RESULTS_BUCKET and AWS_REGION
set, and AWS credentials that can s3:ListBucket/DeleteObject that bucket):

    # clear everything cached at one simulated moment
    python3 clear_cache.py --scenario-at "2026-05-20T22:10:00+08:00"

    # clear only one incident's cached SOP checks (any scenario time)
    python3 clear_cache.py --event-id TPE_2026_ACC_001

    # clear one incident at one specific scenario time
    python3 clear_cache.py --event-id TPE_2026_ACC_001 --scenario-at "2026-05-20T22:10:00+08:00"

    # nuke every cached decision object
    python3 clear_cache.py --all
"""
from __future__ import annotations

import argparse

import s3_cache
from handler import _parse_scenario_at

_PREFIX = "decisions/"


def _list_keys(prefix: str) -> list[str]:
    client = s3_cache._client()
    bucket = s3_cache._bucket()
    keys: list[str] = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        keys.extend(obj["Key"] for obj in page.get("Contents", []))
    return keys


def _delete_keys(keys: list[str]) -> int:
    if not keys:
        return 0
    client = s3_cache._client()
    bucket = s3_cache._bucket()
    # delete_objects takes at most 1000 keys per call
    deleted = 0
    for i in range(0, len(keys), 1000):
        batch = keys[i : i + 1000]
        client.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in batch]})
        deleted += len(batch)
    return deleted


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario-at", help="ISO8601 scenario time, e.g. 2026-05-20T22:10:00+08:00")
    parser.add_argument("--event-id", help="only clear cached decisions for this incident")
    parser.add_argument("--all", action="store_true", help="clear every cached decision object")
    args = parser.parse_args()

    if not (args.all or args.scenario_at or args.event_id):
        parser.error("need at least one of --scenario-at, --event-id, --all")

    if args.all:
        keys = _list_keys(_PREFIX)
    elif args.scenario_at:
        scenario_at = _parse_scenario_at(args.scenario_at)
        at_prefix = f"{_PREFIX}{scenario_at.isoformat().replace(':', '-')}/"
        keys = _list_keys(at_prefix)
        if args.event_id:
            keys = [k for k in keys if k.split("/")[-1].startswith(f"{args.event_id}__")]
    else:
        # --event-id only, no --scenario-at: every prefix must be scanned
        # since the event_id lives in the object filename, not the key prefix.
        keys = [k for k in _list_keys(_PREFIX) if k.split("/")[-1].startswith(f"{args.event_id}__")]

    deleted = _delete_keys(keys)
    print(f"done, {deleted} object(s) deleted")


if __name__ == "__main__":
    main()

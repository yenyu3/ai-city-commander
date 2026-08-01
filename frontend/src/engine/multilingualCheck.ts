import type { CrowdSnapshot } from "../types";

export function checkMultilingualNeeded(
  stations: CrowdSnapshot[],
): CrowdSnapshot[] {
  return stations.filter((s) => s.roamingUserPct >= 0.3);
}

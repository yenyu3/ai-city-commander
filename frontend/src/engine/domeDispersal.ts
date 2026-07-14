import type { CrowdSnapshot } from "../types";

export function checkDomeDispersal(
  domeHistory: CrowdSnapshot[],
  current: CrowdSnapshot,
): boolean {
  const historicalPeak = Math.max(0, ...domeHistory.map((d) => d.userCount));
  return historicalPeak >= 30000 && current.growthRate <= -0.2;
}

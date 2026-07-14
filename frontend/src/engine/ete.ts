import type { EteResult, IncidentSeverity } from "../types";

const BASE_CLEARANCE: Record<string, number> = {
  Critical: 60,
  High: 40,
  Medium: 20,
};

export function calcETE(
  severity: IncidentSeverity,
  avgSaturation: number,
): EteResult {
  const base = BASE_CLEARANCE[severity] ?? 20;
  const penalty = Math.round(Math.max(0, (avgSaturation - 0.5) * 60) * 10) / 10;
  const ete = Math.round(base + penalty);
  return {
    ete,
    base,
    penalty,
    breakdown: `base_clearance(${severity})=${base} + congestion_penalty=(${avgSaturation.toFixed(2)}-0.5)×60=${penalty.toFixed(1)} → ETE=${ete}分鐘`,
  };
}

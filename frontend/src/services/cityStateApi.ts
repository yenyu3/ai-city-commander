import { toScenarioAt } from "../utils/timeUtils";

/**
 * Client for the backend's scenario-time-aware judgment endpoints
 * (GET /api/city-state, POST /api/incidents/{eventId}/evaluate). Every SOP
 * judgment shown in the UI must come from here -- see backend/PIPELINES.md's
 * "三條產品層級觸發路徑". There is no local fallback: if the backend is
 * unreachable, callers get a rejected promise and should surface that
 * clearly rather than silently deciding anything client-side.
 */

export interface CityStateTraffic {
  segmentId: string;
  roadName: string;
  observedAt: string;
  avgSpeedKph: number;
  vehicleCount: number;
  saturationScore: number;
  laneStatus: string;
  tier: "Normal" | "B" | "A";
  cityResponseTriggered: boolean;
  cityResponseActions: string[];
  reasoning: string;
  source: string;
}

export interface CityStateCrowd {
  stationId: string;
  locationName: string;
  observedAt: string;
  userCount: number;
  stayTimeAvgMinutes: number;
  growthRate: number;
  roamingUserPct: number;
  multilingualTriggered: boolean;
  mrtDiversionTriggered?: boolean;
  mrtDiversionReasoning?: string;
  mrtDiversionSource?: string;
  domeDispersalTriggered?: boolean;
  domeDispersalReasoning?: string;
  domeDispersalSource?: string;
}

export interface CityStateIncident {
  eventId: string;
  type: string;
  location: string;
  affectedSegment: string;
  status: string;
  severity: string;
  description: string;
  occurredAt: string;
}

export interface CityStateResponse {
  meta: { scenarioAt: string; generatedAt: string; dataMode: string };
  traffic: CityStateTraffic[];
  crowd: CityStateCrowd[];
  multilingualJudgment: { triggered: boolean; reasoning: string; source: string };
  activeIncidents: CityStateIncident[];
}

export async function fetchCityState(baseUrl: string, rawTimestamp: string): Promise<CityStateResponse> {
  const scenarioAt = toScenarioAt(rawTimestamp);
  const res = await fetch(`${baseUrl}/api/city-state?scenarioAt=${encodeURIComponent(scenarioAt)}`);
  if (!res.ok) {
    throw new Error(`/api/city-state failed: HTTP ${res.status}`);
  }
  return res.json();
}

export interface IncidentSopCheck {
  eventId: string;
  alertKind: "accident" | "signal_failure";
  triggered: boolean;
  sopSectionId: string | null;
  result: Record<string, unknown>;
  reasoning: string;
  source: string;
}

export interface EvaluateIncidentResponse {
  meta: { scenarioAt: string; generatedAt: string; dataMode: string };
  aiDecisions: IncidentSopCheck[];
}

export async function evaluateIncident(
  baseUrl: string,
  eventId: string,
  rawTimestamp: string,
): Promise<EvaluateIncidentResponse> {
  const scenarioAt = toScenarioAt(rawTimestamp);
  const res = await fetch(`${baseUrl}/api/incidents/${encodeURIComponent(eventId)}/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: { scenarioAt } }),
  });
  if (!res.ok) {
    throw new Error(`/api/incidents/${eventId}/evaluate failed: HTTP ${res.status}`);
  }
  return res.json();
}

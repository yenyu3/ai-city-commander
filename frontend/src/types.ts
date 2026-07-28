export type LaneStatus =
  | "Normal"
  | "Congested"
  | "Critical"
  | "Blocked"
  | "Gridlock"
  | "Accident_Impact"
  | "Partial_Open";

export interface TrafficSnapshot {
  timestamp: string; // "2026-05-20 21:00"
  segmentId: string; // "RD_TPE_001"
  roadName: string;
  avgSpeed: number;
  vehicleCount: number;
  saturationScore: number; // 0~1+
  laneStatus: LaneStatus;
}

export interface CrowdSnapshot {
  timestamp: string;
  stationId: string; // "BS_MRT_BL17"
  locationName: string;
  userCount: number;
  stayTimeAvg: number;
  growthRate: number; // -1 ~ +N
  roamingPct: number; // 0~1 decimal (parsed from "8%")
}

export interface RoadSegment {
  segmentId: string;
  name: string;
  flowDirection: string;
  intersections: string[]; // raw road-name strings, north->south / west->east order
  intersectionIds: string[]; // resolved segmentId array, same order
  capacityVph: number;
  alternatives: string[]; // segmentId array
  nearbyStations: string[];
}

export interface RoadPathDef {
  segmentId: string;
  path: [number, number][]; // real [lng, lat] polyline, OSM-derived
  dashed: boolean;
}

export type IncidentStatus =
  | "Closed"
  | "Blocked"
  | "Restricted"
  | "Caution"
  | string;
export type IncidentSeverity = "Critical" | "High" | "Medium" | string;

export interface LiveIncident {
  eventId: string;
  type: string;
  location: string;
  affectedSegment: string; // RD_ or BS_ prefixed
  affectedRoad?: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  description: string;
  timestamp: string;
}

export type Tier = "Normal" | "B" | "A";

export type ViewerMode = "public" | "government";

export interface CityResponseResult {
  segmentId: string;
  tier: Tier;
  actions: string[];
}

export interface ExcludedCandidate {
  segmentId: string;
  reason: string;
}

export interface EvacuationRouteResult {
  mainRoute: string | null;
  secondaryRoutes: string[];
  excluded: ExcludedCandidate[];
  congestionWarning: boolean;
  recommendPublicTransit: boolean;
}

export interface EteResult {
  ete: number;
  base: number;
  penalty: number;
  breakdown: string;
}

export interface ReasoningStep {
  order: number;
  status: "info" | "pass" | "fail" | "final";
  title: string;
  detail: string;
  sopRef?: string;
}

export interface AlertRecord {
  id: string;
  timestamp: string;
  kind:
    | "city_response"
    | "accident"
    | "mrt_diversion"
    | "dome_dispersal"
    | "signal_failure"
    | "multilingual";
  title: string;
  ruleSummary: string;
  llmText?: string;
  sopRef?: string;
  ete?: number;
  eteBase?: number;
  etePenalty?: number;
  reasoningSteps?: ReasoningStep[];
}

export interface FieldInspectorPosition {
  lng: number;
  lat: number;
  nearestRoadId: string | null;
  nearestRoadName: string | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 這則訊息屬於哪個檢視模式的對話串，切換模式時不互相混入 */
  audience: ViewerMode;
  sopRefs?: string[];
  ruleResult?: unknown;
  createdAt: number;
}

export interface SopSection {
  id: string;
  title: string;
  keywords: string[];
  text: string;
}

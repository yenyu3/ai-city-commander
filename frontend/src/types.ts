export type LaneStatus =
  | "Normal"
  | "Congested"
  | "Critical"
  | "Blocked"
  | "Gridlock"
  | "Accident_Impact"
  | "Partial_Open";

export interface TrafficSnapshot {
  observedAt: string; // "2026-05-20 21:00" (demo) / ISO 8601 (api), 對應後端 observedAt
  segmentId: string; // "RD_TPE_001"
  /** 前端本地 join 補上的展示欄位（segmentDefs 查表），並非後端 city-state API 直接提供。 */
  roadName: string;
  avgSpeedKph: number;
  vehicleCount: number;
  saturationScore: number; // 0~1+
  laneStatus: LaneStatus;
  /** 後端 city-state traffic item 可能已附上壅塞分級，demo 模式維持本地 getTier() 計算。 */
  tier?: Tier;
}

export interface CrowdSnapshot {
  observedAt: string;
  stationId: string; // "BS_MRT_BL17"
  /** 前端本地 join 補上的展示欄位（站名查表），並非後端 city-state API 直接提供。 */
  locationName: string;
  userCount: number;
  stayTimeAvgMinutes: number;
  growthRate: number; // -1 ~ +N
  roamingUserPct: number; // 0~1 decimal (parsed from "8%")
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
  affectedSegmentId: string; // RD_ or BS_ prefixed
  /** 新版後端 API request/response 範例未包含此欄位，僅 demo 資料/展示用。 */
  affectedRoad?: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  description: string;
  occurredAt: string;
  /** POST /api/incidents 202 回應帶回的非同步處理狀態，demo 模式不會有值。 */
  processing?: { jobId: string; status: string };
  /** POST /api/incidents 202 回應 publication.publicManifestUrl（後端相對路徑），demo 模式不會有值。 */
  publicManifestUrl?: string;
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

/** 事件觸發當下，來源路段的即時流量快照（僅 city_response/accident 有意義）。 */
export interface SegmentMetricsSnapshot {
  segmentName: string;
  flowPcuh: number;
  saturation: number;
}

/** 替代路徑疏散規劃的結構化版本，對應 selectEvacuationRoute 的計算結果（僅 accident 會填入）。 */
export interface RerouteSnapshot {
  primaryRouteName: string | null;
  secondaryRouteNames: string[];
  excluded: { segmentName: string; reason: string }[];
  congestionWarning: boolean;
}

export interface AlertRecord {
  id: string;
  timestamp: string;
  /** 觸發此 alert 的原始事件 eventId（若有），用來在 api 模式下比對 GET /api/decisions 的結果。 */
  sourceIncidentId?: string;
  /** Backend decision snapshot id, used to update an existing API-driven alert. */
  decisionId?: string;
  /** The locationId used when querying GET /api/decisions. */
  decisionLocationId?: string;
  kind:
    | "city_response"
    | "accident"
    | "mrt_diversion"
    | "dome_dispersal"
    | "signal_failure"
    | "multilingual";
  title: string;
  ruleSummary: string;
  /** SOP 規定的實際處置步驟（非觸發條件數據），供「建議行動」區塊顯示。 */
  actions: string[];
  llmText?: string;
  publicMessage?: string;
  sopRef?: string;
  ete?: number;
  eteBase?: number;
  etePenalty?: number;
  reasoningSteps?: ReasoningStep[];
  segmentMetrics?: SegmentMetricsSnapshot;
  reroute?: RerouteSnapshot;
  /** 事件來源："incident" 表示由 injectIncident 注入，其餘為規則觸發 */
  origin?: "incident";
  /** 追蹤解決狀態用的路段 ID */
  trackedSegmentId?: string;
  /** 是否曾觀察到路段惡化（解決判定的前置條件） */
  wasElevated?: boolean;
  /** 事件解決的時間戳記 */
  resolvedAt?: string;
  /** 對應 LiveIncident.publicManifestUrl（後端相對路徑），供民眾模式「現場公告」連到官方公告用。 */
  publicManifestUrl?: string;
}

export interface FieldInspectorPosition {
  lng: number;
  lat: number;
  nearestRoadId: string | null;
  nearestRoadName: string | null;
}

/** 小人自動定位（瀏覽器 Geolocation）的狀態，用來決定要不要顯示「無法取得位置」提示。 */
export type FieldInspectorLocateStatus = "idle" | "pending" | "granted" | "denied" | "unavailable";

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

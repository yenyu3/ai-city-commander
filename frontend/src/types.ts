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

/** 事件觸發當下，來源路段的即時流量快照（僅 city_response/accident 有意義）。 */
export interface SegmentMetricsSnapshot {
  segmentName: string;
  flowPcuh: number;
  saturation: number;
}

/** 事件觸發當下，來源站點的即時人流快照（mrt_diversion/dome_dispersal/multilingual 適用）。 */
export interface StationMetricsSnapshot {
  stationName: string;
  userCount: number;
  growthRate: number;
  roamingPct: number;
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
  kind:
    | "city_response"
    | "accident"
    | "mrt_diversion"
    | "dome_dispersal"
    | "signal_failure"
    | "multilingual";
  /** "incident"：由 live_incidents.json / 上傳事件注入產生（accident、signal_failure 皆屬此類）。
   *  "sensor"：由規則引擎對連續時序資料（車流/人流 CSV）即時判定門檻穿越產生，與上傳事件無關
   *  （city_response、mrt_diversion、dome_dispersal、multilingual 皆屬此類）。
   *  事件時間軸只畫 "incident"，讓時間軸的點數與使用者上傳的事件數一致；AI 決策面板仍顯示全部。 */
  origin: "incident" | "sensor";
  title: string;
  ruleSummary: string;
  /** SOP 規定的實際處置步驟（非觸發條件數據），供「建議行動」區塊顯示。 */
  actions: string[];
  llmText?: string;
  sopRef?: string;
  ete?: number;
  eteBase?: number;
  etePenalty?: number;
  reasoningSteps?: ReasoningStep[];
  segmentMetrics?: SegmentMetricsSnapshot;
  stationMetrics?: StationMetricsSnapshot;
  reroute?: RerouteSnapshot;
  /** 僅 origin === "incident" 會設定：追蹤這起事件對應的路段/站點 ID（RD_ 或 BS_ 開頭），
   *  用來判定「是否已解決」以及「使用者定位是否鄰近此事件」。 */
  trackedSegmentId?: string;
  /** 追蹤路段/站點是否曾經真的進入異常狀態——必須先觀察到「曾經惡化」，才能判定後續的
   *  「已恢復」，避免原本就正常的路段被誤判為已解決。 */
  wasElevated?: boolean;
  /** 追蹤路段/站點從異常恢復到正常/可通行狀態的時間點（依實際車流/人流資料判定，非固定
   *  時間差）；有值時事件時間軸會在此時間額外畫一個綠色「已解決」標記。 */
  resolvedAt?: string;
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

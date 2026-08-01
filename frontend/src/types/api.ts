/**
 * 後端 wire 型別，逐一對照 docs/backend-docs.md 的 JSON 範例命名，
 * 刻意不在這裡做任何「整理」——欄位名稱應與後端完全一致，
 * 需要轉成前端內部慣用形狀時，請在 services/apiAdapter.ts 做轉換，不要改這裡。
 */

export interface ApiMeta {
  scenarioAt: string;
  resolvedScenarioAt?: string;
  ageMinutes?: number;
  generatedAt?: string;
  retrievedAt?: string;
  decisionGeneratedAt?: string;
  dataMode: string;
  source?: string;
  cacheStatus?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
  retryAfterSeconds?: number;
}

export interface ApiErrorResponse {
  meta?: ApiMeta;
  error: ApiErrorBody;
}

// 1. GET /api/city-state
export interface ApiTrafficItem {
  segmentId: string;
  observedAt: string;
  avgSpeedKph: number;
  vehicleCount: number;
  saturationScore: number;
  laneStatus: string;
  tier?: string;
}

export interface ApiCrowdItem {
  stationId: string;
  observedAt: string;
  userCount: number;
  stayTimeAvgMinutes: number;
  growthRate: number;
  roamingUserPct: number;
}

export interface ApiCityStateResponse {
  meta: ApiMeta;
  traffic: ApiTrafficItem[];
  crowd: ApiCrowdItem[];
}

// 2. POST /api/incidents
export interface ApiIncidentPayload {
  eventId: string;
  type: string;
  location: string;
  affectedSegmentId: string;
  status: string;
  severity: string;
  description: string;
  occurredAt: string;
}

export interface ApiCreateIncidentRequest {
  context: { scenarioAt: string };
  incident: ApiIncidentPayload;
}

export interface ApiCreateIncidentResponse {
  meta: ApiMeta;
  incident: ApiIncidentPayload;
  processing: {
    jobId: string;
    status: string;
    processor?: string;
    queuedAt?: string;
  };
  publication?: {
    status: string;
    noticeId?: string;
    publicManifestUrl?: string;
    publicNoticeUrl?: string;
  };
}

// 3. GET /api/incidents/{eventId}/report
/** 對照 2026-08-01 backend/service/report/handler.py 原始碼修正：這支 API 本身還是
 *  非同步輪詢（202 meta+report{status:processing} -> 200 meta+report{status:ready,
 *  downloadUrl}），跟 GET /api/decisions 是同一種模式，不是同步直接回報告內容。 */
export interface ApiReportProcessing {
  eventId: string;
  jobId: string;
  status: "processing";
  retryAfterSeconds?: number;
}

export interface ApiReportReady {
  eventId: string;
  jobId: string;
  status: "ready";
  version?: string;
  format: string;
  generatedAt?: string;
  downloadUrl: string;
}

export type ApiReport = ApiReportProcessing | ApiReportReady;

export interface ApiReportResponse {
  meta: ApiMeta;
  report: ApiReport;
}

/** `ApiReportReady.downloadUrl` 指向的 internal bucket 目前前端打不通（bucket 封鎖公開
 *  存取，API Gateway 也沒有 /internal/* 路由）。改用
 *  GET /api/experiments/public-notices?date=...&noticeId=PUB_{eventId}_v1 讀取相同內容。
 *  此型別保留作為 report_builder.build_and_save_report() 寫入格式的文件用途。 */
export interface ApiIncidentReportContent {
  eventId: string;
  generatedAt: string;
  incident: {
    type: string;
    location: string;
    affectedSegment: string;
    status: string;
    severity: string;
    description: string;
  };
  focus: { locationId: string };
  government: ApiGovernmentSummary;
  citizen: ApiNarrativeSummary;
  decisions: ApiDecisionListItem[];
}

// 4. GET /api/decisions
export interface ApiReasoningStep {
  order: number;
  status: "info" | "pass" | "fail" | "final";
  title: string;
  detail: string;
  sopRef?: string;
}

/** decision/handler.py `_decision_item`'s `excluded` entries — snake_case, straight from
 *  `agent/facts.py`'s route-selection dict, not adapted to camelCase by the backend. */
export interface ApiRerouteExcluded {
  segment_id: string;
  reason: string;
}

/** decision/handler.py `_decision_item`: `mainRoute`/`secondaryRoutes` are bare segmentId
 *  strings, not `{segmentId, segmentName}` objects — the backend never resolves names. */
export interface ApiReroute {
  mainRoute: string | null;
  secondaryRoutes: string[];
  excluded: ApiRerouteExcluded[];
}

/** decision_routing.decision_detail() — `estimatedRecovery` is now an object carrying
 *  ete/base/penalty, not a plain minute count. Only non-null for `kind === "accident"`. */
export interface ApiEstimatedRecovery {
  ete: number;
  base?: number;
  penalty?: number;
}

export interface ApiSignalCoordination {
  signalTimings: { intersectionName: string; adjustPct: number; goal: string }[];
}

export interface ApiCrossSystemCoordination {
  interAgencyActions: { agency: string; text: string; icon: string }[];
}

export interface ApiDecisionListItem {
  decisionId: string;
  sopSectionId?: string;
  kind: string;
  locationId: string;
  eventId: string | null;
  /** decision_routing.decision_detail(): "{locationName} {kindTitle}" */
  title: string;
  summary: {
    aiText: string;
    sopRefs?: string[];
  };
  reasoningSteps: ApiReasoningStep[];
  recommendedActions: string[];
  /** Non-null only for `kind === "accident"`. */
  estimatedRecovery: ApiEstimatedRecovery | null;
  reroute: ApiReroute | null;
  segmentMetrics: { segmentName: string; flowPcuh: number; saturation: number } | null;
  signalCoordination: ApiSignalCoordination | null;
  crossSystemCoordination: ApiCrossSystemCoordination | null;
  publicationEligibility: { eligible: boolean } | null;
  publicMessage?: string;
}

/** decision_routing.summary_json() — citizen omits sopRefs/signalCoordination/
 *  crossSystemCoordination/publicationEligibleLocationIds. */
export interface ApiNarrativeSummary {
  focusLocationId: string | null;
  headline: string;
  text: string;
  recommendedActions: string[];
  /** [{decisionId, locationId, ete}] */
  estimatedRecovery: { decisionId: string; locationId: string; ete: number }[];
  prioritizedDecisionIds: string[];
}

export interface ApiGovernmentSummary extends ApiNarrativeSummary {
  sopRefs: string[];
  signalCoordination: { intersectionName: string; adjustPct: number; goal: string }[];
  crossSystemCoordination: { agency: string; text: string; icon: string }[];
  publicationEligibleLocationIds: string[];
}

/** decision/handler.py 200 response — `situationSummary` (old free-text field) is gone;
 *  replaced by structured `government`/`citizen` NarrativeSummary objects. */
export interface ApiDecisionListResponse {
  meta: ApiMeta;
  focus?: { locationId: string };
  government: ApiGovernmentSummary;
  citizen: ApiNarrativeSummary;
  decisions: ApiDecisionListItem[];
}

export interface ApiPublicManifestEntry {
  noticeId: string;
  alertId: string;
  noticeKey: string;
  publishedAt: string | null;
}

export interface ApiPublicManifestResponse {
  date: string;
  notices: ApiPublicManifestEntry[];
}

/** GET /api/experiments/public-notices?date=YYYY-MM-DD&noticeId=PUB_{eventId}_v1
 *  notice_proxy/handler.py — same shape as ApiDecisionListResponse but scoped to one
 *  incident (decision_routing._write_incident_report_and_notice). */
export interface ApiPublicNoticeResponse {
  eventId: string;
  generatedAt: string;
  focus: { locationId: string };
  government: ApiGovernmentSummary;
  citizen: ApiNarrativeSummary;
  decisions: ApiDecisionListItem[];
}

export interface ApiDecisionProcessingResponse {
  meta: ApiMeta;
  focus?: { locationId: string };
  processing: {
    jobId: string;
    status: "queued" | "processing" | "ready" | "failed" | string;
    processor?: string;
    queuedAt?: string;
    retryAfterSeconds?: number;
    errorMessage?: string;
  };
  message?: string;
}

export type ApiDecisionQueryResponse =
  | ApiDecisionListResponse
  | ApiDecisionProcessingResponse;

// 5. POST /api/chat/messages
export interface ApiChatRuleResult {
  rule: string;
  triggered: boolean;
  input?: Record<string, unknown>;
  threshold?: Record<string, unknown>;
}

export interface ApiChatAnswer {
  messageId: string;
  text: string;
  createdAt: string;
  ruleResult?: ApiChatRuleResult;
  sopRefs?: string[];
  reasoningSteps?: ApiReasoningStep[];
}

export interface ApiChatUserLocation {
  locationId: string;
  locationName: string;
  locationType: string;
}

export interface ApiChatRequest {
  context: {
    scenarioAt: string;
    audience: "government" | "public";
    userLocation?: ApiChatUserLocation;
  };
  message: string;
}

export interface ApiChatResponse {
  meta: ApiMeta;
  answer: ApiChatAnswer;
}

// 6. POST /api/publication
export interface ApiPublicationRequest {
  context: { scenarioAt: string; operatorId?: string };
  alertId: string;
  targetStationIds: string[];
  channels: string[];
  languages: string[];
  messages: Record<string, string>;
}

export interface ApiChannelStatus {
  channel: string;
  status: string;
}

export interface ApiPublicationResponse {
  meta: ApiMeta;
  publication: {
    publicationId: string;
    alertId: string;
    status: string;
    publishedAt?: string;
    languages: string[];
    channelStatuses: ApiChannelStatus[];
  };
}

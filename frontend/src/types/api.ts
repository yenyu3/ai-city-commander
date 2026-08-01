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
    expectedNoticeId?: string;
    publicManifestUrl?: string;
  };
}

// 3. GET /api/incidents/{eventId}/report
export interface ApiReportReady {
  eventId: string;
  jobId: string;
  status: "ready";
  version?: string;
  format: string;
  generatedAt?: string;
  downloadUrl: string;
}

export interface ApiReportPending {
  eventId: string;
  jobId: string;
  status: "processing" | "queued" | "failed";
  retryAfterSeconds?: number;
  errorMessage?: string;
}

export type ApiReport = ApiReportReady | ApiReportPending;

export interface ApiReportResponse {
  meta: ApiMeta;
  report: ApiReport;
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
 *  strings, not `{segmentId, segmentName}` objects — the backend never resolves names.
 *  `congestionWarning`/`recommend_public_transit` are computed in `decide_accident`'s
 *  `decision.result` but never copied into this object by the handler, so they don't exist
 *  on the wire at all (see docs/frontend-backend-coordination-issues.md). */
export interface ApiReroute {
  mainRoute: string | null;
  secondaryRoutes: string[];
  excluded: ApiRerouteExcluded[];
}

export interface ApiDecisionListItem {
  decisionId: string;
  sopSectionId?: string;
  kind: string;
  locationId: string;
  eventId: string | null;
  summary: {
    aiText: string;
    sopRefs?: string[];
  };
  recommendedActions: string[];
  /** Only non-null for `kind === "accident"` (decision/handler.py:40); a plain minute count,
   *  not an object — the base/penalty breakdown (`agent/facts.py`'s `ete_base`/`ete_penalty`)
   *  is computed backend-side but never surfaced on this endpoint. */
  estimatedRecovery: number | null;
  reroute: ApiReroute | null;
  publicMessage?: string;
}

export interface ApiDecisionListResponse {
  meta: ApiMeta;
  focus?: { locationId: string };
  situationSummary?: string;
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

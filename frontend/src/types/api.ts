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

/** `ApiReportReady.downloadUrl`（例如 "/internal/emergency-reports/{date}/{eventId}/
 *  report-v1.json"）指向的檔案內容本身——對照 backend/service/report_builder.py 的
 *  build_and_save_report() 寫入格式。
 *
 *  目前無法從前端直接 fetch：downloadUrl 指到 internal-results bucket，該 bucket 在
 *  terraform/storage.tf 設了 aws_s3_bucket_public_access_block（完全封鎖公開存取），
 *  且 terraform/api.tf 的 API Gateway route table 也沒有任何 "/internal/*" 對應路由——
 *  這條路徑目前是後端回應裡一個寫好但打不通的欄位，不是前端可以修的問題（report/
 *  handler.py 本身已經有 S3 client，只是用 head_object 探測是否存在，並未把內容讀出來
 *  塞進回應）。留著這個型別只是記錄「檔案內容長什麼樣」，供之後後端把內容直接回傳、
 *  或前端拿到可用下載機制時對照使用。 */
export interface ApiIncidentReportContent {
  eventId: string;
  sopSectionId?: string;
  generatedAt: string;
  incident: {
    type: string;
    location: string;
    affectedSegment: string;
    status: string;
    severity: string;
    description: string;
  };
  classification?: Record<string, unknown>;
  /** AI/規則產生的完整研判說明；`source: "fallback"` 時代表當下沒有可用 LLM，改用 SOP 規則生成。 */
  reasoning: string;
  publicMessage?: string;
  source: string;
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

import { API_BASE_URL } from "../config";
import type {
  ApiChatRequest,
  ApiChatResponse,
  ApiCityStateResponse,
  ApiCreateIncidentRequest,
  ApiCreateIncidentResponse,
  ApiDecisionQueryResponse,
  ApiErrorResponse,
  ApiPublicationRequest,
  ApiPublicationResponse,
  ApiReportResponse,
} from "../types/api";

export class ApiError extends Error {
  code: string;
  status: number;
  requestId?: string;
  retryAfterSeconds?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const API_BASE = API_BASE_URL.replace(/\/+$/, "");

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${API_BASE}${normalizedPath}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!res.ok) {
    let body: ApiErrorResponse | null = null;
    try {
      body = (await res.json()) as ApiErrorResponse;
    } catch {
      // 非 JSON 錯誤內容，忽略解析失敗
    }
    throw new ApiError(
      res.status,
      body?.error?.code ?? "UNKNOWN_ERROR",
      body?.error?.message ?? `Request failed: ${res.status}`,
      body?.error?.requestId,
      body?.error?.retryAfterSeconds,
    );
  }

  return (await res.json()) as T;
}

/** 1. GET /api/city-state */
export function getCityState(scenarioAt: string): Promise<ApiCityStateResponse> {
  return apiFetch<ApiCityStateResponse>(
    `/city-state?scenarioAt=${encodeURIComponent(scenarioAt)}`,
  );
}

/** 2. POST /api/incidents */
export function createIncident(
  payload: ApiCreateIncidentRequest,
): Promise<ApiCreateIncidentResponse> {
  return apiFetch<ApiCreateIncidentResponse>("/incidents", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** 3. GET /api/incidents/{eventId}/report */
export function getIncidentReport(
  eventId: string,
  format: "json" | "pdf",
  scenarioAt?: string,
): Promise<ApiReportResponse> {
  const params = new URLSearchParams({ format });
  if (scenarioAt) params.set("scenarioAt", scenarioAt);
  return apiFetch<ApiReportResponse>(
    `/incidents/${encodeURIComponent(eventId)}/report?${params.toString()}`,
  );
}

/**
 * 4. GET /api/decisions
 * 404 DECISION_NOT_READY 是預期中的正常狀態（尚未有排程結果），回傳 null 而非拋例外，
 * 呼叫端應該 fallback 回本地 rule engine，見 docs/frontend-backend-coordination-issues.md 第 1、2 項。
 */
export async function getDecision(
  scenarioAt: string,
  locationId: string,
): Promise<ApiDecisionQueryResponse | null> {
  try {
    return await apiFetch<ApiDecisionQueryResponse>(
      `/decisions?scenarioAt=${encodeURIComponent(scenarioAt)}&locationId=${encodeURIComponent(locationId)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && err.code === "DECISION_NOT_READY") return null;
    throw err;
  }
}

/** 5. POST /api/chat/messages */
export function postChatMessage(payload: ApiChatRequest): Promise<ApiChatResponse> {
  return apiFetch<ApiChatResponse>("/chat/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** 6. POST /api/publication */
export function publishAlert(payload: ApiPublicationRequest): Promise<ApiPublicationResponse> {
  return apiFetch<ApiPublicationResponse>("/publication", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

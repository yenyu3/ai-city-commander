import type {
  AlertRecord,
  ChatMessage,
  CrowdSnapshot,
  LaneStatus,
  RerouteSnapshot,
  RoadSegment,
  Tier,
  TrafficSnapshot,
  ViewerMode,
} from "../types";
import type {
  ApiAiDecision,
  ApiChatAnswer,
  ApiCrowdItem,
  ApiReroute,
  ApiTrafficItem,
} from "../types/api";

const TIERS: Tier[] = ["Normal", "B", "A"];
function coerceTier(tier: string | undefined): Tier | undefined {
  return tier && (TIERS as string[]).includes(tier) ? (tier as Tier) : undefined;
}

/** GET /api/city-state 的 traffic[] -> 前端 TrafficSnapshot[]。roadName 為本地 join（見 types.ts 註記）。 */
export function adaptTraffic(
  items: ApiTrafficItem[],
  segmentDefs: Map<string, RoadSegment>,
): TrafficSnapshot[] {
  return items.map((item) => ({
    observedAt: item.observedAt,
    segmentId: item.segmentId,
    roadName: segmentDefs.get(item.segmentId)?.name ?? item.segmentId,
    avgSpeedKph: item.avgSpeedKph,
    vehicleCount: item.vehicleCount,
    saturationScore: item.saturationScore,
    laneStatus: item.laneStatus as LaneStatus,
    tier: coerceTier(item.tier),
  }));
}

/** GET /api/city-state 的 crowd[] -> 前端 CrowdSnapshot[]。locationName 為本地 join（見 types.ts 註記）。 */
export function adaptCrowd(
  items: ApiCrowdItem[],
  stationNames: Record<string, string>,
): CrowdSnapshot[] {
  return items.map((item) => ({
    observedAt: item.observedAt,
    stationId: item.stationId,
    locationName: stationNames[item.stationId] ?? item.stationId,
    userCount: item.userCount,
    stayTimeAvgMinutes: item.stayTimeAvgMinutes,
    growthRate: item.growthRate,
    roamingUserPct: item.roamingUserPct,
  }));
}

/** POST /api/chat/messages 的 answer -> 前端 ChatMessage。id 由呼叫端（store）產生以維持既有 id 慣例。 */
export function adaptChatAnswer(id: string, answer: ApiChatAnswer, audience: ViewerMode): ChatMessage {
  return {
    id,
    role: "assistant",
    text: answer.text,
    audience,
    sopRefs: answer.sopRefs,
    ruleResult: answer.ruleResult,
    createdAt: Date.parse(answer.createdAt) || Date.now(),
  };
}

const KNOWN_ALERT_KINDS: AlertRecord["kind"][] = [
  "city_response",
  "accident",
  "mrt_diversion",
  "dome_dispersal",
  "signal_failure",
  "multilingual",
];

function coerceAlertKind(kind: string): AlertRecord["kind"] {
  if ((KNOWN_ALERT_KINDS as string[]).includes(kind)) return kind as AlertRecord["kind"];
  console.warn(`[apiAdapter] 未知的 decision kind "${kind}"，暫以 "accident" 顯示`);
  return "accident";
}

function adaptReroute(reroute: ApiReroute | null): RerouteSnapshot | undefined {
  if (!reroute) return undefined;
  return {
    primaryRouteName: reroute.primaryRoute
      ? (reroute.primaryRoute.segmentName ?? reroute.primaryRoute.segmentId)
      : null,
    secondaryRouteNames: (reroute.secondaryRoutes ?? []).map(
      (r) => r.segmentName ?? r.segmentId,
    ),
    excluded: (reroute.excluded ?? []).map((e) => ({
      segmentName: e.segmentName ?? e.segmentId,
      reason: e.reason,
    })),
    congestionWarning: reroute.congestionWarning ?? false,
  };
}

/**
 * GET /api/decisions 的 aiDecision -> AlertRecord 的部分欄位，供呼叫端跟本地 rule engine
 * 已產生的 alert 做 `{ ...localAlert, ...adaptDecisionToPartialAlert(decision) }` 合併（後端為權威）。
 *
 * `metrics`/`estimatedRecovery`/`signalCoordination`/`crossSystemCoordination`/
 * `publicationEligibility` 後端範例目前皆為空物件、schema 未定案，故不在此映射，
 * 見 docs/frontend-backend-coordination-issues.md 第 9、11 項。
 */
export function adaptDecisionToPartialAlert(decision: ApiAiDecision): Partial<AlertRecord> {
  const partial: Partial<AlertRecord> = {
    kind: coerceAlertKind(decision.summary.kind),
    title: decision.summary.title,
    llmText: decision.summary.aiText,
  };

  if (decision.summary.sopRefs && decision.summary.sopRefs.length > 0) {
    partial.sopRef = decision.summary.sopRefs.join(" / ");
  }
  if (decision.recommendedActions.length > 0) {
    partial.actions = decision.recommendedActions;
  }
  const reroute = adaptReroute(decision.reroute);
  if (reroute) partial.reroute = reroute;
  if (decision.reasoningSteps.length > 0) {
    partial.reasoningSteps = decision.reasoningSteps.map((s) => ({ ...s }));
  }

  return partial;
}

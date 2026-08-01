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
  ApiDecisionListItem,
  ApiReroute,
  ApiTrafficItem,
} from "../types/api";

const TIERS: Tier[] = ["Normal", "B", "A"];
function coerceTier(tier: string | undefined): Tier | undefined {
  return tier && (TIERS as string[]).includes(tier) ? (tier as Tier) : undefined;
}

/** GET /api/city-state traffic[] -> frontend TrafficSnapshot[]. roadName is joined locally. */
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

/** GET /api/city-state crowd[] -> frontend CrowdSnapshot[]. locationName is joined locally. */
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

/** POST /api/chat/messages answer -> frontend ChatMessage. */
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
  if (kind === "congestion") return "city_response";
  if ((KNOWN_ALERT_KINDS as string[]).includes(kind)) return kind as AlertRecord["kind"];
  console.warn(`[apiAdapter] Unknown decision kind "${kind}"; falling back to "accident"`);
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
 * GET /api/decisions aiDecision -> fields that can enrich an existing frontend alert.
 * The alert source still comes from the frontend rule engine until the backend exposes
 * an active-alert/location list API.
 */
export function adaptDecisionToPartialAlert(decision: ApiAiDecision): Partial<AlertRecord> {
  const partial: Partial<AlertRecord> = {
    kind: coerceAlertKind(decision.summary.kind ?? "accident"),
    title: decision.summary.title ?? decision.locationContext.locationName,
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

export function adaptDecisionListItemToPartialAlert(
  decision: ApiDecisionListItem,
  locationName: string,
): Partial<AlertRecord> {
  const partial: Partial<AlertRecord> = {
    kind: coerceAlertKind(decision.kind),
    title: locationName,
    llmText: decision.summary.aiText,
    publicMessage: decision.publicMessage,
  };

  if (decision.summary.sopRefs && decision.summary.sopRefs.length > 0) {
    partial.sopRef = decision.summary.sopRefs.join(" / ");
  }
  if (decision.recommendedActions.length > 0) {
    partial.actions = decision.recommendedActions;
  }
  const reroute = adaptReroute(decision.reroute);
  if (reroute) partial.reroute = reroute;

  return partial;
}

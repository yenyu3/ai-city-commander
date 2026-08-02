import type {
  AlertRecord,
  ChatMessage,
  CrowdSnapshot,
  LaneStatus,
  NarrativeSummary,
  RerouteSnapshot,
  RoadSegment,
  Tier,
  TrafficSnapshot,
  ViewerMode,
} from "../types";
import type {
  ApiChatAnswer,
  ApiCrowdItem,
  ApiDecisionListItem,
  ApiGovernmentSummary,
  ApiNarrativeSummary,
  ApiReasoningStep,
  ApiReroute,
  ApiTrafficItem,
} from "../types/api";

const TIERS: Tier[] = ["Normal", "B", "A"];
function coerceTier(tier: string | undefined): Tier | undefined {
  return tier && (TIERS as string[]).includes(tier) ? (tier as Tier) : undefined;
}

type LocationNameMap = Record<string, string>;

function buildLocationNameResolver(
  segmentDefs: Map<string, RoadSegment>,
  stationNames: LocationNameMap,
): (locationId: string) => string {
  return (locationId) =>
    segmentDefs.get(locationId)?.name ?? stationNames[locationId] ?? locationId;
}

function replaceLocationIds(
  text: string | undefined,
  resolveName: (locationId: string) => string,
): string {
  if (!text) return text ?? "";
  return text.replace(/\b(?:RD_TPE_\d+|BS_[A-Z0-9_]+)\b/g, (id) => resolveName(id));
}

function localizeReasoningStep(
  step: ApiReasoningStep,
  resolveName: (locationId: string) => string,
): ApiReasoningStep {
  return {
    ...step,
    title: replaceLocationIds(step.title, resolveName),
    detail: replaceLocationIds(step.detail, resolveName),
  };
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
  stationNames: LocationNameMap,
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
    reasoningSteps: answer.reasoningSteps,
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

/** decision/handler.py's reroute.mainRoute/secondaryRoutes/excluded are bare segmentId
 *  strings (see types/api.ts's ApiReroute doc comment) — names have to be resolved locally
 *  from segmentDefs, same as every other segmentId the API hands back. */
function adaptReroute(
  reroute: ApiReroute | null,
  segmentDefs: Map<string, RoadSegment>,
  resolveName: (locationId: string) => string,
): RerouteSnapshot | undefined {
  if (!reroute) return undefined;
  const nameOf = (segmentId: string) => segmentDefs.get(segmentId)?.name ?? resolveName(segmentId);
  return {
    primaryRouteName: reroute.mainRoute ? nameOf(reroute.mainRoute) : null,
    secondaryRouteNames: reroute.secondaryRoutes.map(nameOf),
    excluded: reroute.excluded.map((e) => ({
      segmentName: nameOf(e.segment_id),
      reason: replaceLocationIds(e.reason, resolveName),
    })),
    // 後端 decide_accident 有算出 congestion_warning，但 decision/handler.py 沒把它塞進
    // reroute 物件回傳，這支 API 目前沒有這個資料可用（見 coordination doc）。
    congestionWarning: false,
  };
}

export function adaptDecisionListItemToPartialAlert(
  decision: ApiDecisionListItem,
  locationName: string,
  segmentDefs: Map<string, RoadSegment>,
  stationNames: LocationNameMap = {},
): Partial<AlertRecord> {
  const resolveName = buildLocationNameResolver(segmentDefs, stationNames);
  const partial: Partial<AlertRecord> = {
    kind: coerceAlertKind(decision.kind),
    title: replaceLocationIds(decision.title ?? locationName, resolveName),
    llmText: replaceLocationIds(decision.summary.aiText, resolveName),
    publicMessage: decision.publicMessage
      ? replaceLocationIds(decision.publicMessage, resolveName)
      : undefined,
  };

  if (decision.summary.sopRefs && decision.summary.sopRefs.length > 0) {
    partial.sopRef = decision.summary.sopRefs.join(" / ");
  }

  if (decision.reasoningSteps.length > 0) {
    partial.reasoningSteps = decision.reasoningSteps.map((step) =>
      localizeReasoningStep(step, resolveName),
    );
  } else if (decision.summary.aiText) {
    // fallback：後端沒有 reasoningSteps 時補一個結論步驟，避免 ReasoningChain 留白
    partial.reasoningSteps = [{
      order: 1,
      status: "final",
      title: "AI 決策結論",
      detail: replaceLocationIds(decision.summary.aiText, resolveName),
      sopRef: partial.sopRef,
    }];
  }

  if (decision.recommendedActions.length > 0) {
    partial.actions = decision.recommendedActions.map((action) =>
      replaceLocationIds(action, resolveName),
    );
  }

  if (decision.estimatedRecovery !== null) {
    partial.ete = decision.estimatedRecovery.ete;
    partial.eteBase = decision.estimatedRecovery.base;
    partial.etePenalty = decision.estimatedRecovery.penalty;
  }

  if (decision.segmentMetrics) {
    partial.segmentMetrics = {
      ...decision.segmentMetrics,
      segmentName: replaceLocationIds(decision.segmentMetrics.segmentName, resolveName),
    };
  }

  if (decision.signalCoordination) {
    partial.signalCoordination = {
      signalTimings: decision.signalCoordination.signalTimings.map((row) => ({
        ...row,
        intersectionName: replaceLocationIds(row.intersectionName, resolveName),
        goal: replaceLocationIds(row.goal, resolveName),
      })),
    };
  }

  if (decision.crossSystemCoordination) {
    partial.crossSystemCoordination = {
      interAgencyActions: decision.crossSystemCoordination.interAgencyActions.map((action) => ({
        ...action,
        text: replaceLocationIds(action.text, resolveName),
      })),
    };
  }

  if (decision.eventId) {
    partial.sourceIncidentId = decision.eventId;
  }

  const reroute = adaptReroute(decision.reroute, segmentDefs, resolveName);
  if (reroute) partial.reroute = reroute;

  return partial;
}

/** GET /api/decisions government/citizen -> frontend NarrativeSummary. */
export function adaptNarrativeSummary(
  summary: ApiNarrativeSummary | ApiGovernmentSummary,
  segmentDefs: Map<string, RoadSegment>,
  stationNames: LocationNameMap = {},
): NarrativeSummary {
  const gov = summary as ApiGovernmentSummary;
  const resolveName = buildLocationNameResolver(segmentDefs, stationNames);
  return {
    focusLocationId: summary.focusLocationId,
    headline: replaceLocationIds(summary.headline, resolveName),
    text: replaceLocationIds(summary.text, resolveName),
    recommendedActions: summary.recommendedActions.map((action) =>
      replaceLocationIds(action, resolveName),
    ),
    estimatedRecovery: summary.estimatedRecovery.map((item) => ({
      ...item,
      locationId: resolveName(item.locationId),
    })),
    prioritizedDecisionIds: summary.prioritizedDecisionIds,
    sopRefs: gov.sopRefs,
    signalCoordination: gov.signalCoordination?.map((row) => ({
      ...row,
      intersectionName: replaceLocationIds(row.intersectionName, resolveName),
      goal: replaceLocationIds(row.goal, resolveName),
    })),
    crossSystemCoordination: gov.crossSystemCoordination?.map((action) => ({
      ...action,
      text: replaceLocationIds(action.text, resolveName),
    })),
    publicationEligibleLocationIds: gov.publicationEligibleLocationIds?.map(resolveName),
  };
}

import { create } from "zustand";
import { DATA_SOURCE } from "../config";
import { loadAllData } from "../data/loadData";
import {
  isAccidentTrigger,
  selectEvacuationRoute,
} from "../engine/accidentResponse";
import {
  checkCityResponse,
  CITY_TRIGGER_SEGMENTS,
  getTier,
} from "../engine/congestionTier";
import { checkDomeDispersal } from "../engine/domeDispersal";
import { calcETE } from "../engine/ete";
import { checkMrtDiversion } from "../engine/mrtDiversion";
import { checkMultilingualNeeded } from "../engine/multilingualCheck";
import { checkSignalFailure } from "../engine/signalFailure";
import {
  adaptChatAnswer,
  adaptCrowd,
  adaptDecisionListItemToPartialAlert,
  adaptNarrativeSummary,
  adaptTraffic,
} from "../services/apiAdapter";
import * as apiClient from "../services/apiClient";
import { runWhatIf } from "../services/chatEngine";
import {
  llmAdapter,
  type PublicContext,
  type StructuredEvent,
} from "../services/llmAdapter";
import type {
  AlertRecord,
  ChatMessage,
  CrowdSnapshot,
  FieldInspectorLocateStatus,
  FieldInspectorPosition,
  LiveIncident,
  NarrativeSummary,
  ReasoningStep,
  RoadPathDef,
  RoadSegment,
  Tier,
  TrafficSnapshot,
  ViewerMode,
} from "../types";
import type {
  ApiDecisionListItem,
  ApiDecisionQueryResponse,
} from "../types/api";
import {
  computeTimeOffsetMs,
  parseTimestamp,
  reformatEmbeddedTimestamp,
  timePct,
  toScenarioAt,
} from "../utils/timeUtils";

export interface SegmentRuntimeState {
  segmentId: string;
  name: string;
  saturation: number;
  avgSpeed: number;
  vehicleCount: number;
  laneStatus: string;
  tier: Tier;
  isCityTrigger: boolean;
  isEvacuationMain: boolean;
  isEvacuationSecondary: boolean;
  isIncidentSource: boolean;
}

export interface StationRuntimeState {
  stationId: string;
  name: string;
  userCount: number;
  growthRate: number;
  roamingPct: number;
  stayTimeAvg: number;
}

function latestByTimestamp<T extends { observedAt: string }>(
  rows: T[],
  timestamp: string,
): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (row.observedAt <= timestamp) {
      if (!best || row.observedAt > best.observedAt) best = row;
    }
  }
  return best;
}

function segToName(segments: Map<string, RoadSegment>, id: string): string {
  return segments.get(id)?.name ?? id;
}

/** BS_ prefixed ids are crowd-monitoring stations, everything else is a road segment. */
function locationTypeForId(id: string): "segment" | "station" {
  return id.startsWith("BS_") ? "station" : "segment";
}

// Demo ticks are sampled unevenly (hourly early on, down to 10-15min later). The progress
// bar maps left% to real elapsed time linearly (see timePct), so for the playhead to cross
// it at a constant pixel velocity, each step's real playback duration must be proportional
// to the share of the total time span that step covers — not a fixed ms per tick, which
// would speed through coarse stretches and crawl through dense ones. `ticks.length - 1`
// keeps the total playthrough duration at a given speed close to the previous fixed-interval
// design (sum of all step gaps == the full span, so the proportions sum to 1).
export function computeStepDurationMs(
  ticks: string[],
  fromTs: string,
  toTs: string,
  playbackSpeed: number,
): number {
  const totalSpanMs =
    parseTimestamp(ticks[ticks.length - 1]) - parseTimestamp(ticks[0]);
  if (totalSpanMs <= 0) return playbackSpeed;
  const gapMs = parseTimestamp(toTs) - parseTimestamp(fromTs);
  return (gapMs / totalSpanMs) * (ticks.length - 1) * playbackSpeed;
}

/** Fresh full duration for the leg starting at `tickIndex`, or 0 if it's the last tick. */
function computeLegDurationMs(
  ticks: string[],
  tickIndex: number,
  playbackSpeed: number,
): number {
  if (tickIndex >= ticks.length - 1) return 0;
  return computeStepDurationMs(
    ticks,
    ticks[tickIndex],
    ticks[tickIndex + 1],
    playbackSpeed,
  );
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

function getInitialViewerMode(): ViewerMode {
  if (typeof window === "undefined") return "government";
  const saved = window.localStorage.getItem("viewerMode");
  return saved === "public" || saved === "government" ? saved : "government";
}

export const DEFAULT_PLAYBACK_SPEED_MS = 500;

const API_SCENARIO_START = "2026-05-20 17:00";
const API_SCENARIO_END = "2026-05-20 23:00";
const API_SCENARIO_STEP_MINUTES = 5;
const decisionRequestKeys = new Set<string>();
const PROCESSED_NOTICES_KEY = "processedNoticeIds";
const PERSISTED_INCIDENTS_KEY = "persistedIncidents";

function loadPersistedIncidents(): LiveIncident[] {
  try {
    const raw = localStorage.getItem(PERSISTED_INCIDENTS_KEY);
    return raw ? (JSON.parse(raw) as LiveIncident[]) : [];
  } catch {
    return [];
  }
}

function savePersistedIncident(incident: LiveIncident): void {
  try {
    const existing = loadPersistedIncidents();
    if (!existing.some((i) => i.eventId === incident.eventId)) {
      existing.push(incident);
    }
    localStorage.setItem(PERSISTED_INCIDENTS_KEY, JSON.stringify(existing));
  } catch {
    // ignore
  }
}

function loadProcessedNotices(): Set<string> {
  try {
    const raw = localStorage.getItem(PROCESSED_NOTICES_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveProcessedNotice(noticeId: string): void {
  try {
    const existing = loadProcessedNotices();
    existing.add(noticeId);
    localStorage.setItem(PROCESSED_NOTICES_KEY, JSON.stringify([...existing]));
  } catch {
    // ignore
  }
}

function buildApiScenarioTicks(): string[] {
  const [date, startTime] = API_SCENARIO_START.split(" ");
  const [, endTime] = API_SCENARIO_END.split(" ");
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  const startTotal = startHour * 60 + startMinute;
  const endTotal = endHour * 60 + endMinute;
  const ticks: string[] = [];

  for (
    let total = startTotal;
    total <= endTotal;
    total += API_SCENARIO_STEP_MINUTES
  ) {
    const hour = String(Math.floor(total / 60)).padStart(2, "0");
    const minute = String(total % 60).padStart(2, "0");
    ticks.push(`${date} ${hour}:${minute}`);
  }

  return ticks;
}

function getDefaultApiScenarioTime(): string {
  return API_SCENARIO_START;
}

interface AppState {
  isLoading: boolean;
  loadError: string | null;
  viewerMode: ViewerMode;
  mapExpanded: boolean;
  selectedSegmentId: string | null;
  selectedStationId: string | null;

  ticks: string[];
  tickIndex: number;
  currentTime: string;
  isPlaying: boolean;
  playbackSpeed: number; // ms per tick
  /** Real ms the glide from `tickIndex` to `tickIndex + 1` takes. Set to a fresh full duration
   *  whenever a new leg begins (seekTime/setPlaybackSpeed), and shrunk to the remaining time by
   *  `pause()` so resuming continues the same glide instead of restarting it. */
  legDurationMs: number;
  /** Date.now() when the current `legDurationMs` countdown started (reset on every leg change
   *  and on resume) — used by `pause()` to compute how much of the leg is left. */
  legStartedAt: number;
  /** Playhead left% frozen at the exact pause instant (interpolated between the current and
   *  next tick); null while playing or once a fresh seek/tick makes it stale. */
  frozenPlayheadPct: number | null;
  /** ms added to every raw scenario timestamp so the timeline reads as starting "now" (Taipei time). */
  timeOffsetMs: number;

  traffic: TrafficSnapshot[];
  crowd: CrowdSnapshot[];
  segmentDefs: Map<string, RoadSegment>;
  allIncidents: LiveIncident[];
  /** 站名對照表；api 模式不補 demo 站名，後端未提供時直接顯示 stationId。 */
  stationNames: Record<string, string>;

  segments: Record<string, SegmentRuntimeState>;
  stations: Record<string, StationRuntimeState>;

  roadPaths: Map<string, RoadPathDef>;
  stationCoords: Record<string, [number, number]>;
  mapCenter: [number, number];

  activeIncidents: LiveIncident[];
  injectedIncidentIds: Set<string>;
  incidentEte: Record<string, number>;
  alerts: AlertRecord[];
  /** The alert id that the right panel should display — tracks the most recent alert whose
   *  timestamp is <= currentTime, so the decision panel stays in sync with the timeline. */
  activeAlertId: string | null;
  /** True while the decision selector's "綜合摘要" option is active — drives the map's alert
   *  markers to emphasize every unresolved alert at once instead of just `activeAlertId`. */
  decisionSummarySelected: boolean;
  decisionSelectionId: string | null;
  /** `${kind}:${entityId}:${timestamp}` fingerprints of rule-based alerts already fired, so
   *  scrubbing backward past a trigger point and playing forward again doesn't re-fire the
   *  same historical crossing as a duplicate alert. */
  firedAlertKeys: Set<string>;
  /** Alert ids ready to surface on-screen (timeline marker, map toast). */
  displayedAlertIds: Set<string>;
  reasoningLog: ReasoningStep[];
  chatMessages: ChatMessage[];
  fieldInspectorPosition: FieldInspectorPosition | null;
  fieldInspectorLocateStatus: FieldInspectorLocateStatus;
  /** GET /api/decisions 回應的 government/citizen NarrativeSummary（city-sweep 來源）。 */
  governmentSummary: NarrativeSummary | null;
  citizenSummary: NarrativeSummary | null;
  /** POST /api/incidents 觸發的 notice 裡的 government/citizen NarrativeSummary（incident 來源）。
   *  有值時優先於 governmentSummary/citizenSummary 顯示。 */
  incidentGovernmentSummary: NarrativeSummary | null;
  incidentCitizenSummary: NarrativeSummary | null;

  init(): Promise<void>;
  play(): void;
  pause(): void;
  /** Jumps back to the first tick, re-runs it as a clean slate (clears alerts, injected
   *  incidents, fired-rule fingerprints, active incidents), and starts playing again. */
  restart(): void;
  setPlaybackSpeed(ms: number): void;
  advanceTime(): void;
  seekTime(timestamp: string): void;
  selectAlert(alertId: string): void;
  injectIncident(incidentId: string, suppressToast?: boolean): void;
  addIncidents(incidents: LiveIncident[]): void;
  /** 統一的事件注入入口：demo 模式行為與 injectIncident 相同；api 模式下另外呼叫
   *  POST /api/incidents 並在背景嘗試用 GET /api/decisions 升級對應 alert（見協調文件第 1、2 項）。 */
  submitIncident(incident: LiveIncident): void;
  sendChatMessage(
    question: string,
    audience?: ViewerMode,
    locationContext?: FieldInspectorPosition | null,
  ): void;
  setViewerMode(mode: ViewerMode): void;
  toggleMapExpanded(): void;
  setSelectedSegment(id: string | null): void;
  setSelectedStation(id: string | null): void;
  setFieldInspectorPosition(position: FieldInspectorPosition | null): void;
  setFieldInspectorLocateStatus(status: FieldInspectorLocateStatus): void;
}

function computeSegmentState(
  segmentDefs: Map<string, RoadSegment>,
  traffic: TrafficSnapshot[],
  timestamp: string,
): Record<string, SegmentRuntimeState> {
  const result: Record<string, SegmentRuntimeState> = {};
  for (const [id, def] of segmentDefs) {
    const rows = traffic.filter((t) => t.segmentId === id);
    const latest = latestByTimestamp(rows, timestamp);
    const saturation = latest?.saturationScore ?? 0;
    result[id] = {
      segmentId: id,
      name: def.name,
      saturation,
      avgSpeed: latest?.avgSpeedKph ?? 0,
      vehicleCount: latest?.vehicleCount ?? 0,
      laneStatus: latest?.laneStatus ?? "Normal",
      // api 模式下 city-state 可能已附上壅塞分級；demo 模式沒有這個欄位，維持本地計算。
      tier: latest?.tier ?? getTier(saturation),
      isCityTrigger: CITY_TRIGGER_SEGMENTS.includes(id),
      isEvacuationMain: false,
      isEvacuationSecondary: false,
      isIncidentSource: false,
    };
  }
  return result;
}

function computeStationState(
  crowd: CrowdSnapshot[],
  timestamp: string,
): Record<string, StationRuntimeState> {
  const ids = Array.from(new Set(crowd.map((c) => c.stationId)));
  const result: Record<string, StationRuntimeState> = {};
  for (const id of ids) {
    const rows = crowd.filter((c) => c.stationId === id);
    const latest = latestByTimestamp(rows, timestamp);
    if (!latest) continue;
    result[id] = {
      stationId: id,
      name: latest.locationName,
      userCount: latest.userCount,
      growthRate: latest.growthRate,
      roamingPct: latest.roamingUserPct,
      stayTimeAvg: latest.stayTimeAvgMinutes,
    };
  }
  return result;
}

function buildAccidentAlert(
  incident: LiveIncident,
  timestamp: string,
  segmentDefs: Map<string, RoadSegment>,
  segmentSaturation: Map<string, number>,
  timeOffsetMs: number,
  segmentsState: Record<string, SegmentRuntimeState>,
): { alert: AlertRecord; mainRoute: string | null; secondaryRoutes: string[] } {
  const route = selectEvacuationRoute(
    incident.affectedSegmentId,
    incident.location,
    segmentDefs,
    segmentSaturation,
  );

  const incidentSegName = segToName(segmentDefs, incident.affectedSegmentId);
  const mainRouteName = route.mainRoute
    ? segToName(segmentDefs, route.mainRoute)
    : "（無符合條件之替代路段）";

  const incidentSat = segmentSaturation.get(incident.affectedSegmentId) ?? 0;
  const mainSat = route.mainRoute
    ? (segmentSaturation.get(route.mainRoute) ?? 0)
    : incidentSat;
  const avgSaturation = route.mainRoute
    ? (incidentSat + mainSat) / 2
    : incidentSat;
  const { ete, base, penalty, breakdown } = calcETE(
    incident.severity,
    avgSaturation,
  );

  const steps: ReasoningStep[] = [];
  let order = 1;
  steps.push({
    order: order++,
    status: "info",
    title: `觸發車禍應變規則`,
    detail: `status=${incident.status} ∈ {Closed,Blocked,Restricted}、severity=${incident.severity} ∈ {High,Critical}、affected_segment=${incident.affectedSegmentId} 以 RD_ 開頭`,
    sopRef: "SOP §2",
  });

  const incidentSeg = segmentDefs.get(incident.affectedSegmentId);
  for (const altId of incidentSeg?.alternatives ?? []) {
    const excludedEntry = route.excluded.find((e) => e.segmentId === altId);
    if (excludedEntry) {
      steps.push({
        order: order++,
        status: "fail",
        title: `排除 ${segToName(segmentDefs, altId)}`,
        detail: excludedEntry.reason,
        sopRef: "SOP §2(a)",
      });
    } else if (altId === route.mainRoute) {
      steps.push({
        order: order++,
        status: "pass",
        title: `${segToName(segmentDefs, altId)} 通過篩選（上游、容量足夠）`,
        detail: `Saturation_Score = ${(segmentSaturation.get(altId) ?? 0).toFixed(2)}，為上游候選中最低者`,
        sopRef: "SOP §2(a)",
      });
    } else if (route.secondaryRoutes.includes(altId)) {
      steps.push({
        order: order++,
        status: "info",
        title: `${segToName(segmentDefs, altId)} 列為次要疏散（下游）`,
        detail: `相交路口位於事故點下游，須先經過事故點才能到達，僅列次要疏散`,
        sopRef: "SOP §2(a)",
      });
    }
  }

  steps.push({
    order: order++,
    status: "final",
    title: `主疏散路徑：${mainRouteName}`,
    detail: breakdown,
    sopRef: "SOP §7",
  });

  const alert: AlertRecord = {
    id: nextId("alert"),
    timestamp,
    sourceIncidentId: incident.eventId,
    publicManifestUrl: incident.publicManifestUrl,
    publicNoticeUrl: incident.publicNoticeUrl,
    kind: "accident",
    title: `${incidentSegName} ${incident.status === "Closed" ? "封閉" : incident.status}`,
    ruleSummary: `${incidentSegName}封閉，請改道${mainRouteName}，預計延誤 ${ete} 分鐘`,
    actions: [
      route.mainRoute
        ? `主疏散路徑：引導車流改道至 ${mainRouteName}`
        : "無符合條件之替代路段，維持現場疏導",
      ...(route.secondaryRoutes.length > 0
        ? [
            `次要疏散路徑：${route.secondaryRoutes.map((id) => segToName(segmentDefs, id)).join("、")}`,
          ]
        : []),
      ...(route.congestionWarning
        ? ["主疏散路徑已壅塞，啟動「長綠燈時制」並建議併行大眾運輸"]
        : []),
      `CMS 發布：「${incidentSegName}封閉，請改道${mainRouteName}，預計延誤 ${ete} 分鐘」`,
    ],
    sopRef: "SOP §2 / §7",
    ete,
    eteBase: base,
    etePenalty: penalty,
    reasoningSteps: steps,
    segmentMetrics: {
      segmentName: incidentSegName,
      flowPcuh: segmentsState[incident.affectedSegmentId]?.vehicleCount ?? 0,
      saturation: incidentSat,
    },
    reroute: {
      primaryRouteName: route.mainRoute ? mainRouteName : null,
      secondaryRouteNames: route.secondaryRoutes.map((id) =>
        segToName(segmentDefs, id),
      ),
      excluded: route.excluded.map((e) => ({
        segmentName: segToName(segmentDefs, e.segmentId),
        reason: e.reason,
      })),
      congestionWarning: route.congestionWarning,
    },
    locationId: incident.affectedSegmentId,
    locationType: locationTypeForId(incident.affectedSegmentId),
  };

  const structured: StructuredEvent = {
    kind: "accident",
    title: alert.title,
    data: {
      segmentName: incidentSegName,
      incidentDesc: reformatEmbeddedTimestamp(
        incident.description,
        incident.occurredAt,
        timeOffsetMs,
      ),
      statusLabel: incident.status === "Closed" ? "全線封鎖" : incident.status,
      severity: incident.severity,
      mainRoute: mainRouteName,
      ete,
      congestionWarning: String(route.congestionWarning),
    },
    sopRef: "SOP §2 / §7",
  };

  llmAdapter.summarize(structured).then((text) => {
    useAppStore.setState((s) => ({
      alerts: s.alerts.map((a) =>
        a.id === alert.id ? { ...a, llmText: text } : a,
      ),
    }));
  });

  return {
    alert,
    mainRoute: route.mainRoute,
    secondaryRoutes: route.secondaryRoutes,
  };
}

/** 把目前的即時狀態壓成市民模式問答需要的可公開概況。 */
function buildPublicContext(
  state: AppState,
  nearbyRoad: { name: string; tier: string } | null,
): PublicContext {
  const busiest = Object.values(state.stations).sort(
    (a, b) => b.userCount - a.userCount,
  )[0];
  return {
    affectedRoads: Object.values(state.segments)
      .filter(
        (segment) => segment.tier !== "Normal" || segment.isIncidentSource,
      )
      .sort((a, b) => b.saturation - a.saturation)
      .map((segment) => ({ name: segment.name, tier: segment.tier })),
    busiestStation: busiest
      ? { name: busiest.name, userCount: busiest.userCount }
      : null,
    activeIncidentCount: state.activeIncidents.length,
    nearbyRoad,
  };
}

/** 把聊天輸入框上附加的小人位置 Context Tag，解析成路段名稱＋分級，供兩種模式的回答共用。 */
function resolveNearbyRoad(
  state: AppState,
  locationContext: FieldInspectorPosition | null | undefined,
): { name: string; tier: string } | null {
  const segment = locationContext?.nearestRoadId
    ? state.segments[locationContext.nearestRoadId]
    : undefined;
  return segment ? { name: segment.name, tier: segment.tier } : null;
}

function pushAlert(
  alert: AlertRecord,
  reasoningSteps?: ReasoningStep[],
  suppressToast = false,
) {
  useAppStore.setState((s) => ({
    alerts: [alert, ...s.alerts],
    activeAlertId: alert.id,
    decisionSummarySelected: false,
    decisionSelectionId: alert.id,
    reasoningLog: reasoningSteps ?? s.reasoningLog,
    displayedAlertIds:
      suppressToast || s.displayedAlertIds.has(alert.id)
        ? s.displayedAlertIds
        : new Set(s.displayedAlertIds).add(alert.id),
  }));
}

// Rule-based alerts (city tier, MRT diversion, dome dispersal, multilingual) fire on a
// prev-tick-vs-next-tick rising edge read from live store state. Scrubbing backward past a
// trigger point resets that comparison, so playing forward across the same point again would
// re-fire the same alert — dedupe by (rule, entity, timestamp) so the same historical crossing
// only ever produces one alert, while a genuinely later crossing (different timestamp) still can.
function tryFireOnce(key: string): boolean {
  if (useAppStore.getState().firedAlertKeys.has(key)) return false;
  useAppStore.setState((s) => ({
    firedAlertKeys: new Set(s.firedAlertKeys).add(key),
  }));
  return true;
}

/** 用 city-state API 回傳的單筆數值覆蓋本地 segment 的「即時數值」欄位，但保留
 *  isCityTrigger/isEvacuationMain/isEvacuationSecondary/isIncidentSource 等由
 *  injectIncident 在本地算出的旗標，避免非同步回應蓋掉期間發生的注入結果。 */
function checkIncidentResolution(
  trackedId: string,
  _timestamp: string,
  segments: Record<string, SegmentRuntimeState>,
  stations: Record<string, StationRuntimeState>,
): { elevated: boolean; recovered: boolean } {
  const segment = segments[trackedId];
  if (segment) {
    const elevated =
      segment.tier !== "Normal" ||
      segment.laneStatus === "Blocked" ||
      segment.laneStatus === "Critical" ||
      segment.saturation >= 0.85;
    return { elevated, recovered: !elevated };
  }

  const station = stations[trackedId];
  if (station) {
    const elevated = station.growthRate >= 0.3 || station.roamingPct >= 0.3;
    return { elevated, recovered: !elevated };
  }

  return { elevated: false, recovered: false };
}

function mergeApiSegmentData(
  local: SegmentRuntimeState,
  apiRow: TrafficSnapshot | undefined,
): SegmentRuntimeState {
  if (!apiRow) return local;
  const saturation = apiRow.saturationScore;
  return {
    ...local,
    saturation,
    avgSpeed: apiRow.avgSpeedKph,
    vehicleCount: apiRow.vehicleCount,
    laneStatus: apiRow.laneStatus,
    tier: apiRow.tier ?? getTier(saturation),
  };
}

function collectDecisionLocationIds(state: AppState): string[] {
  // 小人在場：只查小人所在路段
  if (state.fieldInspectorPosition?.nearestRoadId) {
    return [state.fieldInspectorPosition.nearestRoadId];
  }

  // 小人不在：打 global
  return ["global"];
}

function isDecisionProcessing(
  res: ApiDecisionQueryResponse,
): res is Extract<ApiDecisionQueryResponse, { processing: unknown }> {
  return "processing" in res;
}

function resolveDecisionLocationName(
  locationId: string,
  state: AppState,
): string {
  return (
    state.segmentDefs.get(locationId)?.name ??
    state.stationNames[locationId] ??
    locationId
  );
}

function upsertDecisionAlert(
  timestamp: string,
  locationId: string,
  decisionId: string,
  partial: Partial<AlertRecord>,
): void {
  useAppStore.setState((s) => {
    const existing = s.alerts.find(
      (a) => a.decisionId === decisionId || a.decisionLocationId === locationId,
    );
    const alert: AlertRecord = {
      id: existing?.id ?? nextId("alert"),
      timestamp,
      sourceIncidentId: partial.sourceIncidentId,
      decisionId,
      decisionLocationId: locationId,
      kind: partial.kind ?? "accident",
      title: partial.title ?? resolveDecisionLocationName(locationId, s),
      ruleSummary:
        partial.publicMessage ?? partial.llmText ?? partial.title ?? locationId,
      actions: partial.actions ?? [],
      llmText: partial.llmText,
      publicMessage: partial.publicMessage,
      sopRef: partial.sopRef,
      ete: partial.ete,
      eteBase: partial.eteBase,
      etePenalty: partial.etePenalty,
      reasoningSteps: partial.reasoningSteps,
      segmentMetrics: partial.segmentMetrics,
      reroute: partial.reroute,
      signalCoordination: partial.signalCoordination,
      crossSystemCoordination: partial.crossSystemCoordination,
      source: "city_sweep" as const,
    };

    if (existing) {
      return {
        alerts: s.alerts.map((a) =>
          a.id === existing.id ? { ...a, ...alert } : a,
        ),
        activeAlertId: existing.id,
        decisionSummarySelected: false,
        decisionSelectionId: existing.id,
        reasoningLog: partial.reasoningSteps ?? s.reasoningLog,
      };
    }

    return {
      alerts: [alert, ...s.alerts],
      activeAlertId: alert.id,
      decisionSummarySelected: false,
      decisionSelectionId: alert.id,
      displayedAlertIds: new Set(s.displayedAlertIds).add(alert.id),
      reasoningLog: partial.reasoningSteps ?? s.reasoningLog,
    };
  });
}

function scheduleDecisionRetry(
  timestamp: string,
  locationId: string,
  retryAfterSeconds = 10,
): void {
  window.setTimeout(
    () => {
      decisionRequestKeys.delete(`${toScenarioAt(timestamp)}:${locationId}`);
      void refreshDecisionForLocation(timestamp, locationId);
    },
    Math.max(1, retryAfterSeconds) * 1000,
  );
}

async function refreshDecisionForLocation(
  timestamp: string,
  locationId: string,
): Promise<void> {
  const scenarioAt = toScenarioAt(timestamp);
  const requestKey = `${scenarioAt}:${locationId}`;
  if (decisionRequestKeys.has(requestKey)) return;
  decisionRequestKeys.add(requestKey);

  try {
    const res = await apiClient.getDecision(scenarioAt, locationId);
    if (useAppStore.getState().currentTime !== timestamp) return;

    if (isDecisionProcessing(res)) {
      if (res.processing.status !== "failed") {
        scheduleDecisionRetry(
          timestamp,
          locationId,
          res.processing.retryAfterSeconds,
        );
      }
      return;
    }

    const state = useAppStore.getState();
    useAppStore.setState({
      governmentSummary: adaptNarrativeSummary(
        res.government,
        state.segmentDefs,
        state.stationNames,
      ),
      citizenSummary: adaptNarrativeSummary(
        res.citizen,
        state.segmentDefs,
        state.stationNames,
      ),
    });
    const decisionsToRender: ApiDecisionListItem[] = res.decisions;
    for (const decision of decisionsToRender) {
      const partial = adaptDecisionListItemToPartialAlert(
        decision,
        resolveDecisionLocationName(decision.locationId, state),
        state.segmentDefs,
        state.stationNames,
      );
      upsertDecisionAlert(
        timestamp,
        decision.locationId,
        decision.decisionId,
        partial,
      );
    }
  } catch (err) {
    console.warn(
      "[appStore] GET /api/decisions failed; keeping local decision state",
      err,
    );
  }
}

function refreshDecisionsFromApi(timestamp: string): void {
  const state = useAppStore.getState();
  if (DATA_SOURCE !== "api") return;

  const ids = collectDecisionLocationIds(state);
  if (ids.length === 0) return;

  for (const locationId of ids) {
    void refreshDecisionForLocation(timestamp, locationId);
  }
}

/**
 * api 模式下，在本地（demo 資料集算出的）segments/stations 已經同步 commit 之後，
 * 背景打 GET /api/city-state 拿真正的即時數值來升級畫面。demo 的 ticks 時間軸仍是
 * 資料來源（後端沒有「有效 scenarioAt 清單」API），只有數值改用後端回應，
 * 見 docs/frontend-backend-coordination-issues.md 第 1、5 項。
 */
async function refreshCityStateFromApi(timestamp: string): Promise<void> {
  try {
    const { segmentDefs, stationNames } = useAppStore.getState();
    const scenarioAt = toScenarioAt(timestamp);
    const res = await apiClient.getCityState(scenarioAt);
    // 時鐘可能已經前進到下一個 tick，過期回應直接捨棄。
    if (useAppStore.getState().currentTime !== timestamp) return;

    const trafficRows = adaptTraffic(res.traffic, segmentDefs);
    const crowdRows = adaptCrowd(res.crowd, stationNames);
    const trafficBySegment = new Map(
      trafficRows.map((t) => [t.segmentId, t] as const),
    );

    useAppStore.setState((s) => {
      const segments: Record<string, SegmentRuntimeState> = { ...s.segments };
      for (const row of trafficRows) {
        const def = segmentDefs.get(row.segmentId);
        const base = segments[row.segmentId] ?? {
          segmentId: row.segmentId,
          name: def?.name ?? row.roadName,
          saturation: 0,
          avgSpeed: 0,
          vehicleCount: 0,
          laneStatus: "Normal",
          tier: "Normal",
          isCityTrigger: CITY_TRIGGER_SEGMENTS.includes(row.segmentId),
          isEvacuationMain: false,
          isEvacuationSecondary: false,
          isIncidentSource: false,
        };
        segments[row.segmentId] = mergeApiSegmentData(
          base,
          trafficBySegment.get(row.segmentId),
        );
      }
      const stations: Record<string, StationRuntimeState> = { ...s.stations };
      for (const c of crowdRows) {
        stations[c.stationId] = {
          stationId: c.stationId,
          name: c.locationName,
          userCount: c.userCount,
          growthRate: c.growthRate,
          roamingPct: c.roamingUserPct,
          stayTimeAvg: c.stayTimeAvgMinutes,
        };
      }
      return {
        traffic: trafficRows,
        crowd: crowdRows,
        segments,
        stations,
      };
    });
    refreshDecisionsFromApi(timestamp);
  } catch (err) {
    console.warn(
      "[appStore] GET /api/city-state failed; keeping clean state",
      err,
    );
  }
}

/** Poll the public manifest every second; fetch and apply any unseen notices. */
function startManifestPolling(): () => void {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const currentTime = useAppStore.getState().currentTime;
      if (!currentTime) return;
      const date = currentTime.split(" ")[0].split("T")[0];
      const manifest = await apiClient.getPublicManifest(date);
      if (!manifest || stopped) return;

      const processed = loadProcessedNotices();
      const unseen = manifest.notices.filter((n) => !processed.has(n.noticeId));
      for (const entry of unseen) {
        const notice = await apiClient.getPublicNotice(date, entry.noticeId);
        if (!notice || stopped) continue;
        saveProcessedNotice(entry.noticeId);

        const state = useAppStore.getState();
        // Update summaries (most recent notice wins)
        useAppStore.setState({
          incidentGovernmentSummary: adaptNarrativeSummary(
            notice.government,
            state.segmentDefs,
            state.stationNames,
          ),
          incidentCitizenSummary: adaptNarrativeSummary(
            notice.citizen,
            state.segmentDefs,
            state.stationNames,
          ),
        });

        // Apply decisions: update existing alert or create new one
        for (const decision of notice.decisions) {
          const partial = adaptDecisionListItemToPartialAlert(
            decision,
            decision.title,
            state.segmentDefs,
            state.stationNames,
          );
          const eventId = notice.eventId;
          useAppStore.setState((s) => {
            const existing = s.alerts.find((a) => a.sourceIncidentId === eventId);
            if (existing) {
              return {
                alerts: s.alerts.map((a) =>
                  a.id === existing.id
                    ? { ...a, ...partial, source: "incident" as const }
                    : a,
                ),
              };
            }
            // No local alert yet — create one from the notice
            const alert: AlertRecord = {
              id: nextId("alert"),
              timestamp: currentTime,
              sourceIncidentId: eventId,
              kind: partial.kind ?? "accident",
              title: partial.title ?? decision.title,
              ruleSummary: partial.publicMessage ?? partial.llmText ?? decision.title,
              actions: partial.actions ?? [],
              llmText: partial.llmText,
              publicMessage: partial.publicMessage,
              sopRef: partial.sopRef,
              ete: partial.ete,
              eteBase: partial.eteBase,
              etePenalty: partial.etePenalty,
              reasoningSteps: partial.reasoningSteps,
              segmentMetrics: partial.segmentMetrics,
              reroute: partial.reroute,
              signalCoordination: partial.signalCoordination,
              crossSystemCoordination: partial.crossSystemCoordination,
              source: "incident" as const,
            };
            return {
              alerts: [alert, ...s.alerts],
              activeAlertId: alert.id,
              decisionSummarySelected: false,
              decisionSelectionId: alert.id,
              displayedAlertIds: new Set(s.displayedAlertIds).add(alert.id),
            };
          });
        }
      }
    } catch {
      // silent — manifest polling is best-effort
    } finally {
      if (!stopped) setTimeout(tick, 1000);
    }
  }

  void tick();
  return () => { stopped = true; };
}

/** Poll incident reports; incident-specific worker output does not live in GET /api/decisions. */
async function pollIncidentReport(
  eventId: string,
  scenarioAt: string,
): Promise<void> {
  const maxAttempts = 10;
  let delayMs = 3000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const res = await apiClient.getIncidentReport(
        eventId,
        "json",
        scenarioAt,
      );
      useAppStore.setState((s) => {
        const processing =
          res.report.status === "ready"
            ? { jobId: res.report.jobId, status: "ready" }
            : {
                jobId: res.report.jobId,
                status: res.report.status,
                retryAfterSeconds: res.report.retryAfterSeconds,
              };
        const updateIncident = (incident: LiveIncident): LiveIncident =>
          incident.eventId === eventId
            ? {
                ...incident,
                processing,
                reportDownloadUrl:
                  res.report.status === "ready"
                    ? res.report.downloadUrl
                    : incident.reportDownloadUrl,
              }
            : incident;
        return {
          allIncidents: s.allIncidents.map(updateIncident),
          activeIncidents: s.activeIncidents.map(updateIncident),
        };
      });
      if (res.report.status === "ready") {
        const date = scenarioAt.split("T")[0];
        const notice = await apiClient.getPublicNotice(
          date,
          `PUB_${eventId}_v1`,
        );
        if (notice) {
          const state = useAppStore.getState();
          useAppStore.setState({
            incidentGovernmentSummary: adaptNarrativeSummary(
              notice.government,
              state.segmentDefs,
              state.stationNames,
            ),
            incidentCitizenSummary: adaptNarrativeSummary(
              notice.citizen,
              state.segmentDefs,
              state.stationNames,
            ),
          });
          // Apply AI decisions from the notice back onto the local alert
          for (const decision of notice.decisions) {
            const partial = adaptDecisionListItemToPartialAlert(
              decision,
              decision.title,
              state.segmentDefs,
              state.stationNames,
            );
            useAppStore.setState((s) => ({
              alerts: s.alerts.map((a) =>
                a.sourceIncidentId === eventId
                  ? { ...a, ...partial, source: "incident" as const }
                  : a,
              ),
            }));
          }
        }
        return;
      }
      delayMs = Math.max(1, res.report.retryAfterSeconds ?? 3) * 1000;
    } catch (err) {
      console.warn(
        "[appStore] GET /api/incidents/{eventId}/report failed; keeping local incident alert",
        err,
      );
      return;
    }
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  isLoading: true,
  loadError: null,
  viewerMode: getInitialViewerMode(),
  mapExpanded: false,
  selectedSegmentId: null,
  selectedStationId: null,

  ticks: [],
  tickIndex: 0,
  currentTime: "",
  isPlaying: false,
  playbackSpeed: DEFAULT_PLAYBACK_SPEED_MS,
  legDurationMs: 0,
  legStartedAt: 0,
  frozenPlayheadPct: null,
  timeOffsetMs: 0,

  traffic: [],
  crowd: [],
  segmentDefs: new Map(),
  allIncidents: [],
  stationNames: {},

  segments: {},
  stations: {},

  roadPaths: new Map(),
  stationCoords: {},
  mapCenter: [121.5617, 25.0395],

  activeIncidents: [],
  injectedIncidentIds: new Set(),
  incidentEte: {},
  alerts: [],
  activeAlertId: null,
  decisionSummarySelected: false,
  decisionSelectionId: null,
  firedAlertKeys: new Set(),
  displayedAlertIds: new Set(),
  reasoningLog: [],
  chatMessages: [],
  fieldInspectorPosition: null,
  fieldInspectorLocateStatus: "idle",
  governmentSummary: null,
  citizenSummary: null,
  incidentGovernmentSummary: null,
  incidentCitizenSummary: null,

  async init() {
    try {
      const data = await loadAllData();
      if (DATA_SOURCE === "api") {
        decisionRequestKeys.clear();
        localStorage.removeItem(PROCESSED_NOTICES_KEY);
        localStorage.removeItem(PERSISTED_INCIDENTS_KEY);
        const ticks = buildApiScenarioTicks();
        const firstTime = ticks[0];
        const persistedIncidents: LiveIncident[] = [];
        set({
          isLoading: false,
          traffic: [],
          crowd: [],
          segmentDefs: data.segments,
          allIncidents: persistedIncidents,
          stationNames: data.stationNames,
          ticks,
          tickIndex: 0,
          currentTime: firstTime,
          legDurationMs: computeLegDurationMs(ticks, 0, get().playbackSpeed),
          legStartedAt: Date.now(),
          timeOffsetMs: 0,
          segments: {},
          stations: {},
          roadPaths: data.roadPaths,
          stationCoords: data.stationCoords,
          mapCenter: data.mapCenter,
          activeIncidents: [],
          injectedIncidentIds: new Set(),
          incidentEte: {},
          alerts: [],
          firedAlertKeys: new Set(),
          displayedAlertIds: new Set(),
          reasoningLog: [],
          chatMessages: [],
          governmentSummary: null,
          citizenSummary: null,
          incidentGovernmentSummary: null,
          incidentCitizenSummary: null,
        });
        // Inject persisted incidents immediately so alerts are restored
        for (const incident of persistedIncidents) {
          get().injectIncident(incident.eventId);
        }
        void refreshCityStateFromApi(firstTime);
        startManifestPolling();
        return;
      }

      const tickSet = new Set<string>();
      data.traffic.forEach((t) => tickSet.add(t.observedAt));
      data.crowd.forEach((c) => tickSet.add(c.observedAt));
      data.incidents.forEach((i) => tickSet.add(i.occurredAt));
      const ticks = Array.from(tickSet).sort();
      const firstTime = ticks[0];

      set({
        isLoading: false,
        traffic: data.traffic,
        crowd: data.crowd,
        segmentDefs: data.segments,
        allIncidents: data.incidents,
        stationNames: data.stationNames,
        ticks,
        tickIndex: 0,
        currentTime: firstTime,
        legDurationMs: computeLegDurationMs(ticks, 0, get().playbackSpeed),
        legStartedAt: Date.now(),
        timeOffsetMs: computeTimeOffsetMs(firstTime),
        segments: computeSegmentState(data.segments, data.traffic, firstTime),
        stations: computeStationState(data.crowd, firstTime),
        roadPaths: data.roadPaths,
        stationCoords: data.stationCoords,
        mapCenter: data.mapCenter,
      });
    } catch (err) {
      set({ isLoading: false, loadError: String(err) });
    }
  },

  play() {
    // legDurationMs already holds whatever's left of the current leg (a fresh full duration,
    // or the remainder left over from a prior pause) — only the countdown's start needs resetting.
    set({ isPlaying: true, legStartedAt: Date.now(), frozenPlayheadPct: null });
  },

  pause() {
    const { isPlaying, ticks, tickIndex, legDurationMs, legStartedAt } = get();
    if (!isPlaying) return;
    if (tickIndex >= ticks.length - 1) {
      set({ isPlaying: false });
      return;
    }
    const start = ticks[0];
    const end = ticks[ticks.length - 1];
    const fraction =
      legDurationMs > 0
        ? Math.min(1, Math.max(0, (Date.now() - legStartedAt) / legDurationMs))
        : 1;
    const fromPct = timePct(ticks[tickIndex], start, end);
    const toPct = timePct(ticks[tickIndex + 1], start, end);
    set({
      isPlaying: false,
      legDurationMs: Math.max(0, legDurationMs - (Date.now() - legStartedAt)),
      frozenPlayheadPct: fromPct + (toPct - fromPct) * fraction,
    });
  },

  restart() {
    const { ticks, traffic, crowd, segmentDefs, playbackSpeed } = get();
    if (ticks.length === 0) return;
    const firstTime = ticks[0];
    if (DATA_SOURCE === "api") {
      decisionRequestKeys.clear();
      set({
        tickIndex: 0,
        currentTime: firstTime,
        activeIncidents: [],
        injectedIncidentIds: new Set(),
        incidentEte: {},
        alerts: [],
        activeAlertId: null,
        decisionSummarySelected: false,
        decisionSelectionId: null,
        firedAlertKeys: new Set(),
        displayedAlertIds: new Set(),
        reasoningLog: [],
        governmentSummary: null,
        citizenSummary: null,
        incidentGovernmentSummary: null,
        incidentCitizenSummary: null,
        isPlaying: true,
        legDurationMs: computeLegDurationMs(ticks, 0, playbackSpeed),
        legStartedAt: Date.now(),
        frozenPlayheadPct: null,
      });
      void refreshCityStateFromApi(firstTime);
      return;
    }
    set({
      tickIndex: 0,
      currentTime: firstTime,
      segments: computeSegmentState(segmentDefs, traffic, firstTime),
      stations: computeStationState(crowd, firstTime),
      activeIncidents: [],
      injectedIncidentIds: new Set(),
      incidentEte: {},
      alerts: [],
      activeAlertId: null,
      decisionSummarySelected: false,
      decisionSelectionId: null,
      firedAlertKeys: new Set(),
      displayedAlertIds: new Set(),
      reasoningLog: [],
      isPlaying: true,
      legDurationMs: computeLegDurationMs(ticks, 0, playbackSpeed),
      legStartedAt: Date.now(),
      frozenPlayheadPct: null,
    });
  },

  setPlaybackSpeed(ms) {
    const { isPlaying, ticks, tickIndex } = get();
    if (isPlaying && tickIndex < ticks.length - 1) {
      // Restart the current leg's countdown at the new speed rather than leaving it running
      // at the old one — matches how a speed change felt before this leg-tracking was added.
      set({
        playbackSpeed: ms,
        legDurationMs: computeLegDurationMs(ticks, tickIndex, ms),
        legStartedAt: Date.now(),
      });
    } else {
      set({ playbackSpeed: ms });
    }
  },

  advanceTime() {
    const { tickIndex, ticks } = get();
    if (tickIndex >= ticks.length - 1) {
      set({ isPlaying: false });
      return;
    }
    get().seekTime(ticks[tickIndex + 1]);
  },

  seekTime(timestamp) {
    const {
      ticks,
      traffic,
      crowd,
      segmentDefs,
      segments: prevSegments,
      stations: prevStations,
      allIncidents,
      injectedIncidentIds,
    } = get();
    const isMovingForward =
      parseTimestamp(timestamp) >= parseTimestamp(get().currentTime);
    const currentIdx = get().tickIndex;
    const targetIdx = ticks.indexOf(timestamp);
    const isManualSeek = targetIdx !== currentIdx + 1;
    const idx = ticks.indexOf(timestamp);
    const newIndex = idx === -1 ? get().tickIndex : idx;

    // When scrubbing backward, strip alerts/injected incidents whose timestamp is in the
    // future relative to the seek target so the timeline, right panel, and map overlay
    // only reflect events that have actually happened at that point in time.
    if (!isMovingForward) {
      const futureAlerts = get().alerts.filter((a) => a.timestamp > timestamp);
      if (futureAlerts.length > 0) {
        const futureAlertIds = new Set(futureAlerts.map((a) => a.id));
        const futureIncidentIds = new Set(
          allIncidents
            .filter((i) => i.occurredAt > timestamp)
            .map((i) => i.eventId),
        );
        const newInjected = new Set(
          [...injectedIncidentIds].filter((id) => !futureIncidentIds.has(id)),
        );
        const newFiredKeys = new Set(
          [...get().firedAlertKeys].filter(
            (key) => key.split(":").slice(2).join(":") <= timestamp,
          ),
        );
        set((s) => ({
          alerts: s.alerts
            .filter((a) => !futureAlertIds.has(a.id))
            .map((a) =>
              a.resolvedAt && a.resolvedAt > timestamp
                ? { ...a, resolvedAt: undefined, wasElevated: undefined }
                : a,
            ),
          activeIncidents: s.activeIncidents.filter(
            (i) => i.occurredAt <= timestamp,
          ),
          injectedIncidentIds: newInjected,
          firedAlertKeys: newFiredKeys,
          displayedAlertIds: new Set(
            [...s.displayedAlertIds].filter((id) => !futureAlertIds.has(id)),
          ),
        }));
      }
    }

    const newSegments = computeSegmentState(segmentDefs, traffic, timestamp);
    const newStations = computeStationState(crowd, timestamp);

    if (DATA_SOURCE === "api") {
      set({
        tickIndex: newIndex,
        currentTime: timestamp,
        legDurationMs: computeLegDurationMs(
          ticks,
          newIndex,
          get().playbackSpeed,
        ),
        legStartedAt: Date.now(),
        frozenPlayheadPct: null,
      });
      void refreshCityStateFromApi(timestamp);
      return;
    }

    // §4.1 城市觸發路段：tier 由未觸發變為觸發時彈出告警
    for (const id of CITY_TRIGGER_SEGMENTS) {
      const prevTier = prevSegments[id]?.tier ?? "Normal";
      const nextTier = newSegments[id]?.tier ?? "Normal";
      if (prevTier === "Normal" && nextTier !== "Normal") {
        const result = checkCityResponse(id, nextTier);
        if (result && tryFireOnce(`city_response:${id}:${timestamp}`)) {
          const name = segToName(segmentDefs, id);
          const alert: AlertRecord = {
            id: nextId("alert"),
            timestamp,
            kind: "city_response",
            title: `${name} 觸發 ${nextTier} 級壅塞`,
            ruleSummary: `Saturation_Score=${newSegments[id].saturation.toFixed(2)} → ${nextTier} 級`,
            actions: result.actions,
            sopRef: "SOP §1",
            locationId: id,
            locationType: "segment",
            segmentMetrics: {
              segmentName: name,
              flowPcuh: newSegments[id].vehicleCount,
              saturation: newSegments[id].saturation,
            },
          };
          pushAlert(alert, undefined, isManualSeek);
          llmAdapter
            .summarize({
              kind: "city_response",
              title: alert.title,
              data: {
                segmentName: name,
                saturation: newSegments[id].saturation.toFixed(2),
                tier: nextTier,
              },
              sopRef: "SOP §1",
            })
            .then((text) => {
              set((s) => ({
                alerts: s.alerts.map((a) =>
                  a.id === alert.id ? { ...a, llmText: text } : a,
                ),
              }));
            });
        }
      }
    }

    // §4.5 捷運分流
    const toCrowdSnapshot = (
      s: StationRuntimeState,
      ts: string,
    ): CrowdSnapshot => ({
      observedAt: ts,
      stationId: s.stationId,
      locationName: s.name,
      userCount: s.userCount,
      stayTimeAvgMinutes: s.stayTimeAvg,
      growthRate: s.growthRate,
      roamingUserPct: s.roamingPct,
    });
    const bl17Prev = prevStations["BS_MRT_BL17"];
    const bl17Next = newStations["BS_MRT_BL17"];
    if (
      bl17Next &&
      !(
        bl17Prev &&
        checkMrtDiversion(toCrowdSnapshot(bl17Prev, get().currentTime))
      ) &&
      checkMrtDiversion(toCrowdSnapshot(bl17Next, timestamp)) &&
      tryFireOnce(`mrt_diversion:BS_MRT_BL17:${timestamp}`)
    ) {
      const alert: AlertRecord = {
        id: nextId("alert"),
        timestamp,
        kind: "mrt_diversion",
        title: `${bl17Next.name} 觸發捷運分流`,
        ruleSummary: `User_Count=${bl17Next.userCount}、Growth_Rate=${bl17Next.growthRate.toFixed(2)}（門檻：>25,000 或 growth>0.30）`,
        actions: [
          "建議北捷「過站不停」",
          "通知公車處調度接駁專車",
          "引導群眾步行至 BS_MRT_BL18",
        ],
        sopRef: "SOP §3",
      };
      pushAlert(alert, undefined, isManualSeek);
      llmAdapter
        .summarize({
          kind: "mrt_diversion",
          title: alert.title,
          data: {
            stationName: bl17Next.name,
            userCount: String(bl17Next.userCount),
            growthRate: bl17Next.growthRate.toFixed(2),
          },
          sopRef: "SOP §3",
        })
        .then((text) => {
          set((s) => ({
            alerts: s.alerts.map((a) =>
              a.id === alert.id ? { ...a, llmText: text } : a,
            ),
          }));
        });
    }

    // §4.6 大巨蛋散場
    const domePrev = prevStations["BS_TPE_DOME"];
    const domeNext = newStations["BS_TPE_DOME"];
    if (domeNext) {
      const domeHistory = crowd.filter(
        (c) => c.stationId === "BS_TPE_DOME" && c.observedAt < timestamp,
      );
      const domeCurrentSnapshot: CrowdSnapshot = {
        observedAt: timestamp,
        stationId: "BS_TPE_DOME",
        locationName: domeNext.name,
        userCount: domeNext.userCount,
        stayTimeAvgMinutes: domeNext.stayTimeAvg,
        growthRate: domeNext.growthRate,
        roamingUserPct: domeNext.roamingPct,
      };
      const wasTriggered = domePrev
        ? checkDomeDispersal(
            crowd.filter(
              (c) =>
                c.stationId === "BS_TPE_DOME" &&
                c.observedAt < get().currentTime,
            ),
            { ...domeCurrentSnapshot, growthRate: domePrev.growthRate },
          )
        : false;
      const nowTriggered = checkDomeDispersal(domeHistory, domeCurrentSnapshot);
      if (
        !wasTriggered &&
        nowTriggered &&
        tryFireOnce(`dome_dispersal:BS_TPE_DOME:${timestamp}`)
      ) {
        const peak = Math.max(0, ...domeHistory.map((d) => d.userCount));
        const alert: AlertRecord = {
          id: nextId("alert"),
          timestamp,
          kind: "dome_dispersal",
          title: `大巨蛋 散場啟動`,
          ruleSummary: `歷史峰值=${peak}（>=30,000）、當前 Growth_Rate=${domeNext.growthRate.toFixed(2)}（<=-0.20）`,
          actions: [
            "標記「散場啟動」",
            "提前連動第 3 條接駁機制：北捷過站不停、公車處調度接駁專車、引導步行至 BS_MRT_BL18",
          ],
          sopRef: "SOP §4",
        };
        pushAlert(alert, undefined, isManualSeek);
        llmAdapter
          .summarize({
            kind: "dome_dispersal",
            title: alert.title,
            data: {
              peak: String(peak),
              growthRate: domeNext.growthRate.toFixed(2),
            },
            sopRef: "SOP §4",
          })
          .then((text) => {
            set((s) => ({
              alerts: s.alerts.map((a) =>
                a.id === alert.id ? { ...a, llmText: text } : a,
              ),
            }));
          });
      }
    }

    // §4.8 多語通報（任一站點跨過 30% 漫遊比例門檻）
    const prevMultilingualIds = new Set(
      checkMultilingualNeeded(
        Object.values(prevStations).map((s) => ({
          observedAt: timestamp,
          stationId: s.stationId,
          locationName: s.name,
          userCount: s.userCount,
          stayTimeAvgMinutes: s.stayTimeAvg,
          growthRate: s.growthRate,
          roamingUserPct: s.roamingPct,
        })),
      ).map((s) => s.stationId),
    );
    const nowMultilingual = checkMultilingualNeeded(
      Object.values(newStations).map((s) => ({
        observedAt: timestamp,
        stationId: s.stationId,
        locationName: s.name,
        userCount: s.userCount,
        stayTimeAvgMinutes: s.stayTimeAvg,
        growthRate: s.growthRate,
        roamingUserPct: s.roamingPct,
      })),
    );
    for (const st of nowMultilingual) {
      if (
        !prevMultilingualIds.has(st.stationId) &&
        tryFireOnce(`multilingual:${st.stationId}:${timestamp}`)
      ) {
        const alert: AlertRecord = {
          id: nextId("alert"),
          timestamp,
          kind: "multilingual",
          title: `${st.locationName} 觸發多語通報`,
          ruleSummary: `Roaming_User_Pct=${(st.roamingUserPct * 100).toFixed(0)}%（門檻 >=30%）`,
          actions: [
            "該區域簡訊與看板訊息同時提供多國語言版本（中/英/日/韓）",
            "發布時間格式統一為 YYYY-MM-DD HH:MM",
          ],
          sopRef: "SOP §6",
        };
        pushAlert(alert, undefined, isManualSeek);
        llmAdapter
          .summarize({
            kind: "multilingual",
            title: alert.title,
            data: {
              stationName: st.locationName,
              roamingPct: `${(st.roamingUserPct * 100).toFixed(0)}%`,
            },
            sopRef: "SOP §6",
          })
          .then((text) => {
            set((s) => ({
              alerts: s.alerts.map((a) =>
                a.id === alert.id ? { ...a, llmText: text } : a,
              ),
            }));
          });
      }
    }

    // 事件解決偵測
    if (isMovingForward) {
      set((s) => ({
        alerts: s.alerts.map((a) => {
          if (a.origin !== "incident" || !a.trackedSegmentId || a.resolvedAt)
            return a;
          const { elevated, recovered } = checkIncidentResolution(
            a.trackedSegmentId,
            timestamp,
            newSegments,
            newStations,
          );
          if (!a.wasElevated) {
            return elevated ? { ...a, wasElevated: true } : a;
          }
          return recovered ? { ...a, resolvedAt: timestamp } : a;
        }),
      }));
    }

    const alertsAtTime = get().alerts.filter((a) => a.timestamp <= timestamp);
    const activeAlertId =
      alertsAtTime.length > 0
        ? alertsAtTime.reduce((best, a) =>
            a.timestamp >= best.timestamp ? a : best,
          ).id
        : null;

    set({
      tickIndex: newIndex,
      currentTime: timestamp,
      segments: newSegments,
      stations: newStations,
      legDurationMs: computeLegDurationMs(ticks, newIndex, get().playbackSpeed),
      legStartedAt: Date.now(),
      frozenPlayheadPct: null,
      activeAlertId,
      decisionSummarySelected: false,
      decisionSelectionId: activeAlertId,
    });

    // 事件自動注入：時鐘走到事件時間點時自動注入（同時仍保留手動按鈕注入能力）
    for (const incident of allIncidents) {
      if (
        incident.occurredAt <= timestamp &&
        !injectedIncidentIds.has(incident.eventId)
      ) {
        get().injectIncident(incident.eventId, isManualSeek);
      }
    }
  },

  selectAlert(alertId) {
    set({
      activeAlertId: alertId,
      decisionSummarySelected: false,
      decisionSelectionId: alertId,
    });
  },

  addIncidents(incidents) {
    set((s) => ({
      allIncidents: [
        ...s.allIncidents,
        ...incidents.filter(
          (i) => !s.allIncidents.some((e) => e.eventId === i.eventId),
        ),
      ],
    }));
  },

  submitIncident(incident) {
    if (DATA_SOURCE === "api") {
      // Use the incident's own occurredAt as scenarioAt so the backend's
      // db.fetch_active_incidents(occurred_at <= scenario_at) can find it.
      // Falling back to currentTime only when occurredAt is missing.
      const scenarioAt = toScenarioAt(
        incident.occurredAt || get().currentTime || getDefaultApiScenarioTime(),
      );
      apiClient
        .createIncident({
          context: { scenarioAt },
          incident: {
            eventId: incident.eventId,
            type: incident.type,
            location: incident.location,
            affectedSegmentId: incident.affectedSegmentId,
            status: incident.status,
            severity: incident.severity,
            description: incident.description,
            occurredAt: toScenarioAt(incident.occurredAt),
          },
        })
        .then((res) => {
          const submittedIncident: LiveIncident = {
            ...incident,
            processing: res.processing,
            publicManifestUrl: res.publication?.publicManifestUrl,
            publicNoticeUrl: res.publication?.publicNoticeUrl,
          };
          set((s) => ({
            allIncidents: [
              ...s.allIncidents,
              ...(!s.allIncidents.some(
                (e) => e.eventId === submittedIncident.eventId,
              )
                ? [submittedIncident]
                : []),
            ],
          }));
          get().injectIncident(submittedIncident.eventId);
          savePersistedIncident(submittedIncident);
          void pollIncidentReport(submittedIncident.eventId, scenarioAt);
        })
        .catch((err) => {
          console.warn(
            "[appStore] POST /api/incidents failed; no local demo result was generated",
            err,
          );
        });
      return;
    }

    get().addIncidents([incident]);
    get().injectIncident(incident.eventId);
  },

  injectIncident(incidentId, suppressToast = false) {
    const { allIncidents, injectedIncidentIds, segmentDefs, segments } = get();
    if (injectedIncidentIds.has(incidentId)) return;
    const incident = allIncidents.find((i) => i.eventId === incidentId);
    if (!incident) return;

    const newInjected = new Set(injectedIncidentIds);
    newInjected.add(incidentId);
    set((s) => ({
      injectedIncidentIds: newInjected,
      activeIncidents: [...s.activeIncidents, incident],
    }));
    // activeAlertId will be updated after pushAlert adds the new alert

    const saturationMap = new Map(
      Object.values(segments).map((s) => [s.segmentId, s.saturation] as const),
    );

    if (isAccidentTrigger(incident)) {
      const { alert, mainRoute, secondaryRoutes } = buildAccidentAlert(
        incident,
        get().currentTime,
        segmentDefs,
        saturationMap,
        get().timeOffsetMs,
        segments,
      );
      pushAlert(alert, alert.reasoningSteps, suppressToast);
      set((s) => ({
        incidentEte: { ...s.incidentEte, [incident.eventId]: alert.ete ?? 0 },
        segments: {
          ...s.segments,
          [incident.affectedSegmentId]: {
            ...s.segments[incident.affectedSegmentId],
            isIncidentSource: true,
          },
          ...(mainRoute
            ? {
                [mainRoute]: {
                  ...s.segments[mainRoute],
                  isEvacuationMain: true,
                },
              }
            : {}),
          ...Object.fromEntries(
            secondaryRoutes
              .filter((id) => s.segments[id])
              .map((id) => [
                id,
                { ...s.segments[id], isEvacuationSecondary: true },
              ]),
          ),
        },
      }));
    } else if (checkSignalFailure(incident)) {
      const steps: ReasoningStep[] = [
        {
          order: 1,
          status: "info",
          title: "觸發號誌故障應變規則",
          detail: `type=${incident.type}，描述含「號誌失效/故障」`,
          sopRef: "SOP §5",
        },
        {
          order: 2,
          status: "final",
          title: `產出人工指揮派遣建議`,
          detail: `受影響路段：${segToName(segmentDefs, incident.affectedSegmentId)}；警力每路口 2 人`,
          sopRef: "SOP §5",
        },
      ];
      const alert: AlertRecord = {
        id: nextId("alert"),
        timestamp: get().currentTime,
        sourceIncidentId: incident.eventId,
        publicManifestUrl: incident.publicManifestUrl,
        publicNoticeUrl: incident.publicNoticeUrl,
        kind: "signal_failure",
        title: `${segToName(segmentDefs, incident.affectedSegmentId)} 號誌故障`,
        ruleSummary: `type=Power_Failure，severity=${incident.severity}（獨立於車禍規則判定）`,
        actions: [
          "產出人工指揮派遣建議",
          `調度警力至 ${segToName(segmentDefs, incident.affectedSegmentId)}，每路口 2 人`,
          `CMS 加註：「${segToName(segmentDefs, incident.affectedSegmentId)} 號誌故障，請依現場指揮通行」`,
        ],
        sopRef: "SOP §5",
        reasoningSteps: steps,
      };
      pushAlert(alert, steps, suppressToast);
      llmAdapter
        .summarize({
          kind: "signal_failure",
          title: alert.title,
          data: {
            segmentName: segToName(segmentDefs, incident.affectedSegmentId),
          },
          sopRef: "SOP §5",
        })
        .then((text) => {
          set((s) => ({
            alerts: s.alerts.map((a) =>
              a.id === alert.id ? { ...a, llmText: text } : a,
            ),
          }));
        });
    } else {
      // 例如 BS_ 開頭的人流事件（§4.4 邊界案例）：僅作情境關聯顯示，不套用車禍疏散演算法
      const steps: ReasoningStep[] = [
        {
          order: 1,
          status: "fail",
          title: "不觸發車禍應變規則",
          detail: `affected_segment=${incident.affectedSegmentId} 非 RD_ 開頭，即使 status/severity 皆符合亦不套用 §2 疏散演算法`,
          sopRef: "SOP §2",
        },
        {
          order: 2,
          status: "info",
          title: "情境關聯顯示",
          detail: incident.affectedRoad
            ? `${segToName(segmentDefs, incident.affectedRoad)} 因鄰近人流事件單向受限（僅供情境說明）`
            : "此事件屬人流類事件，交由第 3 條捷運分流規則觀察",
          sopRef: "SOP §3",
        },
      ];
      const alert: AlertRecord = {
        id: nextId("alert"),
        timestamp: get().currentTime,
        sourceIncidentId: incident.eventId,
        publicManifestUrl: incident.publicManifestUrl,
        publicNoticeUrl: incident.publicNoticeUrl,
        kind: "accident",
        title: `${incident.location}`,
        ruleSummary: `事件類型 ${incident.type}，不套用車禍疏散演算法（affected_segment 非 RD_ 開頭）`,
        actions: [
          "僅作情境關聯顯示，交由第 3 條捷運分流規則觀察後續是否需要處置",
        ],
        sopRef: "SOP §3",
        reasoningSteps: steps,
      };
      pushAlert(alert, steps, suppressToast);
    }
  },

  sendChatMessage(question, audience = "government", locationContext) {
    const isPublic = audience === "public";
    const userMsg: ChatMessage = {
      id: nextId("chat"),
      role: "user",
      text: question,
      audience,
      createdAt: Date.now(),
    };

    if (DATA_SOURCE === "api") {
      const placeholderId = nextId("chat");
      const placeholder: ChatMessage = {
        id: placeholderId,
        role: "assistant",
        text: isPublic ? "查詢中…" : "研判中…",
        audience,
        isPending: true,
        createdAt: Date.now(),
      };
      set((s) => ({ chatMessages: [...s.chatMessages, userMsg, placeholder] }));

      const nearbyRoad = resolveNearbyRoad(get(), locationContext);
      apiClient
        .postChatMessage({
          context: {
            scenarioAt: toScenarioAt(get().currentTime),
            audience,
            userLocation: locationContext?.nearestRoadId
              ? {
                  locationId: locationContext.nearestRoadId,
                  locationName:
                    nearbyRoad?.name ?? locationContext.nearestRoadId,
                  locationType: "road_segment",
                }
              : undefined,
          },
          message: question,
        })
        .then((res) => {
          const answerMsg = adaptChatAnswer(
            placeholderId,
            res.answer,
            audience,
          );
          set((s) => ({
            chatMessages: s.chatMessages.map((m) =>
              m.id === placeholderId ? { ...answerMsg, isPending: false } : m,
            ),
          }));
        })
        .catch((err) => {
          console.warn("[appStore] POST /api/chat/messages 失敗", err);
          set((s) => ({
            chatMessages: s.chatMessages.map((m) =>
              m.id === placeholderId
                ? {
                    ...m,
                    text: "（連線後端失敗，請稍後再試 / Failed to reach backend, please retry）",
                  }
                : m,
            ),
          }));
        })
        .finally(() => {
          set((s) => ({
            chatMessages: s.chatMessages.map((m) =>
              m.id === placeholderId ? { ...m, isPending: false } : m,
            ),
          }));
        });
      return;
    }

    const { ruleResult, sopExcerpt, sopRefs } = runWhatIf(question);
    const placeholder: ChatMessage = {
      id: nextId("chat"),
      role: "assistant",
      text: isPublic ? "查詢中…" : "研判中…",
      audience,
      // 市民模式不揭露 SOP 條號
      sopRefs: isPublic ? undefined : sopRefs,
      ruleResult,
      isPending: true,
      createdAt: Date.now(),
    };
    set((s) => ({ chatMessages: [...s.chatMessages, userMsg, placeholder] }));

    const nearbyRoad = resolveNearbyRoad(get(), locationContext);
    const answer = isPublic
      ? llmAdapter.answerPublic(
          question,
          ruleResult,
          buildPublicContext(get(), nearbyRoad),
        )
      : llmAdapter.answerWhatIf(question, ruleResult, sopExcerpt, nearbyRoad);

    answer.then((text) => {
      set((s) => ({
        chatMessages: s.chatMessages.map((m) =>
          m.id === placeholder.id ? { ...m, text, isPending: false } : m,
        ),
      }));
    });
  },

  setViewerMode(mode) {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("viewerMode", mode);
    }
    set({ viewerMode: mode });
  },

  toggleMapExpanded() {
    set((s) => ({ mapExpanded: !s.mapExpanded }));
  },

  setSelectedSegment(id) {
    set({ selectedSegmentId: id, selectedStationId: null });
  },

  setSelectedStation(id) {
    set({ selectedStationId: id, selectedSegmentId: null });
  },

  setFieldInspectorPosition(position) {
    set({ fieldInspectorPosition: position });
    // set 是同步的，完成後 get() 已能拿到新的 position
    refreshDecisionsFromApi(get().currentTime);
  },

  setFieldInspectorLocateStatus(status) {
    set({ fieldInspectorLocateStatus: status });
  },
}));

import { create } from "zustand";
import { loadAllData } from "../data/loadData";
import type {
  AlertRecord,
  ChatMessage,
  CrowdSnapshot,
  FieldInspectorLocateStatus,
  FieldInspectorPosition,
  LiveIncident,
  ReasoningStep,
  RoadPathDef,
  RoadSegment,
  Tier,
  TrafficSnapshot,
  ViewerMode,
} from "../types";
import { getTier, checkCityResponse, CITY_TRIGGER_SEGMENTS } from "../engine/congestionTier";
import {
  isAccidentTrigger,
  selectEvacuationRoute,
} from "../engine/accidentResponse";
import { checkMrtDiversion } from "../engine/mrtDiversion";
import { checkDomeDispersal } from "../engine/domeDispersal";
import { checkSignalFailure } from "../engine/signalFailure";
import { checkMultilingualNeeded } from "../engine/multilingualCheck";
import { calcETE } from "../engine/ete";
import { llmAdapter, type PublicContext, type StructuredEvent } from "../services/llmAdapter";
import { runWhatIf } from "../services/chatEngine";
import { computeTimeOffsetMs, reformatEmbeddedTimestamp, parseTimestamp, timePct } from "../utils/timeUtils";

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

function latestByTimestamp<T extends { timestamp: string }>(
  rows: T[],
  timestamp: string,
): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (row.timestamp <= timestamp) {
      if (!best || row.timestamp > best.timestamp) best = row;
    }
  }
  return best;
}

function segToName(segments: Map<string, RoadSegment>, id: string): string {
  return segments.get(id)?.name ?? id;
}

// Demo ticks are sampled unevenly (hourly early on, down to 10-15min later). The progress
// bar maps left% to real elapsed time linearly (see timePct), so for the playhead to cross
// it at a constant pixel velocity, each step's real playback duration must be proportional
// to the share of the total time span that step covers — not a fixed ms per tick, which
// would speed through coarse stretches and crawl through dense ones. `ticks.length - 1`
// keeps the total playthrough duration at a given speed close to the previous fixed-interval
// design (sum of all step gaps == the full span, so the proportions sum to 1).
export function computeStepDurationMs(ticks: string[], fromTs: string, toTs: string, playbackSpeed: number): number {
  const totalSpanMs = parseTimestamp(ticks[ticks.length - 1]) - parseTimestamp(ticks[0]);
  if (totalSpanMs <= 0) return playbackSpeed;
  const gapMs = parseTimestamp(toTs) - parseTimestamp(fromTs);
  return (gapMs / totalSpanMs) * (ticks.length - 1) * playbackSpeed;
}

/** Fresh full duration for the leg starting at `tickIndex`, or 0 if it's the last tick. */
function computeLegDurationMs(ticks: string[], tickIndex: number, playbackSpeed: number): number {
  if (tickIndex >= ticks.length - 1) return 0;
  return computeStepDurationMs(ticks, ticks[tickIndex], ticks[tickIndex + 1], playbackSpeed);
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

  segments: Record<string, SegmentRuntimeState>;
  stations: Record<string, StationRuntimeState>;

  roadPaths: Map<string, RoadPathDef>;
  stationCoords: Record<string, [number, number]>;
  mapCenter: [number, number];

  activeIncidents: LiveIncident[];
  injectedIncidentIds: Set<string>;
  incidentEte: Record<string, number>;
  alerts: AlertRecord[];
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

  init(): Promise<void>;
  play(): void;
  pause(): void;
  /** Jumps back to the first tick, re-runs it as a clean slate (clears alerts, injected
   *  incidents, fired-rule fingerprints, active incidents), and starts playing again. */
  restart(): void;
  setPlaybackSpeed(ms: number): void;
  advanceTime(): void;
  seekTime(timestamp: string): void;
  injectIncident(incidentId: string): void;
  addIncidents(incidents: LiveIncident[]): void;
  sendChatMessage(question: string, audience?: ViewerMode, locationContext?: FieldInspectorPosition | null): void;
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
      avgSpeed: latest?.avgSpeed ?? 0,
      vehicleCount: latest?.vehicleCount ?? 0,
      laneStatus: latest?.laneStatus ?? "Normal",
      tier: getTier(saturation),
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
      roamingPct: latest.roamingPct,
      stayTimeAvg: latest.stayTimeAvg,
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
    incident.affectedSegment,
    incident.location,
    segmentDefs,
    segmentSaturation,
  );

  const incidentSegName = segToName(segmentDefs, incident.affectedSegment);
  const mainRouteName = route.mainRoute
    ? segToName(segmentDefs, route.mainRoute)
    : "（無符合條件之替代路段）";

  const incidentSat = segmentSaturation.get(incident.affectedSegment) ?? 0;
  const mainSat = route.mainRoute
    ? (segmentSaturation.get(route.mainRoute) ?? 0)
    : incidentSat;
  const avgSaturation = route.mainRoute ? (incidentSat + mainSat) / 2 : incidentSat;
  const { ete, base, penalty, breakdown } = calcETE(incident.severity, avgSaturation);

  const steps: ReasoningStep[] = [];
  let order = 1;
  steps.push({
    order: order++,
    status: "info",
    title: `觸發車禍應變規則`,
    detail: `status=${incident.status} ∈ {Closed,Blocked,Restricted}、severity=${incident.severity} ∈ {High,Critical}、affected_segment=${incident.affectedSegment} 以 RD_ 開頭`,
    sopRef: "SOP §2",
  });

  const incidentSeg = segmentDefs.get(incident.affectedSegment);
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
    kind: "accident",
    title: `${incidentSegName} ${incident.status === "Closed" ? "封閉" : incident.status}`,
    ruleSummary: `${incidentSegName}封閉，請改道${mainRouteName}，預計延誤 ${ete} 分鐘`,
    actions: [
      route.mainRoute ? `主疏散路徑：引導車流改道至 ${mainRouteName}` : "無符合條件之替代路段，維持現場疏導",
      ...(route.secondaryRoutes.length > 0
        ? [`次要疏散路徑：${route.secondaryRoutes.map((id) => segToName(segmentDefs, id)).join("、")}`]
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
      flowPcuh: segmentsState[incident.affectedSegment]?.vehicleCount ?? 0,
      saturation: incidentSat,
    },
    reroute: {
      primaryRouteName: route.mainRoute ? mainRouteName : null,
      secondaryRouteNames: route.secondaryRoutes.map((id) => segToName(segmentDefs, id)),
      excluded: route.excluded.map((e) => ({
        segmentName: segToName(segmentDefs, e.segmentId),
        reason: e.reason,
      })),
      congestionWarning: route.congestionWarning,
    },
  };

  const structured: StructuredEvent = {
    kind: "accident",
    title: alert.title,
    data: {
      segmentName: incidentSegName,
      incidentDesc: reformatEmbeddedTimestamp(incident.description, incident.timestamp, timeOffsetMs),
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
      alerts: s.alerts.map((a) => (a.id === alert.id ? { ...a, llmText: text } : a)),
    }));
  });

  return { alert, mainRoute: route.mainRoute, secondaryRoutes: route.secondaryRoutes };
}

/** 把目前的即時狀態壓成市民模式問答需要的可公開概況。 */
function buildPublicContext(state: AppState, nearbyRoad: { name: string; tier: string } | null): PublicContext {
  const busiest = Object.values(state.stations).sort((a, b) => b.userCount - a.userCount)[0];
  return {
    affectedRoads: Object.values(state.segments)
      .filter((segment) => segment.tier !== "Normal" || segment.isIncidentSource)
      .sort((a, b) => b.saturation - a.saturation)
      .map((segment) => ({ name: segment.name, tier: segment.tier })),
    busiestStation: busiest ? { name: busiest.name, userCount: busiest.userCount } : null,
    activeIncidentCount: state.activeIncidents.length,
    nearbyRoad,
  };
}

/** 把聊天輸入框上附加的小人位置 Context Tag，解析成路段名稱＋分級，供兩種模式的回答共用。 */
function resolveNearbyRoad(
  state: AppState,
  locationContext: FieldInspectorPosition | null | undefined,
): { name: string; tier: string } | null {
  const segment = locationContext?.nearestRoadId ? state.segments[locationContext.nearestRoadId] : undefined;
  return segment ? { name: segment.name, tier: segment.tier } : null;
}

function pushAlert(alert: AlertRecord, reasoningSteps?: ReasoningStep[]) {
  // The playhead now animates one tick ahead of the committed tickIndex (see
  // IncidentTimeline), landing on a tick's pixel position at exactly the real time that
  // tick is committed here — so revealing the marker/toast immediately is already in step
  // with the animation; no artificial delay needed.
  useAppStore.setState((s) => ({
    alerts: [alert, ...s.alerts],
    reasoningLog: reasoningSteps ?? s.reasoningLog,
    displayedAlertIds: s.displayedAlertIds.has(alert.id) ? s.displayedAlertIds : new Set(s.displayedAlertIds).add(alert.id),
  }));
}

// Rule-based alerts (city tier, MRT diversion, dome dispersal, multilingual) fire on a
// prev-tick-vs-next-tick rising edge read from live store state. Scrubbing backward past a
// trigger point resets that comparison, so playing forward across the same point again would
// re-fire the same alert — dedupe by (rule, entity, timestamp) so the same historical crossing
// only ever produces one alert, while a genuinely later crossing (different timestamp) still can.
function tryFireOnce(key: string): boolean {
  if (useAppStore.getState().firedAlertKeys.has(key)) return false;
  useAppStore.setState((s) => ({ firedAlertKeys: new Set(s.firedAlertKeys).add(key) }));
  return true;
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
  playbackSpeed: 1500,
  legDurationMs: 0,
  legStartedAt: 0,
  frozenPlayheadPct: null,
  timeOffsetMs: 0,

  traffic: [],
  crowd: [],
  segmentDefs: new Map(),
  allIncidents: [],

  segments: {},
  stations: {},

  roadPaths: new Map(),
  stationCoords: {},
  mapCenter: [121.5617, 25.0395],

  activeIncidents: [],
  injectedIncidentIds: new Set(),
  incidentEte: {},
  alerts: [],
  firedAlertKeys: new Set(),
  displayedAlertIds: new Set(),
  reasoningLog: [],
  chatMessages: [],
  fieldInspectorPosition: null,
  fieldInspectorLocateStatus: "idle",

  async init() {
    try {
      const data = await loadAllData();
      const tickSet = new Set<string>();
      data.traffic.forEach((t) => tickSet.add(t.timestamp));
      data.crowd.forEach((c) => tickSet.add(c.timestamp));
      data.incidents.forEach((i) => tickSet.add(i.timestamp));
      const ticks = Array.from(tickSet).sort();
      const firstTime = ticks[0];

      set({
        isLoading: false,
        traffic: data.traffic,
        crowd: data.crowd,
        segmentDefs: data.segments,
        allIncidents: data.incidents,
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
    const fraction = legDurationMs > 0 ? Math.min(1, Math.max(0, (Date.now() - legStartedAt) / legDurationMs)) : 1;
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
    set({
      tickIndex: 0,
      currentTime: firstTime,
      segments: computeSegmentState(segmentDefs, traffic, firstTime),
      stations: computeStationState(crowd, firstTime),
      activeIncidents: [],
      injectedIncidentIds: new Set(),
      incidentEte: {},
      alerts: [],
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
      set({ playbackSpeed: ms, legDurationMs: computeLegDurationMs(ticks, tickIndex, ms), legStartedAt: Date.now() });
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
    const { ticks, traffic, crowd, segmentDefs, segments: prevSegments, stations: prevStations, allIncidents, injectedIncidentIds } = get();
    const idx = ticks.indexOf(timestamp);
    const newIndex = idx === -1 ? get().tickIndex : idx;

    const newSegments = computeSegmentState(segmentDefs, traffic, timestamp);
    const newStations = computeStationState(crowd, timestamp);

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
            segmentMetrics: {
              segmentName: name,
              flowPcuh: newSegments[id].vehicleCount,
              saturation: newSegments[id].saturation,
            },
          };
          pushAlert(alert);
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
                alerts: s.alerts.map((a) => (a.id === alert.id ? { ...a, llmText: text } : a)),
              }));
            });
        }
      }
    }

    // §4.5 捷運分流
    const toCrowdSnapshot = (s: StationRuntimeState, ts: string): CrowdSnapshot => ({
      timestamp: ts,
      stationId: s.stationId,
      locationName: s.name,
      userCount: s.userCount,
      stayTimeAvg: s.stayTimeAvg,
      growthRate: s.growthRate,
      roamingPct: s.roamingPct,
    });
    const bl17Prev = prevStations["BS_MRT_BL17"];
    const bl17Next = newStations["BS_MRT_BL17"];
    if (
      bl17Next &&
      !(bl17Prev && checkMrtDiversion(toCrowdSnapshot(bl17Prev, get().currentTime))) &&
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
      pushAlert(alert);
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
          set((s) => ({ alerts: s.alerts.map((a) => (a.id === alert.id ? { ...a, llmText: text } : a)) }));
        });
    }

    // §4.6 大巨蛋散場
    const domePrev = prevStations["BS_TPE_DOME"];
    const domeNext = newStations["BS_TPE_DOME"];
    if (domeNext) {
      const domeHistory = crowd.filter((c) => c.stationId === "BS_TPE_DOME" && c.timestamp < timestamp);
      const domeCurrentSnapshot: CrowdSnapshot = {
        timestamp,
        stationId: "BS_TPE_DOME",
        locationName: domeNext.name,
        userCount: domeNext.userCount,
        stayTimeAvg: domeNext.stayTimeAvg,
        growthRate: domeNext.growthRate,
        roamingPct: domeNext.roamingPct,
      };
      const wasTriggered = domePrev
        ? checkDomeDispersal(
            crowd.filter((c) => c.stationId === "BS_TPE_DOME" && c.timestamp < get().currentTime),
            { ...domeCurrentSnapshot, growthRate: domePrev.growthRate },
          )
        : false;
      const nowTriggered = checkDomeDispersal(domeHistory, domeCurrentSnapshot);
      if (!wasTriggered && nowTriggered && tryFireOnce(`dome_dispersal:BS_TPE_DOME:${timestamp}`)) {
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
        pushAlert(alert);
        llmAdapter
          .summarize({
            kind: "dome_dispersal",
            title: alert.title,
            data: { peak: String(peak), growthRate: domeNext.growthRate.toFixed(2) },
            sopRef: "SOP §4",
          })
          .then((text) => {
            set((s) => ({ alerts: s.alerts.map((a) => (a.id === alert.id ? { ...a, llmText: text } : a)) }));
          });
      }
    }

    // §4.8 多語通報（任一站點跨過 30% 漫遊比例門檻）
    const prevMultilingualIds = new Set(
      checkMultilingualNeeded(Object.values(prevStations).map((s) => ({
        timestamp,
        stationId: s.stationId,
        locationName: s.name,
        userCount: s.userCount,
        stayTimeAvg: s.stayTimeAvg,
        growthRate: s.growthRate,
        roamingPct: s.roamingPct,
      }))).map((s) => s.stationId),
    );
    const nowMultilingual = checkMultilingualNeeded(Object.values(newStations).map((s) => ({
      timestamp,
      stationId: s.stationId,
      locationName: s.name,
      userCount: s.userCount,
      stayTimeAvg: s.stayTimeAvg,
      growthRate: s.growthRate,
      roamingPct: s.roamingPct,
    })));
    for (const st of nowMultilingual) {
      if (!prevMultilingualIds.has(st.stationId) && tryFireOnce(`multilingual:${st.stationId}:${timestamp}`)) {
        const alert: AlertRecord = {
          id: nextId("alert"),
          timestamp,
          kind: "multilingual",
          title: `${st.locationName} 觸發多語通報`,
          ruleSummary: `Roaming_User_Pct=${(st.roamingPct * 100).toFixed(0)}%（門檻 >=30%）`,
          actions: [
            "該區域簡訊與看板訊息同時提供多國語言版本（中/英/日/韓）",
            "發布時間格式統一為 YYYY-MM-DD HH:MM",
          ],
          sopRef: "SOP §6",
        };
        pushAlert(alert);
        llmAdapter
          .summarize({
            kind: "multilingual",
            title: alert.title,
            data: { stationName: st.locationName, roamingPct: `${(st.roamingPct * 100).toFixed(0)}%` },
            sopRef: "SOP §6",
          })
          .then((text) => {
            set((s) => ({ alerts: s.alerts.map((a) => (a.id === alert.id ? { ...a, llmText: text } : a)) }));
          });
      }
    }

    set({
      tickIndex: newIndex,
      currentTime: timestamp,
      segments: newSegments,
      stations: newStations,
      legDurationMs: computeLegDurationMs(ticks, newIndex, get().playbackSpeed),
      legStartedAt: Date.now(),
      frozenPlayheadPct: null,
    });

    // 事件自動注入：時鐘走到事件時間點時自動注入（同時仍保留手動按鈕注入能力）
    for (const incident of allIncidents) {
      if (incident.timestamp <= timestamp && !injectedIncidentIds.has(incident.eventId)) {
        get().injectIncident(incident.eventId);
      }
    }
  },

  addIncidents(incidents) {
    set((s) => ({
      allIncidents: [
        ...s.allIncidents,
        ...incidents.filter((i) => !s.allIncidents.some((e) => e.eventId === i.eventId)),
      ],
    }));
  },

  injectIncident(incidentId) {
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
      pushAlert(alert, alert.reasoningSteps);
      set((s) => ({
        incidentEte: { ...s.incidentEte, [incident.eventId]: alert.ete ?? 0 },
        segments: {
          ...s.segments,
          [incident.affectedSegment]: {
            ...s.segments[incident.affectedSegment],
            isIncidentSource: true,
          },
          ...(mainRoute
            ? { [mainRoute]: { ...s.segments[mainRoute], isEvacuationMain: true } }
            : {}),
          ...Object.fromEntries(
            secondaryRoutes
              .filter((id) => s.segments[id])
              .map((id) => [id, { ...s.segments[id], isEvacuationSecondary: true }]),
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
          detail: `受影響路段：${segToName(segmentDefs, incident.affectedSegment)}；警力每路口 2 人`,
          sopRef: "SOP §5",
        },
      ];
      const alert: AlertRecord = {
        id: nextId("alert"),
        timestamp: get().currentTime,
        kind: "signal_failure",
        title: `${segToName(segmentDefs, incident.affectedSegment)} 號誌故障`,
        ruleSummary: `type=Power_Failure，severity=${incident.severity}（獨立於車禍規則判定）`,
        actions: [
          "產出人工指揮派遣建議",
          `調度警力至 ${segToName(segmentDefs, incident.affectedSegment)}，每路口 2 人`,
          `CMS 加註：「${segToName(segmentDefs, incident.affectedSegment)} 號誌故障，請依現場指揮通行」`,
        ],
        sopRef: "SOP §5",
        reasoningSteps: steps,
      };
      pushAlert(alert, steps);
      llmAdapter
        .summarize({
          kind: "signal_failure",
          title: alert.title,
          data: { segmentName: segToName(segmentDefs, incident.affectedSegment) },
          sopRef: "SOP §5",
        })
        .then((text) => {
          set((s) => ({ alerts: s.alerts.map((a) => (a.id === alert.id ? { ...a, llmText: text } : a)) }));
        });
    } else {
      // 例如 BS_ 開頭的人流事件（§4.4 邊界案例）：僅作情境關聯顯示，不套用車禍疏散演算法
      const steps: ReasoningStep[] = [
        {
          order: 1,
          status: "fail",
          title: "不觸發車禍應變規則",
          detail: `affected_segment=${incident.affectedSegment} 非 RD_ 開頭，即使 status/severity 皆符合亦不套用 §2 疏散演算法`,
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
        kind: "accident",
        title: `${incident.location}`,
        ruleSummary: `事件類型 ${incident.type}，不套用車禍疏散演算法（affected_segment 非 RD_ 開頭）`,
        actions: ["僅作情境關聯顯示，交由第 3 條捷運分流規則觀察後續是否需要處置"],
        sopRef: "SOP §3",
        reasoningSteps: steps,
      };
      pushAlert(alert, steps);
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
    const { ruleResult, sopExcerpt, sopRefs } = runWhatIf(question);
    const placeholder: ChatMessage = {
      id: nextId("chat"),
      role: "assistant",
      text: isPublic ? "查詢中…" : "研判中…",
      audience,
      // 市民模式不揭露 SOP 條號
      sopRefs: isPublic ? undefined : sopRefs,
      ruleResult,
      createdAt: Date.now(),
    };
    set((s) => ({ chatMessages: [...s.chatMessages, userMsg, placeholder] }));

    const nearbyRoad = resolveNearbyRoad(get(), locationContext);
    const answer = isPublic
      ? llmAdapter.answerPublic(question, ruleResult, buildPublicContext(get(), nearbyRoad))
      : llmAdapter.answerWhatIf(question, ruleResult, sopExcerpt, nearbyRoad);

    answer.then((text) => {
      set((s) => ({
        chatMessages: s.chatMessages.map((m) =>
          m.id === placeholder.id ? { ...m, text } : m,
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
  },

  setFieldInspectorLocateStatus(status) {
    set({ fieldInspectorLocateStatus: status });
  },
}));

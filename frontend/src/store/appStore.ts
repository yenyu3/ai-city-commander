import { create } from "zustand";
import { loadAllData } from "../data/loadData";
import type {
  AlertRecord,
  ChatMessage,
  FieldInspectorPosition,
  LiveIncident,
  ReasoningStep,
  RoadPathDef,
  RoadSegment,
  Tier,
  TrafficSnapshot,
  CrowdSnapshot,
  ViewerMode,
} from "../types";
// CITY_TRIGGER_SEGMENTS is identity metadata (which two segments SOP §1 names
// as city-response triggers), not a decision -- kept for map/list "★" marks.
// Every threshold/trigger DECISION below comes from the backend (see
// cityStateApi.ts) -- backend/PIPELINES.md "三條產品層級觸發路徑". No
// local rule-engine function (getTier, checkCityResponse, isAccidentTrigger,
// selectEvacuationRoute, checkMrtDiversion, checkDomeDispersal,
// checkSignalFailure, checkMultilingualNeeded) is used for decision-making
// anymore; frontend/src/engine/*.ts remains only as the backend's ported-from
// reference and its own vitest suite.
import { CITY_TRIGGER_SEGMENTS } from "../engine/congestionTier";
import { type PublicContext } from "../services/llmAdapter";
import { activeLlmAdapter as llmAdapter } from "../services/activeLlmAdapter";
import { runWhatIf } from "../services/chatEngine";
import { computeTimeOffsetMs } from "../utils/timeUtils";
import {
  evaluateIncident,
  fetchCityState,
  type CityStateResponse,
  type IncidentSopCheck,
} from "../services/cityStateApi";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string | undefined;

export interface SegmentRuntimeState {
  segmentId: string;
  name: string;
  saturation: number;
  avgSpeed: number;
  vehicleCount: number;
  laneStatus: string;
  // Everything below is the backend's decide_congestion() judgment
  // (GET /api/city-state) -- not computed locally.
  tier: Tier;
  cityResponseTriggered: boolean;
  cityResponseActions: string[];
  reasoning: string;
  decisionSource: string; // "llm" | "fallback" | "" (no data yet)
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
  // decide_mrt_diversion() / decide_dome_dispersal() / decide_multilingual()
  // judgments (GET /api/city-state) -- mrt/dome only populated for
  // BS_MRT_BL17 / BS_TPE_DOME respectively, matching what those SOP
  // articles actually scope to.
  multilingualTriggered: boolean;
  mrtDiversionTriggered?: boolean;
  mrtDiversionReasoning?: string;
  domeDispersalTriggered?: boolean;
  domeDispersalReasoning?: string;
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

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

// Guards against overlapping seekTime() calls (e.g. the tick interval firing
// again before the previous city-state fetch resolved): only the response to
// the MOST RECENT call is ever applied to the store.
let seekRequestId = 0;

function getInitialViewerMode(): ViewerMode {
  if (typeof window === "undefined") return "government";
  const saved = window.localStorage.getItem("viewerMode");
  return saved === "public" || saved === "government" ? saved : "government";
}

interface AppState {
  isLoading: boolean;
  loadError: string | null;
  /** true while a seekTime() call is awaiting /api/city-state -- lets the UI
   * show "AI 判斷中" instead of looking unresponsive during the (real,
   * multi-second-to-multi-minute) LLM judgment call. */
  isJudging: boolean;
  viewerMode: ViewerMode;
  mapExpanded: boolean;
  selectedSegmentId: string | null;
  selectedStationId: string | null;

  ticks: string[];
  tickIndex: number;
  currentTime: string;
  isPlaying: boolean;
  playbackSpeed: number; // ms per tick
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
  reasoningLog: ReasoningStep[];
  chatMessages: ChatMessage[];
  fieldInspectorPosition: FieldInspectorPosition | null;

  init(): Promise<void>;
  play(): void;
  pause(): void;
  setPlaybackSpeed(ms: number): void;
  advanceTime(): void;
  seekTime(timestamp: string): Promise<void>;
  injectIncident(incidentId: string): Promise<void>;
  sendChatMessage(question: string, audience?: ViewerMode): void;
  setViewerMode(mode: ViewerMode): void;
  toggleMapExpanded(): void;
  setSelectedSegment(id: string | null): void;
  setSelectedStation(id: string | null): void;
  setFieldInspectorPosition(position: FieldInspectorPosition | null): void;
}

/**
 * Raw display fields (saturation/speed/count/lane status) still come from
 * the locally-loaded CSV series -- that's a plain "latest row at or before
 * this timestamp" lookup, not a decision, and keeping it means the map still
 * shows real numbers even if the backend call below fails. Every DECISION
 * field (tier, cityResponseTriggered/Actions, reasoning, decisionSource)
 * comes only from `cityState` (GET /api/city-state) -- absent/null means
 * "not judged yet", not "Normal"/"not triggered" by local default.
 */
function computeSegmentState(
  segmentDefs: Map<string, RoadSegment>,
  traffic: TrafficSnapshot[],
  timestamp: string,
  cityState: CityStateResponse | null,
): Record<string, SegmentRuntimeState> {
  const decisions = new Map(cityState?.traffic.map((t) => [t.segmentId, t]) ?? []);
  const result: Record<string, SegmentRuntimeState> = {};
  for (const [id, def] of segmentDefs) {
    const rows = traffic.filter((t) => t.segmentId === id);
    const latest = latestByTimestamp(rows, timestamp);
    const decided = decisions.get(id);
    result[id] = {
      segmentId: id,
      name: def.name,
      saturation: latest?.saturationScore ?? 0,
      avgSpeed: latest?.avgSpeed ?? 0,
      vehicleCount: latest?.vehicleCount ?? 0,
      laneStatus: latest?.laneStatus ?? "Normal",
      tier: decided?.tier ?? "Normal",
      cityResponseTriggered: decided?.cityResponseTriggered ?? false,
      cityResponseActions: decided?.cityResponseActions ?? [],
      reasoning: decided?.reasoning ?? "",
      decisionSource: decided?.source ?? "",
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
  cityState: CityStateResponse | null,
): Record<string, StationRuntimeState> {
  const decisions = new Map(cityState?.crowd.map((c) => [c.stationId, c]) ?? []);
  const ids = Array.from(new Set(crowd.map((c) => c.stationId)));
  const result: Record<string, StationRuntimeState> = {};
  for (const id of ids) {
    const rows = crowd.filter((c) => c.stationId === id);
    const latest = latestByTimestamp(rows, timestamp);
    if (!latest) continue;
    const decided = decisions.get(id);
    result[id] = {
      stationId: id,
      name: latest.locationName,
      userCount: latest.userCount,
      growthRate: latest.growthRate,
      roamingPct: latest.roamingPct,
      stayTimeAvg: latest.stayTimeAvg,
      multilingualTriggered: decided?.multilingualTriggered ?? false,
      mrtDiversionTriggered: decided?.mrtDiversionTriggered,
      mrtDiversionReasoning: decided?.mrtDiversionReasoning,
      domeDispersalTriggered: decided?.domeDispersalTriggered,
      domeDispersalReasoning: decided?.domeDispersalReasoning,
    };
  }
  return result;
}

interface AccidentDecisionResult {
  main_route?: string | null;
  secondary_routes?: string[];
  excluded?: { segment_id: string; reason: string }[];
  congestion_warning?: boolean;
  recommend_public_transit?: boolean;
  ete?: number;
  ete_base?: number;
  ete_penalty?: number;
  ete_breakdown?: string;
}

/**
 * Builds the accident/§2 alert entirely from an already-triggered
 * IncidentSopCheck (see cityStateApi.ts) -- the route selection, exclusion
 * reasons, and ETE all come from the backend's decide_accident() result
 * (LLM or its rules/ fallback), synchronously available once
 * evaluateIncident() resolves. No local route-selection/ETE formula.
 */
function buildAccidentAlertFromDecision(
  incident: LiveIncident,
  timestamp: string,
  segmentDefs: Map<string, RoadSegment>,
  check: IncidentSopCheck,
): { alert: AlertRecord; mainRoute: string | null; secondaryRoutes: string[] } {
  const result = check.result as AccidentDecisionResult;
  const mainRoute = result.main_route ?? null;
  const secondaryRoutes = result.secondary_routes ?? [];
  const excluded = result.excluded ?? [];
  const ete = result.ete ?? 0;

  const incidentSegName = segToName(segmentDefs, incident.affectedSegment);
  const mainRouteName = mainRoute ? segToName(segmentDefs, mainRoute) : "（無符合條件之替代路段）";

  const steps: ReasoningStep[] = [];
  let order = 1;
  steps.push({
    order: order++,
    status: "info",
    title: "觸發車禍應變規則",
    detail: `status=${incident.status}、severity=${incident.severity}、affected_segment=${incident.affectedSegment}`,
    sopRef: "SOP §2",
  });

  const incidentSeg = segmentDefs.get(incident.affectedSegment);
  for (const altId of incidentSeg?.alternatives ?? []) {
    const excludedEntry = excluded.find((e) => e.segment_id === altId);
    if (excludedEntry) {
      steps.push({
        order: order++,
        status: "fail",
        title: `排除 ${segToName(segmentDefs, altId)}`,
        detail: excludedEntry.reason,
        sopRef: "SOP §2(a)",
      });
    } else if (altId === mainRoute) {
      steps.push({
        order: order++,
        status: "pass",
        title: `${segToName(segmentDefs, altId)} 通過篩選（上游、容量足夠）`,
        detail: check.reasoning,
        sopRef: "SOP §2(a)",
      });
    } else if (secondaryRoutes.includes(altId)) {
      steps.push({
        order: order++,
        status: "info",
        title: `${segToName(segmentDefs, altId)} 列為次要疏散（下游）`,
        detail: "相交路口位於事故點下游，須先經過事故點才能到達，僅列次要疏散",
        sopRef: "SOP §2(a)",
      });
    }
  }

  steps.push({
    order: order++,
    status: "final",
    title: `主疏散路徑：${mainRouteName}`,
    detail: result.ete_breakdown ?? check.reasoning,
    sopRef: "SOP §7",
  });

  const alert: AlertRecord = {
    id: nextId("alert"),
    timestamp,
    kind: "accident",
    title: `${incidentSegName} ${incident.status === "Closed" ? "封閉" : incident.status}`,
    ruleSummary: `${incidentSegName}封閉，請改道${mainRouteName}，預計延誤 ${ete} 分鐘`,
    llmText: check.reasoning,
    sopRef: `SOP §${check.sopSectionId ?? "2"} / §7`,
    ete,
    eteBase: result.ete_base ?? 0,
    etePenalty: result.ete_penalty ?? 0,
    reasoningSteps: steps,
  };

  return { alert, mainRoute, secondaryRoutes };
}

/** 把目前的即時狀態壓成市民模式問答需要的可公開概況。 */
function buildPublicContext(state: AppState): PublicContext {
  const busiest = Object.values(state.stations).sort((a, b) => b.userCount - a.userCount)[0];
  return {
    affectedRoads: Object.values(state.segments)
      .filter((segment) => segment.tier !== "Normal" || segment.isIncidentSource)
      .sort((a, b) => b.saturation - a.saturation)
      .map((segment) => ({ name: segment.name, tier: segment.tier })),
    busiestStation: busiest ? { name: busiest.name, userCount: busiest.userCount } : null,
    activeIncidentCount: state.activeIncidents.length,
  };
}

function pushAlert(alert: AlertRecord, reasoningSteps?: ReasoningStep[]) {
  useAppStore.setState((s) => ({
    alerts: [alert, ...s.alerts],
    reasoningLog: reasoningSteps ?? s.reasoningLog,
  }));
}

export const useAppStore = create<AppState>((set, get) => ({
  isLoading: true,
  loadError: null,
  isJudging: false,
  viewerMode: getInitialViewerMode(),
  mapExpanded: false,
  selectedSegmentId: null,
  selectedStationId: null,

  ticks: [],
  tickIndex: 0,
  currentTime: "",
  isPlaying: false,
  playbackSpeed: 1500,
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
  reasoningLog: [],
  chatMessages: [],
  fieldInspectorPosition: null,

  async init() {
    try {
      const data = await loadAllData();
      const tickSet = new Set<string>();
      data.traffic.forEach((t) => tickSet.add(t.timestamp));
      data.crowd.forEach((c) => tickSet.add(c.timestamp));
      data.incidents.forEach((i) => tickSet.add(i.timestamp));
      const ticks = Array.from(tickSet).sort();
      const firstTime = ticks[0];

      let cityState: CityStateResponse | null = null;
      if (API_BASE_URL) {
        try {
          cityState = await fetchCityState(API_BASE_URL, firstTime);
        } catch (err) {
          console.error("[appStore] initial GET /api/city-state failed -- starting with no SOP judgment", err);
        }
      } else {
        console.warn(
          "[appStore] VITE_API_BASE_URL not set -- no backend to judge against, map will show raw data with no tier/alerts",
        );
      }

      set({
        isLoading: false,
        traffic: data.traffic,
        crowd: data.crowd,
        segmentDefs: data.segments,
        allIncidents: data.incidents,
        ticks,
        tickIndex: 0,
        currentTime: firstTime,
        timeOffsetMs: computeTimeOffsetMs(firstTime),
        segments: computeSegmentState(data.segments, data.traffic, firstTime, cityState),
        stations: computeStationState(data.crowd, firstTime, cityState),
        roadPaths: data.roadPaths,
        stationCoords: data.stationCoords,
        mapCenter: data.mapCenter,
      });
    } catch (err) {
      set({ isLoading: false, loadError: String(err) });
    }
  },

  play() {
    set({ isPlaying: true });
  },

  pause() {
    set({ isPlaying: false });
  },

  setPlaybackSpeed(ms) {
    set({ playbackSpeed: ms });
  },

  advanceTime() {
    const { tickIndex, ticks } = get();
    if (tickIndex >= ticks.length - 1) {
      set({ isPlaying: false });
      return;
    }
    void get().seekTime(ticks[tickIndex + 1]);
  },

  async seekTime(timestamp) {
    const { ticks, traffic, crowd, segmentDefs, segments: prevSegments, stations: prevStations, allIncidents, injectedIncidentIds } = get();
    const idx = ticks.indexOf(timestamp);
    const newIndex = idx === -1 ? get().tickIndex : idx;

    // Move the playhead/current-time display immediately -- this is just
    // "we're now looking at time T" (a scrubber position), not a SOP
    // decision, so showing it right away doesn't pre-empt the LLM judgment
    // below. Without this the UI looks unresponsive for the whole (real,
    // multi-second-to-multi-minute) /api/city-state call.
    set({ tickIndex: newIndex, currentTime: timestamp, isJudging: true });

    const requestId = ++seekRequestId;
    let cityState: CityStateResponse | null = null;
    if (API_BASE_URL) {
      try {
        cityState = await fetchCityState(API_BASE_URL, timestamp);
      } catch (err) {
        console.error("[appStore] GET /api/city-state failed -- no SOP judgment for this tick", err);
      }
    } else {
      console.warn(
        "[appStore] VITE_API_BASE_URL not set -- no backend to judge against, map will show raw data with no tier/alerts",
      );
    }
    // a newer seekTime() call already superseded this one -- drop this result
    if (requestId !== seekRequestId) return;

    const newSegments = computeSegmentState(segmentDefs, traffic, timestamp, cityState);
    const newStations = computeStationState(crowd, timestamp, cityState);

    // SOP §1：城市觸發路段的 tier 由未觸發變為觸發時彈出告警。判斷本身
    // (decide_congestion) 已經在後端做完，這裡只偵測「這個 tick 剛好從
    // 未觸發變成觸發」的邊界，決定要不要跳出新 alert。
    for (const id of CITY_TRIGGER_SEGMENTS) {
      const wasTriggered = prevSegments[id]?.cityResponseTriggered ?? false;
      const seg = newSegments[id];
      if (seg && !wasTriggered && seg.cityResponseTriggered) {
        const alert: AlertRecord = {
          id: nextId("alert"),
          timestamp,
          kind: "city_response",
          title: `${seg.name} 觸發 ${seg.tier} 級壅塞`,
          ruleSummary: `Saturation_Score=${seg.saturation.toFixed(2)} → ${seg.tier} 級。${seg.cityResponseActions.join("；")}`,
          llmText: seg.reasoning,
          sopRef: "SOP §1",
        };
        pushAlert(alert);
      }
    }

    // SOP §3：捷運分流（BS_MRT_BL17 專屬，判斷同樣已在後端完成）
    const bl17Prev = prevStations["BS_MRT_BL17"];
    const bl17Next = newStations["BS_MRT_BL17"];
    if (bl17Next && !bl17Prev?.mrtDiversionTriggered && bl17Next.mrtDiversionTriggered) {
      const alert: AlertRecord = {
        id: nextId("alert"),
        timestamp,
        kind: "mrt_diversion",
        title: `${bl17Next.name} 觸發捷運分流`,
        ruleSummary: `User_Count=${bl17Next.userCount}、Growth_Rate=${bl17Next.growthRate.toFixed(2)}`,
        llmText: bl17Next.mrtDiversionReasoning,
        sopRef: "SOP §3",
      };
      pushAlert(alert);
    }

    // SOP §4：大巨蛋散場（BS_TPE_DOME 專屬）
    const domePrev = prevStations["BS_TPE_DOME"];
    const domeNext = newStations["BS_TPE_DOME"];
    if (domeNext && !domePrev?.domeDispersalTriggered && domeNext.domeDispersalTriggered) {
      const alert: AlertRecord = {
        id: nextId("alert"),
        timestamp,
        kind: "dome_dispersal",
        title: "大巨蛋 散場啟動",
        ruleSummary: `User_Count=${domeNext.userCount}、Growth_Rate=${domeNext.growthRate.toFixed(2)}`,
        llmText: domeNext.domeDispersalReasoning,
        sopRef: "SOP §4",
      };
      pushAlert(alert);
    }

    // SOP §6：多語通報（任一站點跨過門檻；判斷是對所有站點批次做一次的，
    // 理由文字對這次輪詢裡所有新觸發的站點是共用的一份）
    for (const st of Object.values(newStations)) {
      const wasTriggered = prevStations[st.stationId]?.multilingualTriggered ?? false;
      if (!wasTriggered && st.multilingualTriggered) {
        const alert: AlertRecord = {
          id: nextId("alert"),
          timestamp,
          kind: "multilingual",
          title: `${st.name} 觸發多語通報`,
          ruleSummary: `Roaming_User_Pct=${(st.roamingPct * 100).toFixed(0)}%（門檻 >=30%）`,
          llmText: cityState?.multilingualJudgment.reasoning,
          sopRef: "SOP §6",
        };
        pushAlert(alert);
      }
    }

    set({ tickIndex: newIndex, currentTime: timestamp, segments: newSegments, stations: newStations, isJudging: false });

    // 事件自動注入：時鐘走到事件時間點時自動注入（同時仍保留手動按鈕注入能力）
    for (const incident of allIncidents) {
      if (incident.timestamp <= timestamp && !injectedIncidentIds.has(incident.eventId)) {
        void get().injectIncident(incident.eventId);
      }
    }
  },

  async injectIncident(incidentId) {
    const { allIncidents, injectedIncidentIds, segmentDefs } = get();
    if (injectedIncidentIds.has(incidentId)) return;
    const incident = allIncidents.find((i) => i.eventId === incidentId);
    if (!incident) return;

    const newInjected = new Set(injectedIncidentIds);
    newInjected.add(incidentId);
    set((s) => ({
      injectedIncidentIds: newInjected,
      activeIncidents: [...s.activeIncidents, incident],
    }));

    if (!API_BASE_URL) {
      console.warn(
        "[appStore] VITE_API_BASE_URL not set -- cannot evaluate this incident, no SOP judgment shown",
      );
      return;
    }

    let checks: IncidentSopCheck[];
    try {
      const response = await evaluateIncident(API_BASE_URL, incidentId, get().currentTime);
      checks = response.aiDecisions;
    } catch (err) {
      console.error("[appStore] evaluateIncident failed", err);
      return;
    }

    const accidentCheck = checks.find((c) => c.alertKind === "accident");
    const signalCheck = checks.find((c) => c.alertKind === "signal_failure");

    if (accidentCheck?.triggered) {
      const { alert, mainRoute, secondaryRoutes } = buildAccidentAlertFromDecision(
        incident,
        get().currentTime,
        segmentDefs,
        accidentCheck,
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
    } else if (signalCheck?.triggered) {
      const steps: ReasoningStep[] = [
        {
          order: 1,
          status: "info",
          title: "觸發號誌故障應變規則",
          detail: signalCheck.reasoning,
          sopRef: "SOP §5",
        },
        {
          order: 2,
          status: "final",
          title: "產出人工指揮派遣建議",
          detail: `受影響路段：${segToName(segmentDefs, incident.affectedSegment)}；警力每路口 2 人`,
          sopRef: "SOP §5",
        },
      ];
      const alert: AlertRecord = {
        id: nextId("alert"),
        timestamp: get().currentTime,
        kind: "signal_failure",
        title: `${segToName(segmentDefs, incident.affectedSegment)} 號誌故障`,
        ruleSummary: `type=${incident.type}，severity=${incident.severity}`,
        llmText: signalCheck.reasoning,
        sopRef: "SOP §5",
        reasoningSteps: steps,
      };
      pushAlert(alert, steps);
    } else {
      // 兩個檢查都跑過了，但都沒有觸發（例如 BS_ 開頭的人流事件，§2/§5
      // 皆不適用）——僅作情境關聯顯示，引用兩個檢查各自的理由文字。
      const steps: ReasoningStep[] = [
        {
          order: 1,
          status: "fail",
          title: "不觸發車禍應變規則",
          detail: accidentCheck?.reasoning ?? "",
          sopRef: "SOP §2",
        },
        {
          order: 2,
          status: "fail",
          title: "不觸發號誌故障應變規則",
          detail: signalCheck?.reasoning ?? "",
          sopRef: "SOP §5",
        },
      ];
      const alert: AlertRecord = {
        id: nextId("alert"),
        timestamp: get().currentTime,
        kind: "accident",
        title: incident.location,
        ruleSummary: `事件類型 ${incident.type}，未觸發 SOP §2 或 §5`,
        sopRef: "SOP §3",
        reasoningSteps: steps,
      };
      pushAlert(alert, steps);
    }
  },

  sendChatMessage(question, audience = "government") {
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

    const answer = isPublic
      ? llmAdapter.answerPublic(question, ruleResult, buildPublicContext(get()), get().currentTime)
      : llmAdapter.answerWhatIf(question, ruleResult, sopExcerpt, get().currentTime);

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
}));

import { create } from "zustand";
import { loadAllData } from "../data/loadData";
import type {
  AlertRecord,
  ChatMessage,
  CrowdSnapshot,
  FocusZone,
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
import { llmAdapter, type StructuredEvent } from "../services/llmAdapter";
import { runWhatIf } from "../services/chatEngine";
import { computeTimeOffsetMs, reformatEmbeddedTimestamp } from "../utils/timeUtils";

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
  focusZone: FocusZone | null;
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

  init(): Promise<void>;
  play(): void;
  pause(): void;
  setPlaybackSpeed(ms: number): void;
  advanceTime(): void;
  seekTime(timestamp: string): void;
  injectIncident(incidentId: string): void;
  sendChatMessage(question: string): void;
  setViewerMode(mode: ViewerMode): void;
  toggleFocusZone(zone: FocusZone): void;
  setSelectedSegment(id: string | null): void;
  setSelectedStation(id: string | null): void;
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
    sopRef: "SOP §2 / §7",
    ete,
    eteBase: base,
    etePenalty: penalty,
    reasoningSteps: steps,
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

function pushAlert(alert: AlertRecord, reasoningSteps?: ReasoningStep[]) {
  useAppStore.setState((s) => ({
    alerts: [alert, ...s.alerts],
    reasoningLog: reasoningSteps ?? s.reasoningLog,
  }));
}

export const useAppStore = create<AppState>((set, get) => ({
  isLoading: true,
  loadError: null,
  viewerMode: getInitialViewerMode(),
  focusZone: null,
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
        if (result) {
          const name = segToName(segmentDefs, id);
          const alert: AlertRecord = {
            id: nextId("alert"),
            timestamp,
            kind: "city_response",
            title: `${name} 觸發 ${nextTier} 級壅塞`,
            ruleSummary: `Saturation_Score=${newSegments[id].saturation.toFixed(2)} → ${nextTier} 級。${result.actions.join("；")}`,
            sopRef: "SOP §1",
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
      checkMrtDiversion(toCrowdSnapshot(bl17Next, timestamp))
    ) {
      const alert: AlertRecord = {
        id: nextId("alert"),
        timestamp,
        kind: "mrt_diversion",
        title: `${bl17Next.name} 觸發捷運分流`,
        ruleSummary: `User_Count=${bl17Next.userCount}、Growth_Rate=${bl17Next.growthRate.toFixed(2)}（門檻：>25,000 或 growth>0.30）`,
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
      if (!wasTriggered && nowTriggered) {
        const peak = Math.max(0, ...domeHistory.map((d) => d.userCount));
        const alert: AlertRecord = {
          id: nextId("alert"),
          timestamp,
          kind: "dome_dispersal",
          title: `大巨蛋 散場啟動`,
          ruleSummary: `歷史峰值=${peak}（>=30,000）、當前 Growth_Rate=${domeNext.growthRate.toFixed(2)}（<=-0.20）`,
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
      if (!prevMultilingualIds.has(st.stationId)) {
        const alert: AlertRecord = {
          id: nextId("alert"),
          timestamp,
          kind: "multilingual",
          title: `${st.locationName} 觸發多語通報`,
          ruleSummary: `Roaming_User_Pct=${(st.roamingPct * 100).toFixed(0)}%（門檻 >=30%）`,
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

    set({ tickIndex: newIndex, currentTime: timestamp, segments: newSegments, stations: newStations });

    // 事件自動注入：時鐘走到事件時間點時自動注入（同時仍保留手動按鈕注入能力）
    for (const incident of allIncidents) {
      if (incident.timestamp <= timestamp && !injectedIncidentIds.has(incident.eventId)) {
        get().injectIncident(incident.eventId);
      }
    }
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
        sopRef: "SOP §3",
        reasoningSteps: steps,
      };
      pushAlert(alert, steps);
    }
  },

  sendChatMessage(question) {
    const userMsg: ChatMessage = {
      id: nextId("chat"),
      role: "user",
      text: question,
      createdAt: Date.now(),
    };
    const { ruleResult, sopExcerpt, sopRefs } = runWhatIf(question);
    const placeholder: ChatMessage = {
      id: nextId("chat"),
      role: "assistant",
      text: "研判中…",
      sopRefs,
      ruleResult,
      createdAt: Date.now(),
    };
    set((s) => ({ chatMessages: [...s.chatMessages, userMsg, placeholder] }));

    llmAdapter.answerWhatIf(question, ruleResult, sopExcerpt).then((text) => {
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

  toggleFocusZone(zone) {
    set((s) => ({ focusZone: s.focusZone === zone ? null : zone }));
  },

  setSelectedSegment(id) {
    set({ selectedSegmentId: id, selectedStationId: null });
  },

  setSelectedStation(id) {
    set({ selectedStationId: id, selectedSegmentId: null });
  },
}));

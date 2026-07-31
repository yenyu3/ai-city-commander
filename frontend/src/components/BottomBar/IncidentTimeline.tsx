import { useMemo, useRef, useState } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { ALERT_KIND_COLOR, ALERT_KIND_LABEL } from "../../utils/alertLabels";
import { formatDisplayShortTime, formatDisplayTimestamp, parseTimestamp, timePct } from "../../utils/timeUtils";
import type { AlertRecord } from "../../types";
import styles from "./IncidentTimeline.module.css";

const BASE_PLAYBACK_SPEED_MS = 1500;
const SPEED_OPTIONS = [
  { label: "1x", ms: BASE_PLAYBACK_SPEED_MS },
  { label: "1.5x", ms: BASE_PLAYBACK_SPEED_MS / 1.5 },
  { label: "2x", ms: BASE_PLAYBACK_SPEED_MS / 2 },
];

/** Markers within this many % of the timeline width of the previous marker in the
 *  same chain are treated as one visual cluster and fanned out vertically — a
 *  generalization of the old "exact same timestamp" grouping so close-but-not-
 *  identical timestamps (e.g. a resolved marker landing near another incident's
 *  trigger marker) never visually overlap either. */
const CLUSTER_PCT_THRESHOLD = 3;

/** 同一群組內標記的最大垂直展開幅度（px，往上/往下各不超過這個值）——track 高度 40px，
 *  這個值必須留夠邊界讓標記本體（12px 圓點 + 2px 邊框）不會被裁到軌道外。 */
const MAX_FAN_OFFSET_PX = 10;

interface TimelineMarker {
  key: string;
  timestamp: string;
  color: string;
  alert: AlertRecord;
  isResolution: boolean;
}

export default function IncidentTimeline() {
  const ticks = useAppStore((s) => s.ticks);
  const tickIndex = useAppStore((s) => s.tickIndex);
  const alerts = useAppStore((s) => s.alerts);
  const displayedAlertIds = useAppStore((s) => s.displayedAlertIds);
  const seekTime = useAppStore((s) => s.seekTime);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const isPlaying = useAppStore((s) => s.isPlaying);
  const playbackSpeed = useAppStore((s) => s.playbackSpeed);
  const legDurationMs = useAppStore((s) => s.legDurationMs);
  const frozenPlayheadPct = useAppStore((s) => s.frozenPlayheadPct);
  const play = useAppStore((s) => s.play);
  const pause = useAppStore((s) => s.pause);
  const restart = useAppStore((s) => s.restart);
  const setPlaybackSpeed = useAppStore((s) => s.setPlaybackSpeed);
  const { language } = useLanguage();
  const trackRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<TimelineMarker | null>(null);

  const start = ticks[0];
  const end = ticks[ticks.length - 1];

  const hourMarks = useMemo(() => {
    const marks = ticks.filter((t) => t.endsWith(":00"));
    if (end && !marks.includes(end)) marks.push(end);
    return marks;
  }, [ticks, end]);

  // 時間軸只畫「事件注入」產生的點（origin === "incident"），數量才會跟使用者上傳/注入的
  // 事件一一對應；規則引擎對車流/人流連續資料判定出的門檻穿越警報（origin === "sensor"，
  // 如城市壅塞分級、捷運分流、大巨蛋散場、多語通報）不佔用時間軸點位，但仍會完整顯示在
  // 城市情報室／AI 決策面板中。
  const incidentAlerts = useMemo(() => alerts.filter((a) => a.origin === "incident"), [alerts]);

  // Each incident-origin alert contributes a "trigger" marker at its own timestamp, and —
  // once the rule engine detects its tracked segment/station has recovered (appStore.ts's
  // resolution check) — a second green "resolved" marker at `resolvedAt`. Both share the
  // same underlying alert so hover/click behave consistently either way.
  const markers = useMemo<TimelineMarker[]>(() => {
    const result: TimelineMarker[] = [];
    for (const a of incidentAlerts) {
      if (!displayedAlertIds.has(a.id)) continue;
      result.push({ key: `${a.id}:trigger`, timestamp: a.timestamp, color: ALERT_KIND_COLOR[a.kind], alert: a, isResolution: false });
      if (a.resolvedAt) {
        result.push({ key: `${a.id}:resolved`, timestamp: a.resolvedAt, color: "var(--ok)", alert: a, isResolution: true });
      }
    }
    return result;
  }, [incidentAlerts, displayedAlertIds]);

  // Markers landing close together in time render at nearly the same left% and would
  // otherwise overlap, leaving only the topmost one clickable. Chain-cluster markers
  // within CLUSTER_PCT_THRESHOLD of the previous one (not just exact-same-timestamp) and
  // fan each cluster out vertically so every marker stays independently clickable/hoverable.
  const markerOffsets = useMemo(() => {
    const sorted = [...markers].sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp));
    const groups: TimelineMarker[][] = [];
    for (const m of sorted) {
      const pct = timePct(m.timestamp, start, end);
      const lastGroup = groups[groups.length - 1];
      const lastPct = lastGroup ? timePct(lastGroup[lastGroup.length - 1].timestamp, start, end) : null;
      if (lastGroup && lastPct !== null && pct - lastPct <= CLUSTER_PCT_THRESHOLD) {
        lastGroup.push(m);
      } else {
        groups.push([m]);
      }
    }
    const offsets = new Map<string, number>();
    for (const group of groups) {
      // 每組的總垂直展開幅度固定封頂在 ±MAX_FAN_OFFSET_PX，不管這組有幾個標記擠在一起——
      // 否則像 22:10~22:30 那種 3~5 個標記全部落在同一群組時，固定 14px 間距會把最外側的
      // 標記推到軌道（40px 高）範圍之外，變成視覺上「點跑出時間軸」。
      const gap = group.length > 1 ? Math.min(14, (MAX_FAN_OFFSET_PX * 2) / (group.length - 1)) : 0;
      group.forEach((m, i) => offsets.set(m.key, (i - (group.length - 1) / 2) * gap));
    }
    return offsets;
  }, [markers, start, end]);

  if (ticks.length === 0) return null;

  // While playing, target the *next* tick instead of the current (already-committed) one, and
  // animate to it over exactly the real time until that next tick is due (store's
  // legDurationMs — ticks are unevenly spaced in sim-time). Each glide then lands on its
  // target at the exact real moment the store advances tickIndex, so the next glide can pick
  // up from there with no gap or overshoot. Targeting the *current* tick instead (as before)
  // meant the glide only started once a tick had already arrived, permanently running one step
  // behind the timer that schedules ticks — and since consecutive steps can cover very
  // different sim-time spans, a short step landing while a longer glide was still mid-flight
  // would cut it off and jump-start a new one, reading as an erratic speed-up/slow-down (and
  // letting alert markers, which surface the instant their tick is committed, visibly beat the
  // still-catching-up playhead to position).
  const hasNext = isPlaying && tickIndex < ticks.length - 1;
  // When paused mid-glide, `frozenPlayheadPct` (set by the store's pause()) holds the exact
  // interpolated position so the dot freezes in place instead of snapping back to the last
  // committed tick — resuming continues from there via the store's shrunk legDurationMs.
  const playheadPct = hasNext
    ? timePct(ticks[tickIndex + 1], start, end)
    : (frozenPlayheadPct ?? timePct(ticks[tickIndex], start, end));

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const targetMs = parseTimestamp(start) + fraction * (parseTimestamp(end) - parseTimestamp(start));
    let nearest = ticks[0];
    let best = Infinity;
    for (const t of ticks) {
      const d = Math.abs(parseTimestamp(t) - targetMs);
      if (d < best) {
        best = d;
        nearest = t;
      }
    }
    seekTime(nearest);
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.track} ref={trackRef} onClick={handleTrackClick}>
        {hourMarks.map((t) => (
          <div key={t} className={styles.hourMark} style={{ left: `${timePct(t, start, end)}%` }}>
            <span className={styles.hourLabel}>{formatDisplayShortTime(t, timeOffsetMs)}</span>
          </div>
        ))}

        <div
          className={styles.playhead}
          style={{
            left: `${playheadPct}%`,
            transition: hasNext ? `left ${legDurationMs}ms linear` : "none",
          }}
        />

        {markers.map((m) => (
          <button
            key={m.key}
            type="button"
            className={styles.node}
            style={{
              left: `${timePct(m.timestamp, start, end)}%`,
              top: `calc(50% + ${markerOffsets.get(m.key) ?? 0}px)`,
              background: m.color,
            }}
            onClick={(e) => {
              e.stopPropagation();
              seekTime(m.timestamp);
            }}
            onMouseEnter={() => setHovered(m)}
            onMouseLeave={() => setHovered((h) => (h?.key === m.key ? null : h))}
            aria-label={
              m.isResolution
                ? pick(language, `${m.alert.title}（已解決）`, `${m.alert.title} (Resolved)`)
                : m.alert.title
            }
          />
        ))}
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.playBtn}
          onClick={() => (isPlaying ? pause() : play())}
          aria-label={isPlaying ? pick(language, "暫停", "Pause") : pick(language, "播放", "Play")}
        >
          {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        </button>
        <button
          type="button"
          className={styles.playBtn}
          onClick={() => restart()}
          aria-label={pick(language, "重播", "Replay")}
          title={pick(language, "重播（清除所有事件點並從頭開始）", "Replay (clears all markers and restarts)")}
        >
          <RotateCcw size={14} />
        </button>
        <div className={styles.speedGroup}>
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              className={`${styles.speedBtn} ${playbackSpeed === s.ms ? styles.speedActive : ""}`}
              onClick={() => setPlaybackSpeed(s.ms)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {hovered && (
        <div className={styles.tooltip}>
          <span className={styles.tooltipKind}>
            {hovered.isResolution
              ? pick(language, "已解決", "Resolved")
              : pick(language, ALERT_KIND_LABEL[hovered.alert.kind].zh, ALERT_KIND_LABEL[hovered.alert.kind].en)}
          </span>
          <span className={styles.tooltipTitle}>{hovered.alert.title}</span>
          <span className={styles.tooltipTime}>{formatDisplayTimestamp(hovered.timestamp, timeOffsetMs)}</span>
        </div>
      )}
    </div>
  );
}

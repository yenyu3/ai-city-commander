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
  const [hovered, setHovered] = useState<AlertRecord | null>(null);

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

  // Alerts that land on the same timestamp render at the same left% and would
  // otherwise stack exactly on top of each other, leaving only the topmost one
  // clickable. Fan same-timestamp alerts out vertically so every marker stays
  // independently clickable/hoverable.
  const verticalOffsets = useMemo(() => {
    const groups = new Map<string, AlertRecord[]>();
    for (const a of incidentAlerts) {
      const group = groups.get(a.timestamp);
      if (group) group.push(a);
      else groups.set(a.timestamp, [a]);
    }
    const offsets = new Map<string, number>();
    for (const group of groups.values()) {
      group.forEach((a, i) => offsets.set(a.id, (i - (group.length - 1) / 2) * 14));
    }
    return offsets;
  }, [incidentAlerts]);

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
  const visibleAlerts = incidentAlerts.filter((a) => displayedAlertIds.has(a.id));

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

        {visibleAlerts.map((a) => (
          <button
            key={a.id}
            type="button"
            className={styles.node}
            style={{
              left: `${timePct(a.timestamp, start, end)}%`,
              top: `calc(50% + ${verticalOffsets.get(a.id) ?? 0}px)`,
              background: ALERT_KIND_COLOR[a.kind],
            }}
            onClick={(e) => {
              e.stopPropagation();
              seekTime(a.timestamp);
            }}
            onMouseEnter={() => setHovered(a)}
            onMouseLeave={() => setHovered((h) => (h?.id === a.id ? null : h))}
            aria-label={a.title}
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
            {pick(language, ALERT_KIND_LABEL[hovered.kind].zh, ALERT_KIND_LABEL[hovered.kind].en)}
          </span>
          <span className={styles.tooltipTitle}>{hovered.title}</span>
          <span className={styles.tooltipTime}>{formatDisplayTimestamp(hovered.timestamp, timeOffsetMs)}</span>
        </div>
      )}
    </div>
  );
}

import { useMemo, useRef, useState } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { ALERT_KIND_COLOR, ALERT_KIND_LABEL } from "../../utils/alertLabels";
import { formatDisplayShortTime, formatDisplayTimestamp, parseTimestamp, timePct } from "../../utils/timeUtils";
import type { AlertRecord } from "../../types";

const CLUSTER_PCT_THRESHOLD = 1.5;

interface TimelineMarker {
  key: string;
  timestamp: string;
  color: string;
  alert: AlertRecord;
  isResolution: boolean;
}
import styles from "./IncidentTimeline.module.css";

const BASE_PLAYBACK_SPEED_MS = 3000;
const SPEED_OPTIONS = [
  { label: "1x", ms: BASE_PLAYBACK_SPEED_MS },
  { label: "1.5x", ms: BASE_PLAYBACK_SPEED_MS / 1.5 },
  { label: "2x", ms: BASE_PLAYBACK_SPEED_MS / 2 },
];

export default function IncidentTimeline() {
  const ticks = useAppStore((s) => s.ticks);
  const tickIndex = useAppStore((s) => s.tickIndex);
  const alerts = useAppStore((s) => s.alerts);
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

  const markers = useMemo<TimelineMarker[]>(() => {
    const result: TimelineMarker[] = [];
    for (const a of alerts) {
      result.push({ key: `${a.id}:trigger`, timestamp: a.timestamp, color: ALERT_KIND_COLOR[a.kind], alert: a, isResolution: false });
      if (a.resolvedAt) {
        result.push({ key: `${a.id}:resolved`, timestamp: a.resolvedAt, color: "var(--ok)", alert: a, isResolution: true });
      }
    }
    return result;
  }, [alerts]);

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
      group.forEach((m, i) => offsets.set(m.key, (i - (group.length - 1) / 2) * 14));
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
  const displayedAlertIds = useAppStore((s) => s.displayedAlertIds);
  const visibleMarkers = markers.filter((m) => displayedAlertIds.has(m.alert.id));

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

        {visibleMarkers.map((m) => (
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
            onMouseEnter={() => setHovered(m.alert)}
            onMouseLeave={() => setHovered((h) => (h?.id === m.alert.id ? null : h))}
            aria-label={m.alert.title}
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

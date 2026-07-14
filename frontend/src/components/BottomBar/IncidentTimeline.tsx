import { useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { ALERT_KIND_COLOR, ALERT_KIND_LABEL } from "../../utils/alertLabels";
import { formatDisplayShortTime, formatDisplayTimestamp, parseTimestamp, timePct } from "../../utils/timeUtils";
import type { AlertRecord } from "../../types";
import styles from "./IncidentTimeline.module.css";

export default function IncidentTimeline() {
  const ticks = useAppStore((s) => s.ticks);
  const tickIndex = useAppStore((s) => s.tickIndex);
  const alerts = useAppStore((s) => s.alerts);
  const seekTime = useAppStore((s) => s.seekTime);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
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

  if (ticks.length === 0) return null;

  const playheadPct = timePct(ticks[tickIndex], start, end);

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
      <div className={styles.headRow}>
        <span className={styles.title}>{pick(language, "時間軸", "Timeline")}</span>
        <span className={styles.range}>
          {formatDisplayShortTime(start, timeOffsetMs)} – {formatDisplayShortTime(end, timeOffsetMs)}
        </span>
      </div>

      <div className={styles.track} ref={trackRef} onClick={handleTrackClick}>
        {hourMarks.map((t) => (
          <div key={t} className={styles.hourMark} style={{ left: `${timePct(t, start, end)}%` }}>
            <span className={styles.hourLabel}>{formatDisplayShortTime(t, timeOffsetMs)}</span>
          </div>
        ))}

        <div className={styles.playhead} style={{ left: `${playheadPct}%` }} />

        {alerts.map((a) => (
          <button
            key={a.id}
            type="button"
            className={styles.node}
            style={{ left: `${timePct(a.timestamp, start, end)}%`, background: ALERT_KIND_COLOR[a.kind] }}
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

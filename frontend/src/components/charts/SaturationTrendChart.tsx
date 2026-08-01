import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { LiveIncident, RoadSegment, TrafficSnapshot } from "../../types";
import { pick, useLanguage } from "../../i18n";
import { formatDisplayShortTime, formatDisplayTimestamp } from "../../utils/timeUtils";
import ChartTooltip from "./ChartTooltip";
import { SERIES_COLORS } from "./chartUtils";
import styles from "./TrendChart.module.css";

interface Props {
  traffic: TrafficSnapshot[];
  segmentIds: string[];
  segmentDefs: Map<string, RoadSegment>;
  incidents?: LiveIncident[];
  currentTime?: string;
  timeOffsetMs?: number;
  compact?: boolean;
  showAxes?: boolean;
}

export default function SaturationTrendChart({
  traffic,
  segmentIds,
  segmentDefs,
  incidents = [],
  currentTime,
  timeOffsetMs = 0,
  compact = false,
  showAxes = false,
}: Props) {
  const { language } = useLanguage();

  const { data, names } = useMemo(() => {
    const names: Record<string, string> = {};
    for (const id of segmentIds) names[id] = segmentDefs.get(id)?.name ?? id;

    const byTime = new Map<string, Record<string, number | string>>();
    for (const row of traffic) {
      if (!segmentIds.includes(row.segmentId)) continue;
      const entry = byTime.get(row.observedAt) ?? { timestamp: row.observedAt };
      entry[row.segmentId] = row.saturationScore;
      byTime.set(row.observedAt, entry);
    }
    const data = Array.from(byTime.values()).sort((a, b) =>
      String(a.timestamp).localeCompare(String(b.timestamp)),
    );
    return { data, names };
  }, [traffic, segmentIds, segmentDefs]);

  const markers = useMemo(
    () =>
      incidents
        .filter((i) => segmentIds.includes(i.affectedSegmentId))
        .map((i) => ({
          timestamp: i.occurredAt,
          segmentId: i.affectedSegmentId,
          value: data.find((d) => d.timestamp === i.occurredAt)?.[i.affectedSegmentId],
        }))
        .filter((m) => typeof m.value === "number"),
    [incidents, segmentIds, data],
  );

  if (data.length === 0) return null;

  const showAxesActual = !compact || showAxes;

  return (
    <div className={compact ? styles.compactWrap : styles.wrap}>
      {!compact && (
        <div className={styles.title}>
          {pick(language, "路段飽和度趨勢", "Segment Saturation Trend")}
        </div>
      )}
      <ResponsiveContainer width="100%" height={compact ? (showAxes ? 110 : 56) : 220}>
        <AreaChart data={data} margin={compact ? { top: 4, right: 8, left: showAxes ? 0 : 2, bottom: showAxes ? 16 : 0 } : { top: 8, right: 12, left: -18, bottom: 0 }}>
          {!compact && <CartesianGrid stroke="var(--chart-grid)" vertical={false} />}
          <XAxis
            dataKey="timestamp"
            hide={!showAxesActual}
            tickFormatter={(v: string) => formatDisplayShortTime(v, timeOffsetMs)}
            tick={{ fill: "var(--text-dim)", fontSize: 10 }}
            axisLine={{ stroke: "var(--chart-axis)" }}
            tickLine={false}
            interval="preserveStartEnd"
            label={showAxesActual ? { value: pick(language, "時間", "Time"), position: "insideBottomRight", offset: -4, fill: "var(--text-dim)", fontSize: 10 } : undefined}
          />
          <YAxis
            hide={!showAxesActual}
            domain={[0, (max: number) => Math.max(1.05, max * 1.1)]}
            tick={{ fill: "var(--text-dim)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={compact ? 44 : 32}
            label={showAxesActual ? { value: pick(language, "飽和度", "Sat."), angle: -90, position: "insideLeft", offset: compact ? 2 : 14, fill: "var(--text-dim)", fontSize: 10 } : undefined}
          />
          {!compact && (
            <>
              <ReferenceLine y={0.85} stroke="var(--warn)" strokeWidth={1} label={{ value: "B", position: "insideTopRight", fill: "var(--warn)", fontSize: 10 }} />
              <ReferenceLine y={0.95} stroke="var(--crit)" strokeWidth={1} label={{ value: "A", position: "insideTopRight", fill: "var(--crit)", fontSize: 10 }} />
              {currentTime && data.some((d) => d.timestamp === currentTime) && (
                <ReferenceLine x={currentTime} stroke="var(--text)" strokeWidth={1} strokeDasharray="2 2" />
              )}
              <Tooltip
                content={(p) => (
                  <ChartTooltip
                    active={p.active}
                    label={p.label ? formatDisplayTimestamp(p.label as string, timeOffsetMs) : undefined}
                    payload={p.payload as never}
                    valueFormatter={(v) => Number(v).toFixed(2)}
                  />
                )}
              />
            </>
          )}
          {segmentIds.map((id, idx) => (
            <Area
              key={id}
              type="monotone"
              dataKey={id}
              name={names[id]}
              stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
              fill={SERIES_COLORS[idx % SERIES_COLORS.length]}
              fillOpacity={compact ? 0 : 0.12}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
          {!compact &&
            markers.map((m) => (
              <ReferenceDot
                key={`${m.segmentId}_${m.timestamp}`}
                x={m.timestamp}
                y={m.value as number}
                r={5}
                fill="var(--crit)"
                stroke="var(--panel)"
                strokeWidth={2}
              />
            ))}
        </AreaChart>
      </ResponsiveContainer>
      {!compact && (
        <div className={styles.legend}>
          {segmentIds.map((id, idx) => (
            <span key={id} className={styles.legendItem}>
              <span className={styles.legendDot} style={{ background: SERIES_COLORS[idx % SERIES_COLORS.length] }} />
              {names[id]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

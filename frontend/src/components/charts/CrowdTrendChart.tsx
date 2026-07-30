import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CrowdSnapshot } from "../../types";
import { pick, useLanguage } from "../../i18n";
import { formatDisplayShortTime, formatDisplayTimestamp } from "../../utils/timeUtils";
import ChartTooltip from "./ChartTooltip";
import { SERIES_COLORS } from "./chartUtils";
import styles from "./TrendChart.module.css";

interface Props {
  crowd: CrowdSnapshot[];
  stationIds: string[];
  currentTime?: string;
  timeOffsetMs?: number;
  compact?: boolean;
  showAxes?: boolean;
}

export default function CrowdTrendChart({
  crowd,
  stationIds,
  currentTime,
  timeOffsetMs = 0,
  compact = false,
  showAxes = false,
}: Props) {
  const { language } = useLanguage();
  const showAxesActual = !compact || showAxes;

  const { data, names } = useMemo(() => {
    const names: Record<string, string> = {};
    const byTime = new Map<string, Record<string, number | string>>();
    for (const row of crowd) {
      if (!stationIds.includes(row.stationId)) continue;
      names[row.stationId] = row.locationName;
      const entry = byTime.get(row.timestamp) ?? { timestamp: row.timestamp };
      entry[row.stationId] = row.userCount;
      byTime.set(row.timestamp, entry);
    }
    const data = Array.from(byTime.values()).sort((a, b) =>
      String(a.timestamp).localeCompare(String(b.timestamp)),
    );
    return { data, names };
  }, [crowd, stationIds]);

  if (data.length === 0) return null;

  return (
    <div className={compact ? styles.compactWrap : styles.wrap}>
      {!compact && (
        <div className={styles.title}>
          {pick(language, "人流趨勢（User Count）", "Crowd Trend (User Count)")}
        </div>
      )}
      <ResponsiveContainer width="100%" height={compact ? (showAxes ? 110 : 56) : 220}>
        <LineChart data={data} margin={compact ? { top: 4, right: 8, left: showAxes ? 0 : 2, bottom: showAxes ? 16 : 0 } : { top: 8, right: 12, left: -12, bottom: 0 }}>
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
            tick={{ fill: "var(--text-dim)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={compact ? 44 : 40}
            tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
            label={showAxesActual ? { value: pick(language, "人數", "Users"), angle: -90, position: "insideLeft", offset: compact ? 2 : 14, fill: "var(--text-dim)", fontSize: 10 } : undefined}
          />
          {!compact && currentTime && data.some((d) => d.timestamp === currentTime) && (
            <ReferenceLine x={currentTime} stroke="var(--text)" strokeWidth={1} strokeDasharray="2 2" />
          )}
          {!compact && (
            <Tooltip
              content={(p) => (
                <ChartTooltip
                  active={p.active}
                  label={p.label ? formatDisplayTimestamp(p.label as string, timeOffsetMs) : undefined}
                  payload={p.payload as never}
                  valueFormatter={(v) => Number(v).toLocaleString()}
                />
              )}
            />
          )}
          {stationIds.map((id, idx) => (
            <Line
              key={id}
              type="monotone"
              dataKey={id}
              name={names[id]}
              stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {!compact && (
        <div className={styles.legend}>
          {stationIds.map((id, idx) => (
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

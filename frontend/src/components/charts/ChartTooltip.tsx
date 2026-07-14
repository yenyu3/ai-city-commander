import styles from "./ChartTooltip.module.css";

interface TooltipPayloadItem {
  color?: string;
  name?: string;
  value?: number | string;
}

export interface ChartTooltipProps {
  active?: boolean;
  label?: string;
  payload?: TooltipPayloadItem[];
  valueFormatter?: (value: number | string) => string;
}

export default function ChartTooltip({ active, label, payload, valueFormatter }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className={styles.box}>
      <div className={styles.time}>{label ?? ""}</div>
      {payload.map((item) => (
        <div key={item.name} className={styles.row}>
          <span className={styles.swatch} style={{ background: item.color }} />
          <span className={styles.name}>{item.name}</span>
          <span className={styles.value}>
            {item.value !== undefined
              ? valueFormatter
                ? valueFormatter(item.value)
                : item.value
              : "-"}
          </span>
        </div>
      ))}
    </div>
  );
}

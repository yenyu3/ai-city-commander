import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, TimerReset } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./ETEBreakdownCard.module.css";

function useCountUp(target: number) {
  const [value, setValue] = useState(0);
  const prevTarget = useRef(0);

  useEffect(() => {
    const start = prevTarget.current;
    const startTime = performance.now();
    const duration = 600;

    let raf: number;
    function tick(now: number) {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(start + (target - start) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    prevTarget.current = target;
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return value;
}

export default function ETEBreakdownCard() {
  const alerts = useAppStore((s) => s.alerts);
  const { language } = useLanguage();
  const latest = alerts.find((a) => a.kind === "accident" && a.ete !== undefined);
  const displayEte = useCountUp(latest?.ete ?? 0);

  if (!latest || latest.ete === undefined) return null;

  const finalStep = latest.reasoningSteps?.find((s) => s.status === "final");
  const congestionWarning = latest.ruleSummary.includes("併行大眾運輸") || finalStep?.detail.includes("congestion");

  const base = latest.eteBase ?? 0;
  const penalty = latest.etePenalty ?? 0;
  const total = base + penalty || 1;
  const basePct = (base / total) * 100;
  const penaltyPct = (penalty / total) * 100;
  const compositionStyle = {
    "--base-pct": `${basePct}%`,
    "--penalty-pct": `${penaltyPct}%`,
  } as CSSProperties & Record<"--base-pct" | "--penalty-pct", string>;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>{pick(language, "預計恢復時間", "Estimated Recovery")}</div>
        <span className={styles.badge}>ETE</span>
      </div>

      <div className={styles.estimateRow}>
        <div className={styles.dial} style={compositionStyle} aria-label={pick(language, `預計 ${latest.ete} 分鐘恢復`, `Estimated recovery in ${latest.ete} minutes`)}>
          <div className={styles.dialInner}>
            <TimerReset size={18} aria-hidden="true" />
            <div className={styles.bigNumber}>{displayEte}</div>
            <span className={styles.unit}>{pick(language, "分鐘", "min")}</span>
          </div>
        </div>

        {latest.eteBase !== undefined && (
          <div className={styles.metrics}>
            <div className={styles.metric}>
              <span className={`${styles.metricRail} ${styles.metricRailBase}`} />
              <span className={styles.metricLabel}>{pick(language, "基礎清空", "Base")}</span>
              <strong>{base}</strong>
              <span className={styles.metricUnit}>{pick(language, "分鐘", "min")}</span>
            </div>
            <div className={styles.metric}>
              <span className={`${styles.metricRail} ${styles.metricRailPenalty}`} />
              <span className={styles.metricLabel}>{pick(language, "壅塞加成", "Penalty")}</span>
              <strong>{penalty.toFixed(1)}</strong>
              <span className={styles.metricUnit}>{pick(language, "分鐘", "min")}</span>
            </div>
          </div>
        )}
      </div>

      {latest.eteBase !== undefined && (
        <div className={styles.caption}>
          {pick(language, "環形比例顯示時間來源：藍色為清空時間，黃色為壅塞延誤。", "Ring split shows time source: blue for clearance, yellow for congestion delay.")}
        </div>
      )}

      {finalStep && <div className={styles.formula}>{finalStep.detail}</div>}
      {congestionWarning && (
        <div className={styles.warning}>
          <AlertTriangle size={14} aria-hidden="true" />
          {pick(language, "疏散路徑亦壅塞，建議併行大眾運輸", "Evacuation route also congested; recommend parallel transit")}
        </div>
      )}
    </div>
  );
}

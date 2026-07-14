import { useEffect, useRef, useState } from "react";
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

  return (
    <div className={styles.card}>
      <div className={styles.title}>{pick(language, "預計恢復時間 ETE", "Estimated Time to Ease (ETE)")}</div>
      <div className={styles.bigNumber}>
        {displayEte} <span className={styles.unit}>{pick(language, "分鐘", "min")}</span>
      </div>

      {latest.eteBase !== undefined && (
        <div className={styles.breakdown}>
          <div className={styles.bar}>
            <span className={styles.barBase} style={{ width: `${basePct}%` }} />
            <span className={styles.barPenalty} style={{ width: `${penaltyPct}%` }} />
          </div>
          <div className={styles.breakdownLegend}>
            <span className={styles.legendItem}>
              <span className={`${styles.legendDot} ${styles.dotBase}`} />
              {pick(language, "基礎清空時間", "Base clearance")} {base}
              {pick(language, "分", "m")}
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendDot} ${styles.dotPenalty}`} />
              {pick(language, "壅塞加成", "Congestion penalty")} {penalty.toFixed(1)}
              {pick(language, "分", "m")}
            </span>
          </div>
        </div>
      )}

      {finalStep && <div className={styles.formula}>{finalStep.detail}</div>}
      {congestionWarning && (
        <div className={styles.warning}>
          {pick(language, "⚠ 疏散路徑亦壅塞，建議併行大眾運輸", "⚠ Evacuation route also congested — recommend parallel transit")}
        </div>
      )}
    </div>
  );
}

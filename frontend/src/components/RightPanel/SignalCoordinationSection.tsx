import { useEffect, useState } from "react";
import { Bus, ShieldAlert, Train } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { opsCoordinationAdapter, type OpsCoordinationPlan } from "../../services/opsCoordinationAdapter";
import { pick, useLanguage } from "../../i18n";
import styles from "./SignalCoordinationSection.module.css";

const AGENCY_ICON = { train: Train, bus: Bus, shield: ShieldAlert };

export default function SignalCoordinationSection() {
  const alerts = useAppStore((s) => s.alerts);
  const { language } = useLanguage();
  const latest = alerts[0];
  const [plan, setPlan] = useState<OpsCoordinationPlan | null>(null);

  useEffect(() => {
    if (!latest) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    setPlan(null);
    opsCoordinationAdapter.getCoordinationPlan(latest).then((result) => {
      if (!cancelled) setPlan(result);
    });
    return () => {
      cancelled = true;
    };
  }, [latest]);

  if (!latest) {
    return (
      <div className={styles.empty}>
        {pick(
          language,
          "尚無事件可顯示號誌與跨系統聯動建議",
          "No event to show signal or inter-agency coordination for yet",
        )}
      </div>
    );
  }

  if (!plan) {
    return (
      <p className={styles.loading}>
        <span className={styles.spinner} aria-hidden="true" />
        {pick(language, "協調方案生成中…", "Generating coordination plan…")}
      </p>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.periodRow}>
        <span>{pick(language, "調整時段", "Adjustment window")}</span>
        <strong>{plan.period}</strong>
      </div>

      <div className={styles.subLabel}>
        {pick(language, "號誌動態配時調整建議", "Signal timing adjustments")}
      </div>
      <ul className={styles.timingList}>
        {plan.signalTimings.map((row) => (
          <li key={row.intersectionName} className={styles.timingRow}>
            <div className={styles.timingHead}>
              <span>{row.intersectionName}</span>
              <span className={styles.timingValues}>
                <strong>+{row.adjustPct}%</strong>
              </span>
            </div>
            <p className={styles.timingGoal}>{row.goal}</p>
          </li>
        ))}
      </ul>

      <div className={styles.subLabel}>
        {pick(language, "跨系統聯動請求", "Inter-agency actions")}
      </div>
      <ul className={styles.agencyList}>
        {plan.interAgencyActions.map((action) => {
          const Icon = AGENCY_ICON[action.icon];
          return (
            <li key={action.agency} className={styles.agencyItem}>
              <div className={styles.agencyHead}>
                <Icon size={14} aria-hidden="true" />
                <span>{action.agency}</span>
              </div>
              <p>{action.text}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

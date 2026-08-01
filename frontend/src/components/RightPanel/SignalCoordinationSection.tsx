import { Bus, ShieldAlert, Train } from "lucide-react";
import { pick, useLanguage } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import styles from "./SignalCoordinationSection.module.css";

const AGENCY_ICON: Record<string, typeof Train> = { train: Train, bus: Bus, shield: ShieldAlert };

export default function SignalCoordinationSection() {
  const alerts = useAppStore((s) => s.alerts);
  const activeAlertId = useAppStore((s) => s.activeAlertId);
  const { language } = useLanguage();
  const latest = alerts.find((a) => a.id === activeAlertId) ?? alerts[0];

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

  const signalTimings = latest.signalCoordination?.signalTimings ?? [];
  const interAgencyActions = latest.crossSystemCoordination?.interAgencyActions ?? [];

  if (signalTimings.length === 0 && interAgencyActions.length === 0) {
    return (
      <div className={styles.empty}>
        {pick(language, "此事件無號誌與跨機關資料", "No signal or inter-agency data for this event")}
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {signalTimings.length > 0 && (
        <>
          <div className={styles.subLabelRow}>
            <span className={styles.subLabel}>
              {pick(language, "號誌動態配時調整建議", "Signal timing adjustments")}
            </span>
          </div>
          <ul className={styles.timingList}>
            {signalTimings.map((row) => (
              <li key={row.intersectionName} className={styles.timingRow}>
                <div className={styles.timingHead}>
                  <span>{row.intersectionName}</span>
                  <span className={styles.timingValues}>
                    {pick(language, "綠燈延長", "Green light")} <strong>+{row.adjustPct}%</strong>
                  </span>
                </div>
                <p className={styles.timingGoal}>{row.goal}</p>
              </li>
            ))}
          </ul>
        </>
      )}

      {interAgencyActions.length > 0 && (
        <>
          <div className={styles.subLabel}>
            {pick(language, "跨系統聯動請求", "Inter-agency actions")}
          </div>
          <ul className={styles.agencyList}>
            {interAgencyActions.map((action) => {
              const Icon = AGENCY_ICON[action.icon] ?? ShieldAlert;
              return (
                <li key={action.agency} className={styles.agencyItem}>
                  <div className={styles.iconWrap}>
                    <Icon size={20} aria-hidden="true" />
                  </div>
                  <div>
                    <div className={styles.agencyHead}>{action.agency}</div>
                    <p>{action.text}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

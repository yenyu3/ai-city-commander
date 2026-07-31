import { AlertTriangle, Check, Route } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./RerouteSection.module.css";

export default function RerouteSection() {
  const alerts = useAppStore((s) => s.alerts);
  const { language } = useLanguage();
  const latest = alerts[0];

  if (!latest) return null;

  const reroute = latest.reroute;

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>{pick(language, "替代路徑疏散規劃", "Rerouting Plan")}</div>
      {!reroute ? (
        <div className={styles.empty}>
          {pick(language, "此事件類型無替代路徑建議", "No rerouting recommendation for this event type")}
        </div>
      ) : (
        <div className={styles.list}>
          <div className={`${styles.card} ${styles.primary}`}>
            <div className={styles.cardBody}>
              <div className={styles.iconWrap}>
                <Check size={20} aria-hidden="true" />
              </div>
              <div>
                <div className={styles.cardHead}>
                  <span>{pick(language, "主要疏散路徑", "Primary route")}</span>
                </div>
                <p className={styles.routeName}>
                  {reroute.primaryRouteName ??
                    pick(language, "無符合條件之替代路段", "No qualifying alternative route")}
                </p>
                {reroute.congestionWarning && (
                  <p className={styles.warningNote}>
                    {pick(
                      language,
                      "疏散路徑亦壅塞，建議併行大眾運輸",
                      "Route is also congested — recommend combining with public transit",
                    )}
                  </p>
                )}
              </div>
            </div>
          </div>

          {reroute.secondaryRouteNames.length > 0 && (
            <div className={`${styles.card} ${styles.secondaryCard}`}>
              <div className={styles.cardBody}>
                <div className={styles.iconWrap}>
                  <Route size={20} aria-hidden="true" />
                </div>
                <div>
                  <div className={styles.cardHead}>
                    <span>{pick(language, "次要替代路徑", "Secondary routes")}</span>
                  </div>
                  <ul className={styles.plainList}>
                    {reroute.secondaryRouteNames.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {reroute.excluded.length > 0 && (
            <div className={`${styles.card} ${styles.excludedCard}`}>
              <div className={styles.cardBody}>
                <div className={styles.iconWrap}>
                  <AlertTriangle size={20} aria-hidden="true" />
                </div>
                <div>
                  <div className={styles.cardHead}>
                    <span>{pick(language, "排除候選路段說明", "Excluded candidates")}</span>
                  </div>
                  <ul className={styles.plainList}>
                    {reroute.excluded.map((e) => (
                      <li key={e.segmentName}>
                        <strong>{e.segmentName}</strong>：{e.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

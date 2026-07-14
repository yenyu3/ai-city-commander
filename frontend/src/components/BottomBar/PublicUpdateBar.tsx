import { Clock3, Info, MapPinned } from "lucide-react";
import { useMemo } from "react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { formatDisplayTimestamp } from "../../utils/timeUtils";
import { getPublicAlertText } from "../../utils/publicView";
import styles from "./PublicUpdateBar.module.css";

export default function PublicUpdateBar() {
  const { language } = useLanguage();
  const currentTime = useAppStore((s) => s.currentTime);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const alerts = useAppStore((s) => s.alerts);
  const activeIncidents = useAppStore((s) => s.activeIncidents);

  const publicUpdates = useMemo(
    () =>
      alerts.slice(0, 4).map((alert) => ({
        id: alert.id,
        title: getPublicAlertText(alert, language),
        timestamp: alert.timestamp,
      })),
    [alerts, language],
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.heading}>
        <Info size={17} aria-hidden="true" />
        <div>
          <p>{pick(language, "官方公告", "Official Notices")}</p>
          <span>
            {pick(language, "更新時間", "Updated")} {formatDisplayTimestamp(currentTime, timeOffsetMs)}
          </span>
        </div>
      </div>

      <div className={styles.updates}>
        {publicUpdates.length === 0 ? (
          <article className={styles.update}>
            <Clock3 size={15} aria-hidden="true" />
            <div>
              <strong>{pick(language, "目前沒有重大公開事件", "No major public incidents")}</strong>
              <span>{pick(language, "城市交通與人流維持監測中。", "Traffic and crowd conditions are being monitored.")}</span>
            </div>
          </article>
        ) : (
          publicUpdates.map((update) => (
            <article key={update.id} className={styles.update}>
              <Clock3 size={15} aria-hidden="true" />
              <div>
                <strong>{update.title}</strong>
                <span>{formatDisplayTimestamp(update.timestamp, timeOffsetMs)}</span>
              </div>
            </article>
          ))
        )}
      </div>

      <div className={styles.incidentPill}>
        <MapPinned size={15} aria-hidden="true" />
        <span>
          {pick(language, "處理中事件", "Active incidents")} {activeIncidents.length}
        </span>
      </div>
    </div>
  );
}

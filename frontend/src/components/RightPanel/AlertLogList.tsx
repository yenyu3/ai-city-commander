import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { ALERT_KIND_COLOR, ALERT_KIND_LABEL } from "../../utils/alertLabels";
import { formatDisplayTimestamp } from "../../utils/timeUtils";
import { getPublicAlertText } from "../../utils/publicView";
import styles from "./AlertLogList.module.css";

export default function AlertLogList() {
  const alerts = useAppStore((s) => s.alerts);
  const viewerMode = useAppStore((s) => s.viewerMode);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const { language } = useLanguage();

  if (alerts.length === 0) {
    return (
      <div className={styles.wrap}>
        <p className={styles.empty}>{pick(language, "目前尚無事件紀錄。", "No alerts recorded yet.")}</p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.list}>
        {alerts.map((alert) => (
          <div key={alert.id} className={styles.row}>
            <div className={styles.meta}>
              <span className={styles.time}>{formatDisplayTimestamp(alert.timestamp, timeOffsetMs)}</span>
              <span className={styles.kind} style={{ color: ALERT_KIND_COLOR[alert.kind] }}>
                {pick(language, ALERT_KIND_LABEL[alert.kind].zh, ALERT_KIND_LABEL[alert.kind].en)}
              </span>
              <div className={styles.metaRight}>
                {viewerMode === "government" && alert.ete !== undefined && (
                  <span className={styles.ete}>ETE {alert.ete} {pick(language, "分", "min")}</span>
                )}
                {viewerMode === "government" && alert.sopRef && (
                  <span className={styles.sop}>{alert.sopRef}</span>
                )}
              </div>
            </div>
            <span className={styles.text}>
              {viewerMode === "public" ? getPublicAlertText(alert, language) : alert.llmText || alert.title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

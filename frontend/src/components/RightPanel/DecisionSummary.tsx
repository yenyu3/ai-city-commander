import { ArrowRight, ClipboardList, Clock3 } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { ALERT_KIND_LABEL } from "../../utils/alertLabels";
import { formatDisplayTimestamp } from "../../utils/timeUtils";
import styles from "./DecisionSummary.module.css";

export default function DecisionSummary() {
  const alerts = useAppStore((s) => s.alerts);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const { language } = useLanguage();
  const latest = alerts[0];

  if (!latest) {
    return (
      <div className={styles.wrap}>
        <div className={styles.title}>{pick(language, "事件摘要", "Event Summary")}</div>
        <div className={styles.empty}>
          {pick(language, "城市監控中，尚無事件需要處理", "Monitoring the city — no incident requires action yet")}
        </div>
      </div>
    );
  }

  const actionItems = latest.ruleSummary
    .split(/[。；;]/)
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <div className={styles.wrap}>
      <div className={styles.headRow}>
        <div className={styles.eventIdentity}>
          <div className={styles.title}>{pick(language, "決策摘要", "Decision Summary")}</div>
          <div className={styles.eventTitle}>{latest.title}</div>
          <div className={styles.eventTime}>
            <Clock3 size={14} aria-hidden="true" />
            {formatDisplayTimestamp(latest.timestamp, timeOffsetMs)}
          </div>
        </div>
        <span className={styles.kind}>
          {pick(language, ALERT_KIND_LABEL[latest.kind].zh, ALERT_KIND_LABEL[latest.kind].en)}
        </span>
      </div>

      {latest.ete !== undefined && (
        <div className={styles.eteLine}>
          <strong>{latest.ete}</strong>
          <span>{pick(language, "分鐘後預估恢復通行", "min estimated until traffic recovers")}</span>
        </div>
      )}

      <div className={styles.summaryBlock}>
        <span className={styles.summaryLabel}>
          <ClipboardList size={16} aria-hidden="true" />
          {pick(language, "情況摘要", "Situation Summary")}
        </span>
        {latest.llmText ? (
          <p className={styles.summaryText}>{latest.llmText}</p>
        ) : (
          <p className={styles.aiLoading}>{pick(language, "AI 摘要生成中…", "Generating AI summary…")}</p>
        )}
      </div>

      <div className={styles.actionsBlock}>
        <span className={styles.actionsLabel}>{pick(language, "建議行動", "Recommended Actions")}</span>
        <ul className={styles.actionList}>
          {actionItems.map((item) => (
            <li key={item} className={styles.actionItem}>
              <ArrowRight size={18} aria-hidden="true" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      {latest.sopRef && (
        <div className={styles.sopRow}>
          <span className={styles.sopLabel}>{pick(language, "依據", "Refs")}</span>
          <p className={styles.sopText}>{latest.sopRef}</p>
        </div>
      )}
    </div>
  );
}

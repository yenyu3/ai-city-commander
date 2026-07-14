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

  const sopChips = (latest.sopRef ?? "").split(/[/·]/).map((s) => s.trim()).filter(Boolean);

  return (
    <div className={styles.wrap}>
      <div className={styles.headRow}>
        <span className={styles.kind}>
          {pick(language, ALERT_KIND_LABEL[latest.kind].zh, ALERT_KIND_LABEL[latest.kind].en)}
        </span>
        <span className={styles.time}>{formatDisplayTimestamp(latest.timestamp, timeOffsetMs)}</span>
      </div>
      <div className={styles.eventTitle}>{latest.title}</div>
      <div className={styles.ruleSummary}>{latest.ruleSummary}</div>

      <div className={styles.aiBlock}>
        <span className={styles.aiLabel}>{pick(language, "AI 建議行動", "AI Suggested Action")}</span>
        {latest.llmText ? (
          <p className={styles.aiText}>{latest.llmText}</p>
        ) : (
          <p className={styles.aiLoading}>{pick(language, "AI 摘要生成中…", "Generating AI summary…")}</p>
        )}
      </div>

      {sopChips.length > 0 && (
        <div className={styles.sopRow}>
          {sopChips.map((chip) => (
            <span key={chip} className={styles.sopChip}>
              {chip}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

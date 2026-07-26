import { Bot, Clock3, FileText, ShieldAlert } from "lucide-react";
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
        <div>
          <div className={styles.title}>{pick(language, "決策摘要", "Decision Summary")}</div>
          <div className={styles.eventTitle}>{latest.title}</div>
        </div>
        <span className={styles.kind}>
          <ShieldAlert size={14} aria-hidden="true" />
          {pick(language, ALERT_KIND_LABEL[latest.kind].zh, ALERT_KIND_LABEL[latest.kind].en)}
        </span>
      </div>

      <div className={styles.metaStrip}>
        <span className={styles.metaItem}>
          <Clock3 size={14} aria-hidden="true" />
          {formatDisplayTimestamp(latest.timestamp, timeOffsetMs)}
        </span>
        {latest.ete !== undefined && (
          <span className={styles.metaItem}>
            {pick(language, "預估恢復", "ETE")} <strong>{latest.ete}</strong>
            {pick(language, "分鐘", "min")}
          </span>
        )}
      </div>

      <div className={styles.aiBlock}>
        <span className={styles.aiLabel}>
          <Bot size={15} aria-hidden="true" />
          {pick(language, "AI 建議行動", "AI Suggested Action")}
        </span>
        {latest.llmText ? (
          <p className={styles.aiText}>{latest.llmText}</p>
        ) : (
          <p className={styles.aiLoading}>{pick(language, "AI 摘要生成中…", "Generating AI summary…")}</p>
        )}
      </div>

      <div className={styles.ruleBlock}>
        <span className={styles.ruleLabel}>{pick(language, "觸發判斷", "Rule Trigger")}</span>
        <p className={styles.ruleSummary}>{latest.ruleSummary}</p>
      </div>

      {sopChips.length > 0 && (
        <div className={styles.sopRow}>
          <span className={styles.sopLabel}>
            <FileText size={13} aria-hidden="true" />
            {pick(language, "依據", "Refs")}
          </span>
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

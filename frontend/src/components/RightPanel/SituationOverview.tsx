import { pick, useLanguage } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import styles from "./SituationOverview.module.css";

/** 顯示 incident summary（優先）或 city sweep summary 的 headline + text（gov 模式）。 */
export default function SituationOverview() {
  const incidentGovernmentSummary = useAppStore((s) => s.incidentGovernmentSummary);
  const governmentSummary = useAppStore((s) => s.governmentSummary);
  const { language } = useLanguage();

  const summary = incidentGovernmentSummary ?? governmentSummary;
  if (!summary) return null;

  return (
    <div className={styles.card}>
      <span className={styles.title}>
        {pick(language, "周邊情勢摘要", "Situation Overview")}
      </span>
      {summary.headline && <strong className={styles.headline}>{summary.headline}</strong>}
      <p className={styles.text}>{summary.text}</p>
    </div>
  );
}

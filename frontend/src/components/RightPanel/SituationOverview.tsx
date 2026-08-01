import { pick, useLanguage } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import styles from "./SituationOverview.module.css";

/**
 * GET /api/decisions 的 situationSummary：後端依查詢 locationId 週邊路況/人潮
 * 綜合生成的一段情勢摘要，跟下方個別 alert 的決策摘要是不同層級的內容，
 * 政府端也要看得到（民眾模式對應顯示於 PublicAssistantPanel 的 hero 卡）。
 */
export default function SituationOverview() {
  const citySituationSummary = useAppStore((s) => s.citySituationSummary);
  const { language } = useLanguage();

  if (!citySituationSummary) return null;

  return (
    <div className={styles.card}>
      <span className={styles.title}>
        {pick(language, "周邊情勢摘要", "Situation Overview")}
      </span>
      <p className={styles.text}>{citySituationSummary}</p>
    </div>
  );
}

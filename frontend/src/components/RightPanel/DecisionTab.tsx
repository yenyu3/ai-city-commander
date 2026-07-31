import DecisionSummary from "./DecisionSummary";
import ReasoningChain from "./ReasoningChain";
import ETEBreakdownCard from "./ETEBreakdownCard";
import MultilingualPreview from "./MultilingualPreview";
import AlertLogList from "./AlertLogList";
import CollapsibleSection from "../common/CollapsibleSection";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./DecisionTab.module.css";

export default function DecisionTab() {
  const { language } = useLanguage();
  const stations = useAppStore((s) => s.stations);

  // multilingualTriggered comes from the backend's decide_multilingual()
  // (GET /api/city-state), not a local recomputation -- see appStore.ts.
  const multilingualCount = Object.values(stations).filter((st) => st.multilingualTriggered).length;

  return (
    <div className={styles.wrap}>
      <DecisionSummary />
      <ETEBreakdownCard />
      <section id="decision-reasoning" className={styles.section}>
        <ReasoningChain />
      </section>

      <section id="decision-multilingual" className={styles.section}>
        <CollapsibleSection
          storageKey="decision-multilingual"
          className={styles.collapsible}
          title={
            pick(language, "多語警示", "Multilingual alerts") +
            (multilingualCount > 0 ? ` (${multilingualCount})` : "")
          }
        >
          <MultilingualPreview />
        </CollapsibleSection>
      </section>

      <section id="decision-alert-log" className={styles.section}>
        <CollapsibleSection
          storageKey="decision-alert-log"
          className={styles.collapsible}
          title={pick(language, "查看完整事件紀錄", "Full alert log")}
        >
          <AlertLogList />
        </CollapsibleSection>
      </section>
    </div>
  );
}

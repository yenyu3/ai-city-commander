import DecisionSummary from "./DecisionSummary";
import ReasoningChain from "./ReasoningChain";
import ETEBreakdownCard from "./ETEBreakdownCard";
import MultilingualPreview from "./MultilingualPreview";
import AlertLogList from "./AlertLogList";
import CollapsibleSection from "../common/CollapsibleSection";
import { useAppStore } from "../../store/appStore";
import { checkMultilingualNeeded } from "../../engine/multilingualCheck";
import { pick, useLanguage } from "../../i18n";
import styles from "./DecisionTab.module.css";

export default function DecisionTab() {
  const { language } = useLanguage();
  const stations = useAppStore((s) => s.stations);
  const currentTime = useAppStore((s) => s.currentTime);

  const multilingualCount = checkMultilingualNeeded(
    Object.values(stations).map((st) => ({
      timestamp: currentTime,
      stationId: st.stationId,
      locationName: st.name,
      userCount: st.userCount,
      stayTimeAvg: st.stayTimeAvg,
      growthRate: st.growthRate,
      roamingPct: st.roamingPct,
    })),
  ).length;

  return (
    <div className={styles.wrap}>
      <DecisionSummary />
      <ETEBreakdownCard />
      <ReasoningChain />

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

      <CollapsibleSection
        storageKey="decision-alert-log"
        className={styles.collapsible}
        title={pick(language, "查看完整事件紀錄", "Full alert log")}
      >
        <AlertLogList />
      </CollapsibleSection>
    </div>
  );
}

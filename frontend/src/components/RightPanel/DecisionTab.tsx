import { useState } from "react";
import { pick, useLanguage } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import { formatDisplayTimestamp } from "../../utils/timeUtils";
import DecisionSummary from "./DecisionSummary";
import styles from "./DecisionTab.module.css";
import ETEBreakdownCard from "./ETEBreakdownCard";
import MetricsSnapshot from "./MetricsSnapshot";
import ReasoningChain from "./ReasoningChain";
import RerouteSection from "./RerouteSection";
import SignalCoordinationSection from "./SignalCoordinationSection";
import SituationOverview from "./SituationOverview";

const SUMMARY_VALUE = "__summary__";

export default function DecisionTab() {
  const { language } = useLanguage();
  const alerts = useAppStore((s) => s.alerts);
  const activeAlertId = useAppStore((s) => s.activeAlertId);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const incidentGovernmentSummary = useAppStore((s) => s.incidentGovernmentSummary);
  const governmentSummary = useAppStore((s) => s.governmentSummary);
  const hasSummary = !!(incidentGovernmentSummary ?? governmentSummary);

  const [selected, setSelected] = useState<string>(SUMMARY_VALUE);
  const effectiveSelected = hasSummary ? selected : (activeAlertId ?? alerts[0]?.id ?? "");
  const showSummary = effectiveSelected === SUMMARY_VALUE && hasSummary;

  // 切換選項時同步更新 activeAlertId
  const handleChange = (value: string) => {
    setSelected(value);
    if (value !== SUMMARY_VALUE) {
      useAppStore.setState({ activeAlertId: value });
    }
  };

  return (
    <div className={styles.wrap}>
      {(hasSummary || alerts.length > 0) && (
        <select
          className={styles.selector}
          value={effectiveSelected}
          onChange={(e) => handleChange(e.target.value)}
          aria-label={pick(language, "選擇決策項目", "Select decision")}
        >
          {hasSummary && (
            <option value={SUMMARY_VALUE}>
              {pick(language, "綜合摘要", "Summary")}
            </option>
          )}
          {alerts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}{a.timestamp ? `　${formatDisplayTimestamp(a.timestamp, timeOffsetMs)}` : ""}
            </option>
          ))}
        </select>
      )}

      {!showSummary && <SituationOverview />}
      <DecisionSummary showSummary={showSummary} />

      {!showSummary && (
        <>
          <ETEBreakdownCard />
          <section id="decision-reasoning" className={styles.section}>
            <MetricsSnapshot />
            <ReasoningChain />
          </section>
          <section id="decision-reroute" className={styles.section}>
            <RerouteSection />
          </section>
          <section id="decision-signals" className={styles.section}>
            <SignalCoordinationSection />
          </section>
        </>
      )}
    </div>
  );
}

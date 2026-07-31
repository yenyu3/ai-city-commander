import { useLanguage } from "../../i18n";
import DecisionSummary from "./DecisionSummary";
import styles from "./DecisionTab.module.css";
import ETEBreakdownCard from "./ETEBreakdownCard";
import MetricsSnapshot from "./MetricsSnapshot";
import ReasoningChain from "./ReasoningChain";
import RerouteSection from "./RerouteSection";
import SignalCoordinationSection from "./SignalCoordinationSection";

export default function DecisionTab() {
  const { language } = useLanguage();

  return (
    <div className={styles.wrap}>
      <DecisionSummary />
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
    </div>
  );
}

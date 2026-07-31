import LocationRelevanceCard from "../common/LocationRelevanceCard";
import DecisionSummary from "./DecisionSummary";
import styles from "./DecisionTab.module.css";
import ETEBreakdownCard from "./ETEBreakdownCard";
import MetricsSnapshot from "./MetricsSnapshot";
import ReasoningChain from "./ReasoningChain";
import RerouteSection from "./RerouteSection";
import SignalCoordinationSection from "./SignalCoordinationSection";

export default function DecisionTab() {
  return (
    <div className={styles.wrap}>
      <LocationRelevanceCard />
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

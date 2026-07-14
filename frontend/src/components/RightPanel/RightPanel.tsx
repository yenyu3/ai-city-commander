import ReasoningChain from "./ReasoningChain";
import ETEBreakdownCard from "./ETEBreakdownCard";
import ChatPanel from "./ChatPanel";
import MultilingualPreview from "./MultilingualPreview";
import styles from "./RightPanel.module.css";

export default function RightPanel() {
  return (
    <div className={styles.wrap}>
      <div className={styles.top}>
        <ReasoningChain />
        <ETEBreakdownCard />
      </div>
      <div className={styles.bottom}>
        <ChatPanel />
        <MultilingualPreview />
      </div>
    </div>
  );
}

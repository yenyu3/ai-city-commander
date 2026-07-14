import { useState } from "react";
import { Bot, ShieldCheck } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { checkMultilingualNeeded } from "../../engine/multilingualCheck";
import { pick, useLanguage } from "../../i18n";
import PanelHeader from "../common/PanelHeader";
import DecisionSummary from "./DecisionSummary";
import PublicAssistantPanel from "./PublicAssistantPanel";
import ReasoningChain from "./ReasoningChain";
import ETEBreakdownCard from "./ETEBreakdownCard";
import ChatPanel from "./ChatPanel";
import MultilingualPreview from "./MultilingualPreview";
import styles from "./RightPanel.module.css";

type TabKey = "whatif" | "multilingual";

export default function RightPanel() {
  const [tab, setTab] = useState<TabKey>("whatif");
  const { language } = useLanguage();
  const viewerMode = useAppStore((s) => s.viewerMode);
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

  const TABS: { key: TabKey; label: string }[] = [
    { key: "whatif", label: pick(language, "What-if 問答", "What-if Q&A") },
    {
      key: "multilingual",
      label:
        pick(language, "多語警示", "Multilingual") + (multilingualCount > 0 ? ` (${multilingualCount})` : ""),
    },
  ];

  if (viewerMode === "public") {
    return (
      <div className={styles.wrap}>
        <PanelHeader icon={ShieldCheck} title={pick(language, "市民助手", "Public Assistant")} zone="right" />
        <PublicAssistantPanel />
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <PanelHeader icon={Bot} title={pick(language, "AI 決策面板", "AI Decision Panel")} zone="right" />
      <div className={styles.top}>
        <DecisionSummary />
        <ReasoningChain />
        <ETEBreakdownCard />
      </div>
      <div className={styles.bottom}>
        <div className={styles.tabBar} role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={tab === t.key ? styles.tabActive : styles.tab}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className={styles.tabContent}>
          {tab === "whatif" && <ChatPanel />}
          {tab === "multilingual" && <MultilingualPreview />}
        </div>
      </div>
    </div>
  );
}

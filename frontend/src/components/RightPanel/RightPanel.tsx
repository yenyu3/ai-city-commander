import { useLayoutEffect, useRef, useState } from "react";
import { Bot, LayoutDashboard, ShieldCheck } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import PanelHeader from "../common/PanelHeader";
import TabBar from "../common/TabBar";
import PublicAssistantPanel from "./PublicAssistantPanel";
import SituationTab from "../LeftPanel/LeftPanel";
import DecisionTab from "./DecisionTab";
import InjectIncidentButton from "./InjectIncidentButton";
import ExportReportButton from "./ExportReportButton";
import styles from "./RightPanel.module.css";

type TabKey = "situation" | "decision";

export default function RightPanel() {
  const [tab, setTab] = useState<TabKey>("situation");
  const tabRef = useRef<TabKey>("situation");
  const tabContentRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<TabKey, number>>({
    situation: 0,
    decision: 0,
  });
  const { language } = useLanguage();
  const viewerMode = useAppStore((s) => s.viewerMode);
  const roomTitle = pick(language, "城市情報室", "City Intelligence Room");

  useLayoutEffect(() => {
    const node = tabContentRef.current;
    if (!node) return;
    node.scrollTop = scrollPositions.current[tab] ?? 0;
    tabRef.current = tab;
  }, [tab]);

  if (viewerMode === "public") {
    return (
      <div className={styles.tabWrap}>
        <PanelHeader icon={ShieldCheck} title={pick(language, "民眾助手", "Public Assistant")} />
        <PublicAssistantPanel />
      </div>
    );
  }

  const TABS: { key: TabKey; label: string }[] = [
    { key: "decision", label: pick(language, "AI 決策", "AI Decision") },
    { key: "situation", label: pick(language, "情境總覽", "Situation") },
  ];

  const handleTabChange = (next: TabKey) => {
    const node = tabContentRef.current;
    if (node) {
      scrollPositions.current[tabRef.current] = node.scrollTop;
    }
    setTab(next);
  };

  return (
    <div className={styles.tabWrap}>
      <PanelHeader
        icon={tab === "situation" ? LayoutDashboard : Bot}
        title={roomTitle}
        actions={
          <>
            <InjectIncidentButton />
            <ExportReportButton />
          </>
        }
      />
      <TabBar tabs={TABS} active={tab} onChange={handleTabChange} className={styles.tabBar} />
      <div className={styles.tabContent} ref={tabContentRef}>
        {tab === "situation" && <SituationTab />}
        {tab === "decision" && <DecisionTab />}
      </div>
    </div>
  );
}

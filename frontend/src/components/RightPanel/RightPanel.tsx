import { useState } from "react";
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
  const { language } = useLanguage();
  const viewerMode = useAppStore((s) => s.viewerMode);
  const roomTitle = pick(language, "城市情報室", "City Intelligence Room");

  if (viewerMode === "public") {
    return (
      <div className={styles.tabWrap}>
        <PanelHeader icon={ShieldCheck} title={pick(language, "民眾助手", "Public Assistant")} />
        <PublicAssistantPanel />
      </div>
    );
  }

  const TABS: { key: TabKey; label: string }[] = [
    { key: "situation", label: pick(language, "情境總覽", "Situation") },
    { key: "decision", label: pick(language, "AI 決策", "AI Decision") },
  ];

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
      <TabBar tabs={TABS} active={tab} onChange={setTab} className={styles.tabBar} />
      <div className={styles.tabContent}>
        {tab === "situation" && <SituationTab />}
        {tab === "decision" && <DecisionTab />}
      </div>
    </div>
  );
}

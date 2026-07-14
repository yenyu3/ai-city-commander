import { useMemo, useState } from "react";
import { Clock3, LayoutDashboard, Users } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import PanelHeader from "../common/PanelHeader";
import PublicUpdateBar from "../BottomBar/PublicUpdateBar";
import Legend from "./Legend";
import OverviewTab from "./OverviewTab";
import PublicStatusPanel from "./PublicStatusPanel";
import SegmentList from "./SegmentList";
import StationList from "./StationList";
import SaturationTrendChart from "../charts/SaturationTrendChart";
import CrowdTrendChart from "../charts/CrowdTrendChart";
import styles from "./LeftPanel.module.css";

type TabKey = "overview" | "roads" | "crowd";
const TIER_RANK: Record<string, number> = { A: 0, B: 1, Normal: 2 };

export default function LeftPanel() {
  const [tab, setTab] = useState<TabKey>("overview");
  const { language } = useLanguage();
  const segments = useAppStore((s) => s.segments);
  const viewerMode = useAppStore((s) => s.viewerMode);
  const stations = useAppStore((s) => s.stations);
  const traffic = useAppStore((s) => s.traffic);
  const crowd = useAppStore((s) => s.crowd);
  const segmentDefs = useAppStore((s) => s.segmentDefs);
  const currentTime = useAppStore((s) => s.currentTime);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);

  const topSegmentIds = useMemo(
    () =>
      Object.values(segments)
        .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.saturation - a.saturation)
        .slice(0, 3)
        .map((s) => s.segmentId),
    [segments],
  );

  const topStationIds = useMemo(
    () =>
      Object.values(stations)
        .sort((a, b) => b.userCount - a.userCount)
        .slice(0, 3)
        .map((s) => s.stationId),
    [stations],
  );

  const TABS: { key: TabKey; label: string }[] = [
    { key: "overview", label: pick(language, "總覽", "Overview") },
    { key: "roads", label: pick(language, "路段", "Roads") },
    { key: "crowd", label: pick(language, "人流", "Crowd") },
  ];

  if (viewerMode === "public") {
    return (
      <div className={styles.wrap}>
        <PanelHeader icon={Users} title={pick(language, "市民狀態摘要", "Public Status")} zone="left" />
        <PublicStatusPanel />
        <section className={styles.publicUpdates}>
          <div className={styles.inlineTitle}>
            <Clock3 size={13} aria-hidden="true" />
            <span>{pick(language, "最新公開更新", "Latest Public Updates")}</span>
          </div>
          <PublicUpdateBar variant="panel" />
        </section>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <PanelHeader icon={LayoutDashboard} title={pick(language, "情境總覽", "Situation Panel")} zone="left" />
      <Legend />
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
        {tab === "overview" && <OverviewTab />}
        {tab === "roads" && (
          <div className={styles.section}>
            <SaturationTrendChart
              traffic={traffic}
              segmentIds={topSegmentIds}
              segmentDefs={segmentDefs}
              currentTime={currentTime}
              timeOffsetMs={timeOffsetMs}
            />
            <SegmentList />
          </div>
        )}
        {tab === "crowd" && (
          <div className={styles.section}>
            <CrowdTrendChart
              crowd={crowd}
              stationIds={topStationIds}
              currentTime={currentTime}
              timeOffsetMs={timeOffsetMs}
            />
            <StationList />
          </div>
        )}
      </div>
    </div>
  );
}

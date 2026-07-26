import { useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import Legend from "./Legend";
import SegmentList from "./SegmentList";
import StationList from "./StationList";
import SaturationTrendChart from "../charts/SaturationTrendChart";
import CrowdTrendChart from "../charts/CrowdTrendChart";
import InfoPopover from "../common/InfoPopover";
import styles from "./LeftPanel.module.css";

const TIER_RANK: Record<string, number> = { A: 0, B: 1, Normal: 2 };

function scrollToAnchor(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

export default function SituationTab() {
  const { language } = useLanguage();
  const segments = useAppStore((s) => s.segments);
  const stations = useAppStore((s) => s.stations);
  const traffic = useAppStore((s) => s.traffic);
  const crowd = useAppStore((s) => s.crowd);
  const segmentDefs = useAppStore((s) => s.segmentDefs);
  const currentTime = useAppStore((s) => s.currentTime);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const activeIncidents = useAppStore((s) => s.activeIncidents);

  const topSegments = useMemo(
    () =>
      Object.values(segments)
        .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.saturation - a.saturation)
        .slice(0, 3),
    [segments],
  );

  const topStations = useMemo(
    () => Object.values(stations).sort((a, b) => b.userCount - a.userCount).slice(0, 3),
    [stations],
  );

  const riskSource = useMemo(() => {
    if (activeIncidents.length > 0) {
      const rank: Record<string, number> = { Critical: 0, High: 1, Medium: 2 };
      const worst = [...activeIncidents].sort(
        (a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9),
      )[0];
      return { label: pick(language, "現行事件", "Active incident"), value: worst.location };
    }
    if (topSegments[0] && topSegments[0].tier !== "Normal") {
      return {
        label: pick(language, "壅塞熱點", "Congestion hotspot"),
        value: `${topSegments[0].name} (${topSegments[0].tier})`,
      };
    }
    return { label: pick(language, "城市狀態", "City status"), value: pick(language, "監控中，無重大風險", "Monitoring — no major risk") };
  }, [activeIncidents, topSegments, language]);

  const legendLabel = pick(language, "圖例說明", "Legend");
  const legendTitle = pick(language, "圖例", "Legend");

  return (
    <div className={styles.wrap}>
      <div className={styles.riskCard}>
        <span className={styles.riskLabel}>{riskSource.label}</span>
        <span className={styles.riskValue}>{riskSource.value}</span>
        <div className={styles.riskLinks}>
          <a href="#section-roads" className={styles.riskLink} onClick={(e) => scrollToAnchor(e, "section-roads")}>
            <span>{pick(language, "查看路段", "View roads")}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </a>
          <a href="#section-crowd" className={styles.riskLink} onClick={(e) => scrollToAnchor(e, "section-crowd")}>
            <span>{pick(language, "查看人流", "View crowd")}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </a>
        </div>
      </div>

      <section id="section-roads" className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <span className={styles.sectionTitle}>{pick(language, "路段", "Roads")}</span>
          <InfoPopover label={legendLabel} title={legendTitle}>
            <Legend />
          </InfoPopover>
        </div>
        <SaturationTrendChart
          traffic={traffic}
          segmentIds={topSegments.map((s) => s.segmentId)}
          segmentDefs={segmentDefs}
          currentTime={currentTime}
          timeOffsetMs={timeOffsetMs}
          compact
        />
        <SegmentList />
      </section>

      <section id="section-crowd" className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <span className={styles.sectionTitle}>{pick(language, "人流", "Crowd")}</span>
          <InfoPopover label={legendLabel} title={legendTitle}>
            <Legend />
          </InfoPopover>
        </div>
        <CrowdTrendChart
          crowd={crowd}
          stationIds={topStations.map((s) => s.stationId)}
          currentTime={currentTime}
          timeOffsetMs={timeOffsetMs}
          compact
        />
        <StationList />
      </section>
    </div>
  );
}

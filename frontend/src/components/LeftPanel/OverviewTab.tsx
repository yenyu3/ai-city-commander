import { useMemo } from "react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import SaturationTrendChart from "../charts/SaturationTrendChart";
import CrowdTrendChart from "../charts/CrowdTrendChart";
import styles from "./OverviewTab.module.css";

const TIER_RANK: Record<string, number> = { A: 0, B: 1, Normal: 2 };

export default function OverviewTab() {
  const segments = useAppStore((s) => s.segments);
  const stations = useAppStore((s) => s.stations);
  const activeIncidents = useAppStore((s) => s.activeIncidents);
  const traffic = useAppStore((s) => s.traffic);
  const crowd = useAppStore((s) => s.crowd);
  const segmentDefs = useAppStore((s) => s.segmentDefs);
  const currentTime = useAppStore((s) => s.currentTime);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const { language } = useLanguage();

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

  return (
    <div className={styles.wrap}>
      <div className={styles.riskCard}>
        <span className={styles.riskLabel}>{riskSource.label}</span>
        <span className={styles.riskValue}>{riskSource.value}</span>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitle}>{pick(language, "Top 3 風險路段", "Top 3 risk segments")}</div>
        <div className={styles.miniList}>
          {topSegments.map((seg) => (
            <div key={seg.segmentId} className={styles.miniRow}>
              <span className={`${styles.dot} ${styles[`dot${seg.tier}`]}`} />
              <span className={styles.miniName}>{seg.name}</span>
              <span className={styles.miniValue}>{seg.saturation.toFixed(2)}</span>
            </div>
          ))}
        </div>
        <SaturationTrendChart
          traffic={traffic}
          segmentIds={topSegments.map((s) => s.segmentId)}
          segmentDefs={segmentDefs}
          currentTime={currentTime}
          timeOffsetMs={timeOffsetMs}
          compact
        />
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitle}>{pick(language, "Top 3 人流熱點", "Top 3 crowd hotspots")}</div>
        <div className={styles.miniList}>
          {topStations.map((st) => (
            <div key={st.stationId} className={styles.miniRow}>
              <span className={`${styles.dot} ${st.roamingPct >= 0.3 ? styles.dotWarnFlag : styles.dotNormal}`} />
              <span className={styles.miniName}>{st.name}</span>
              <span className={styles.miniValue}>{st.userCount.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <CrowdTrendChart
          crowd={crowd}
          stationIds={topStations.map((s) => s.stationId)}
          currentTime={currentTime}
          timeOffsetMs={timeOffsetMs}
          compact
        />
      </div>
    </div>
  );
}

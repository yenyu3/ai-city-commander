import { useMemo } from "react";
import { AlertTriangle, MapPinned, Navigation, TrainFront } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./PublicStatusPanel.module.css";

const TIER_RANK: Record<string, number> = { A: 0, B: 1, Normal: 2 };

function roadAdvice(tier: string) {
  if (tier === "A") return { zh: "建議避開", en: "Avoid" };
  if (tier === "B") return { zh: "可能延誤", en: "Expect delay" };
  return { zh: "可通行", en: "Open" };
}

export default function PublicStatusPanel() {
  const { language } = useLanguage();
  const segments = useAppStore((s) => s.segments);
  const stations = useAppStore((s) => s.stations);
  const activeIncidents = useAppStore((s) => s.activeIncidents);
  const incidentEte = useAppStore((s) => s.incidentEte);

  const affectedRoads = useMemo(
    () =>
      Object.values(segments)
        .filter((segment) => segment.tier !== "Normal" || segment.isIncidentSource)
        .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.saturation - a.saturation)
        .slice(0, 4),
    [segments],
  );

  const crowdedStations = useMemo(
    () =>
      Object.values(stations)
        .filter((station) => station.userCount >= 20000 || station.growthRate >= 0.25)
        .sort((a, b) => b.userCount - a.userCount)
        .slice(0, 4),
    [stations],
  );

  const maxEte = useMemo(() => {
    const values = Object.values(incidentEte);
    return values.length > 0 ? Math.max(...values) : null;
  }, [incidentEte]);

  return (
    <div className={styles.wrap}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>{pick(language, "一般民眾模式", "Public Mode")}</p>
          <h2>{pick(language, "目前城市提醒", "City Advisory")}</h2>
        </div>
        <div className={styles.summaryGrid}>
          <div>
            <span>{pick(language, "影響區域", "Affected")}</span>
            <strong>{affectedRoads.length + activeIncidents.length}</strong>
          </div>
          <div>
            <span>{pick(language, "人潮提醒", "Crowd")}</span>
            <strong>{crowdedStations.length}</strong>
          </div>
          <div>
            <span>{pick(language, "預估恢復", "Recovery")}</span>
            <strong>{maxEte === null ? "--" : `${maxEte}m`}</strong>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>
          <Navigation size={16} aria-hidden="true" />
          <h3>{pick(language, "交通建議", "Traffic Advice")}</h3>
        </div>
        {affectedRoads.length === 0 ? (
          <p className={styles.empty}>{pick(language, "目前主要道路可正常通行。", "Major roads are currently open.")}</p>
        ) : (
          <div className={styles.list}>
            {affectedRoads.map((road) => {
              const advice = roadAdvice(road.tier);
              return (
                <article key={road.segmentId} className={styles.item}>
                  <MapPinned size={15} aria-hidden="true" />
                  <div>
                    <strong>{road.name}</strong>
                    <span>{pick(language, advice.zh, advice.en)}</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>
          <TrainFront size={16} aria-hidden="true" />
          <h3>{pick(language, "人潮與轉乘", "Crowd & Transit")}</h3>
        </div>
        {crowdedStations.length === 0 ? (
          <p className={styles.empty}>{pick(language, "目前站點人流穩定。", "Station crowd levels are stable.")}</p>
        ) : (
          <div className={styles.list}>
            {crowdedStations.map((station) => (
              <article key={station.stationId} className={styles.item}>
                <AlertTriangle size={15} aria-hidden="true" />
                <div>
                  <strong>{station.name}</strong>
                  <span>
                    {pick(language, "建議預留時間或改由鄰近站點進出。", "Leave extra time or use a nearby station.")}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

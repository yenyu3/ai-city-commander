import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./StationList.module.css";

export default function StationList() {
  const stations = useAppStore((s) => s.stations);
  const { language } = useLanguage();
  const list = Object.values(stations).sort((a, b) => b.roamingPct - a.roamingPct);

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>
        {pick(language, "基地台人流 / 漫遊率", "Cell Site Traffic / Roaming")}
      </div>
      <div className={styles.list}>
        {list.map((st) => (
          <div key={st.stationId} className={styles.row}>
            <span className={styles.name}>{st.name}</span>
            <span className={styles.count} title={pick(language, `${st.userCount.toLocaleString()} 人`, `${st.userCount.toLocaleString()} users`)}>
              {st.userCount >= 1000 ? `${(st.userCount / 1000).toFixed(1)}k` : st.userCount}
            </span>
            <span
              className={`${styles.growth} ${st.growthRate > 0 ? styles.growthUp : st.growthRate < 0 ? styles.growthDown : ""}`}
            >
              {st.growthRate > 0 ? "+" : ""}
              {(st.growthRate * 100).toFixed(0)}%
            </span>
            <span
              className={`${styles.roaming} ${st.roamingPct >= 0.3 ? styles.roamingHot : ""}`}
            >
              {(st.roamingPct * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

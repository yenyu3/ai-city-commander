import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./SegmentList.module.css";

const TIER_RANK: Record<string, number> = { A: 0, B: 1, Normal: 2 };

export default function SegmentList() {
  const segments = useAppStore((s) => s.segments);
  const { language } = useLanguage();
  const list = Object.values(segments).sort(
    (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.saturation - a.saturation,
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>
        {pick(language, `路段飽和度清單（${list.length}）`, `Segment Saturation (${list.length})`)}
      </div>
      <div className={styles.list}>
        {list.map((seg) => (
          <div key={seg.segmentId} className={styles.row}>
            <span className={`${styles.dot} ${styles[`dot${seg.tier}`]}`} />
            <span className={styles.name}>
              {seg.name}
              {seg.isCityTrigger && <span className={styles.starMark}>★</span>}
            </span>
            <span className={styles.sat}>{seg.saturation.toFixed(2)}</span>
            <span className={styles.speed}>{seg.avgSpeed}km/h</span>
          </div>
        ))}
      </div>
    </div>
  );
}

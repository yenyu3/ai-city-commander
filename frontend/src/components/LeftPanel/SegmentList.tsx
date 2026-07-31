import { pick, useLanguage } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import styles from "./SegmentList.module.css";

const TIER_RANK: Record<string, number> = { A: 0, B: 1, Normal: 2 };

export default function SegmentList() {
  const segments = useAppStore((s) => s.segments);
  const selectedSegmentId = useAppStore((s) => s.selectedSegmentId);
  const setSelectedSegment = useAppStore((s) => s.setSelectedSegment);
  const { language } = useLanguage();
  const list = Object.values(segments).sort(
    (a, b) =>
      TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.saturation - a.saturation,
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>
        {pick(
          language,
          `路段飽和度清單`,
          `Segment Saturation (${list.length})`,
        )}
      </div>
      <div className={styles.header}>
        <span />
        <span className={styles.headerCell}>{pick(language, "", "")}</span>
        <span className={styles.headerCell}>
          {pick(language, "飽和度", "Sat.")}
        </span>
        <span className={styles.headerCell}>
          {pick(language, "速度", "Speed")}
        </span>
        <span className={styles.headerCell}>
          {pick(language, "車輛數", "Vehicles")}
        </span>
      </div>
      <div className={styles.list}>
        {list.map((seg) => (
          <div
            key={seg.segmentId}
            className={`${styles.row} ${seg.segmentId === selectedSegmentId ? styles.selected : ""}`}
            role="button"
            tabIndex={0}
            aria-pressed={seg.segmentId === selectedSegmentId}
            onClick={() =>
              setSelectedSegment(
                seg.segmentId === selectedSegmentId ? null : seg.segmentId,
              )
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSelectedSegment(
                  seg.segmentId === selectedSegmentId ? null : seg.segmentId,
                );
              }
            }}
            title={pick(
              language,
              `車道狀態：${seg.laneStatus}`,
              `Lane status: ${seg.laneStatus}`,
            )}
          >
            <span className={`${styles.dot} ${styles[`dot${seg.tier}`]}`} />
            <span className={styles.name}>
              {seg.name}
              {seg.isCityTrigger && <span className={styles.starMark}>★</span>}
            </span>
            <span className={styles.sat}>{seg.saturation.toFixed(2)}</span>
            <span className={styles.speed}>{seg.avgSpeed}km/h</span>
            <span className={styles.vehicles}>
              {seg.vehicleCount.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

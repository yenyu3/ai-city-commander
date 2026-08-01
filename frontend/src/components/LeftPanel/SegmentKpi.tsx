import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./SegmentKpi.module.css";

export default function SegmentKpi() {
  const segments = useAppStore((s) => s.segments);
  const { language } = useLanguage();
  const list = Object.values(segments);

  const critCount = list.filter((s) => s.tier === "A").length;
  const warnCount = list.filter((s) => s.tier === "B").length;
  const avgSat =
    list.length > 0
      ? list.reduce((sum, s) => sum + s.saturation, 0) / list.length
      : 0;
  const worst = list.reduce<(typeof list)[0] | null>(
    (best, s) => (!best || s.saturation > best.saturation ? s : best),
    null,
  );

  return (
    <div className={styles.grid}>
      <div className={styles.card}>
        <span className={styles.label}>
          {pick(language, "A 級路段", "Tier A")}
        </span>
        <span className={`${styles.value} ${styles.crit}`}>
          {critCount}{" "}
          <span className={styles.unit}>{pick(language, "條", "seg")}</span>
        </span>
      </div>
      <div className={styles.card}>
        <span className={styles.label}>
          {pick(language, "B 級路段", "Tier B")}
        </span>
        <span className={`${styles.value} ${styles.warn}`}>
          {warnCount}{" "}
          <span className={styles.unit}>{pick(language, "條", "seg")}</span>
        </span>
      </div>
      <div className={styles.card}>
        <span className={styles.label}>
          {pick(language, "平均飽和度", "Avg Sat.")}
        </span>
        <span className={styles.value}>
          {avgSat.toFixed(2)} <span className={styles.unit}>/ 1</span>
        </span>
      </div>
      {/* <div className={`${styles.card} ${styles.wide}`}>
        <span className={styles.label}>{pick(language, "最壅塞路段", "Most congested")}</span>
        <span className={styles.value}>
          {worst ? `${worst.name}` : "—"}
          {worst && <span className={styles.unit}> · sat. {worst.saturation.toFixed(2)}</span>}
        </span>
      </div> */}
    </div>
  );
}

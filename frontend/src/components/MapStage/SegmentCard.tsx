import { pick, useLanguage } from "../../i18n";
import type { SegmentRuntimeState } from "../../store/appStore";
import styles from "./SegmentCard.module.css";

interface SegmentCardProps {
  segment: SegmentRuntimeState;
  onClose: () => void;
}

const TIER_LABEL: Record<string, { zh: string; en: string }> = {
  Normal: { zh: "正常", en: "Normal" },
  B: { zh: "B 級（壅擠）", en: "Tier B (congested)" },
  A: { zh: "A 級（癱瘓）", en: "Tier A (gridlocked)" },
};

export default function SegmentCard({ segment, onClose }: SegmentCardProps) {
  const { language } = useLanguage();
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.name}>{segment.name}</span>
        <button className={styles.close} onClick={onClose} aria-label={pick(language, "關閉", "Close")}>
          ×
        </button>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{pick(language, "分級", "Tier")}</span>
        <span className={`${styles.tierBadge} ${styles[`tier${segment.tier}`]}`}>
          {pick(language, TIER_LABEL[segment.tier].zh, TIER_LABEL[segment.tier].en)}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Saturation_Score</span>
        <span className={styles.mono}>{segment.saturation.toFixed(2)}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{pick(language, "平均速度", "Avg. Speed")}</span>
        <span className={styles.mono}>{segment.avgSpeed} km/h</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{pick(language, "車流量", "Vehicle Count")}</span>
        <span className={styles.mono}>{segment.vehicleCount}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{pick(language, "車道狀態", "Lane Status")}</span>
        <span className={styles.mono}>{segment.laneStatus}</span>
      </div>
      {segment.isCityTrigger && (
        <div className={styles.tag}>{pick(language, "城市應變觸發路段", "City-trigger segment")}</div>
      )}
      {segment.isEvacuationMain && (
        <div className={`${styles.tag} ${styles.tagMain}`}>{pick(language, "主疏散路徑", "Primary evacuation route")}</div>
      )}
      {segment.isEvacuationSecondary && (
        <div className={`${styles.tag} ${styles.tagSecondary}`}>{pick(language, "次要疏散路徑", "Secondary evacuation route")}</div>
      )}
      {segment.isIncidentSource && (
        <div className={`${styles.tag} ${styles.tagCrit}`}>{pick(language, "事故路段", "Incident segment")}</div>
      )}
    </div>
  );
}

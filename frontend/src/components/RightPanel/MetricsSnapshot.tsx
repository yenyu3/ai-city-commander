import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { TIER_THRESHOLDS } from "../../engine/congestionTier";
import { SOP_SECTIONS } from "../../services/sopRetrieval";
import styles from "./MetricsSnapshot.module.css";

function sopTitles(sopRef?: string): string {
  if (!sopRef) return "";
  const ids = [...sopRef.matchAll(/§(\d+)/g)].map((m) => m[1]);
  const titles = ids
    .map((id) => SOP_SECTIONS.find((s) => s.id === id)?.title)
    .filter((t): t is string => Boolean(t));
  return titles.join("、");
}

export default function MetricsSnapshot() {
  const alerts = useAppStore((s) => s.alerts);
  const { language } = useLanguage();
  const latest = alerts[0];

  if (!latest) return null;

  const metrics = latest.segmentMetrics;

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>{pick(language, "數據依據", "Key Metrics")}</div>
      {!metrics ? (
        <div className={styles.empty}>
          {pick(language, "此事件類型無路段流量資料", "No segment flow data for this event type")}
        </div>
      ) : (
        <div className={styles.grid}>
          <div className={styles.tile}>
            <span className={styles.label}>{pick(language, "即時車流量", "Live flow")}</span>
            <strong>{metrics.flowPcuh.toLocaleString()}</strong>
            <span className={styles.unit}>pcu/h</span>
          </div>
          <div className={styles.tile}>
            <span className={styles.label}>{pick(language, "道路飽和度 (V/C)", "Saturation (V/C)")}</span>
            <strong
              className={
                metrics.saturation >= TIER_THRESHOLDS.A
                  ? styles.crit
                  : metrics.saturation >= TIER_THRESHOLDS.B
                    ? styles.warn
                    : undefined
              }
            >
              {metrics.saturation.toFixed(2)}
            </strong>
            <span className={styles.unit}>
              {pick(language, `A 級門檻 ≥ ${TIER_THRESHOLDS.A}`, `Tier A threshold ≥ ${TIER_THRESHOLDS.A}`)}
            </span>
          </div>
          <div className={styles.tile}>
            <span className={styles.label}>{pick(language, "觸發依據 SOP", "Triggering SOP")}</span>
            <strong>{latest.sopRef ?? "—"}</strong>
            <span className={styles.unit}>{sopTitles(latest.sopRef)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

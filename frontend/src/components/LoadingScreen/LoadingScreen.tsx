import { Activity, RadioTower } from "lucide-react";
import { pick, useLanguage } from "../../i18n";
import styles from "./LoadingScreen.module.css";

interface LoadingScreenProps {
  error?: string | null;
}

export default function LoadingScreen({ error }: LoadingScreenProps) {
  const { language } = useLanguage();

  return (
    <div className={styles.screen} role="status" aria-live="polite">
      <div className={styles.grid} aria-hidden="true" />
      <div className={styles.inner}>
        <div className={styles.mark}>
          <div className={styles.ring} />
          <div className={styles.pulse} />
          <div className={styles.core}>
            {error ? <Activity size={30} aria-hidden="true" /> : <RadioTower size={30} aria-hidden="true" />}
          </div>
        </div>

        <div className={styles.copy}>
          <p className={styles.eyebrow}>AI City Commander</p>
          <h1>
            {error
              ? pick(language, "資料載入失敗", "Failed to load data")
              : pick(language, "正在同步城市態勢", "Synchronizing city signals")}
          </h1>
          <p className={styles.message}>
            {error ??
              pick(
                language,
                "正在載入道路、人流、事件與 SOP 推理資料。",
                "Loading roads, crowd signals, incidents, and SOP reasoning.",
              )}
          </p>
        </div>

        {!error && (
          <div className={styles.telemetry} aria-hidden="true">
            <span>{pick(language, "道路", "Roads")}</span>
            <i />
            <span>{pick(language, "人流", "Crowd")}</span>
            <i />
            <span>{pick(language, "AI 推理", "AI Reasoning")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

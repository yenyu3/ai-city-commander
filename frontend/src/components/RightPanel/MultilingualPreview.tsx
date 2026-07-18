import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { checkMultilingualNeeded } from "../../engine/multilingualCheck";
import { calcETE } from "../../engine/ete";
import { llmAdapter } from "../../services/llmAdapter";
import { pick, useLanguage } from "../../i18n";
import styles from "./MultilingualPreview.module.css";

const LANGS: { code: "zh" | "en" | "ja" | "ko"; label: string }[] = [
  { code: "zh", label: "中文" },
  { code: "en", label: "EN" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
];

export default function MultilingualPreview() {
  const stations = useAppStore((s) => s.stations);
  const currentTime = useAppStore((s) => s.currentTime);
  const triggered = checkMultilingualNeeded(
    Object.values(stations).map((st) => ({
      timestamp: currentTime,
      stationId: st.stationId,
      locationName: st.name,
      userCount: st.userCount,
      stayTimeAvg: st.stayTimeAvg,
      growthRate: st.growthRate,
      roamingPct: st.roamingPct,
    })),
  );

  const [activeStation, setActiveStation] = useState<string | null>(null);
  const [activeLang, setActiveLang] = useState<"zh" | "en" | "ja" | "ko">("zh");
  const [toast, setToast] = useState<string | null>(null);
  const { language } = useLanguage();

  if (triggered.length === 0) {
    return (
      <div className={styles.wrap}>
        <div className={styles.title}>{pick(language, "多語告警預覽", "Multilingual Alert Preview")}</div>
        <div className={styles.empty}>
          {pick(language, "目前尚無站點漫遊比例達 30% 門檻", "No station has yet reached the 30% roaming threshold")}
        </div>
      </div>
    );
  }

  const current = activeStation
    ? triggered.find((t) => t.stationId === activeStation) ?? triggered[0]
    : triggered[0];

  const { ete } = calcETE("Medium", 0.7);
  const messages = llmAdapter.generateMultilingual("congestion", {
    location: current.locationName,
    ete: String(ete),
  });

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>{pick(language, "多語告警預覽", "Multilingual Alert Preview")}</div>
      <div className={styles.stationTabs}>
        {triggered.map((st) => (
          <button
            key={st.stationId}
            className={`${styles.stationTab} ${current.stationId === st.stationId ? styles.stationActive : ""}`}
            onClick={() => setActiveStation(st.stationId)}
          >
            {st.locationName}
          </button>
        ))}
      </div>
      <div className={styles.meta}>
        {pick(language, "漫遊比例", "Roaming share")}: {(current.roamingPct * 100).toFixed(0)}%
      </div>
      <div className={styles.langTabs}>
        {LANGS.map((l) => (
          <button
            key={l.code}
            className={`${styles.langTab} ${activeLang === l.code ? styles.langActive : ""}`}
            onClick={() => setActiveLang(l.code)}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className={styles.messageBox}>{messages[activeLang]}</div>
      <button
        className={styles.publishBtn}
        onClick={() => {
          setToast(pick(language, "已發布（模擬）", "Published (simulated)"));
          setTimeout(() => setToast(null), 1800);
        }}
      >
        📢 {pick(language, "一鍵發布", "Publish")}
      </button>
      {toast && <div className={styles.toast}>{toast}</div>}
    </div>
  );
}

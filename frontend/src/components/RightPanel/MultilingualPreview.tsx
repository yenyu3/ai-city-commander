import { useState } from "react";
import { Check, Plus } from "lucide-react";
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
  const [selectedLangs, setSelectedLangs] = useState<Set<"zh" | "en" | "ja" | "ko">>(
    () => new Set(LANGS.map((lang) => lang.code)),
  );
  const { language } = useLanguage();

  if (triggered.length === 0) {
    return (
      <div className={styles.wrap}>
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
  const selectedCount = selectedLangs.size;

  function toggleLang(code: "zh" | "en" | "ja" | "ko") {
    setSelectedLangs((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.stationRow}>
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

      <div className={styles.statusLine}>
        <div className={styles.statusMetrics}>
          <span>{pick(language, "漫遊比例", "Roaming share")}</span>
          <strong>{(current.roamingPct * 100).toFixed(0)}%</strong>
          <span>{pick(language, "已選語言", "Selected")}</span>
          <strong>{selectedCount}/{LANGS.length}</strong>
        </div>
      </div>

      <div className={styles.languageGrid} aria-label={pick(language, "選擇發布語言", "Select publish languages")}>
        {LANGS.map((l) => (
          <label
            key={l.code}
            className={`${styles.languageOption} ${selectedLangs.has(l.code) ? styles.languageSelected : ""}`}
          >
            <input
              type="checkbox"
              checked={selectedLangs.has(l.code)}
              onChange={() => toggleLang(l.code)}
            />
            <span className={styles.checkMark}>
              {selectedLangs.has(l.code) ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <Plus size={12} aria-hidden="true" />
              )}
            </span>
            {l.label}
          </label>
        ))}
      </div>

      <section className={styles.noticeBlock}>
        <div className={styles.noticeHeader}>
          <span>{pick(language, "發布通知", "Publish Notice")}</span>
          <strong>{current.locationName}</strong>
        </div>
        {LANGS.filter((l) => selectedLangs.has(l.code)).map((l) => (
          <div key={l.code} className={styles.noticeRow}>
            <span>{l.label}</span>
            <p>{messages[l.code]}</p>
          </div>
        ))}
        {selectedCount === 0 && (
          <div className={styles.noSelection}>
            {pick(language, "請至少選擇一種發布語言", "Select at least one language to publish")}
          </div>
        )}
      </section>

      {/* toast slot reserved */}
    </div>
  );
}
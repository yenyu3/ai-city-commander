import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, Send, X } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { checkMultilingualNeeded } from "../../engine/multilingualCheck";
import { calcETE } from "../../engine/ete";
import { llmAdapter } from "../../services/llmAdapter";
import { pick, useLanguage } from "../../i18n";
import styles from "./PublishPreviewModal.module.css";

const LANGS: { code: "zh" | "en" | "ja" | "ko"; label: string }[] = [
  { code: "zh", label: "中文" },
  { code: "en", label: "EN" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
];

type PublishState = "idle" | "loading" | "success" | "error";

interface Props {
  onClose: () => void;
  onPublished: (alertId: string) => void;
  alertId: string;
}

export default function PublishPreviewModal({ onClose, onPublished, alertId }: Props) {
  const stations = useAppStore((s) => s.stations);
  const currentTime = useAppStore((s) => s.currentTime);
  const { language } = useLanguage();

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
    () => new Set(LANGS.map((l) => l.code)),
  );
  const [publishState, setPublishState] = useState<PublishState>("idle");
  const backdropRef = useRef<HTMLDivElement>(null);

  const current = activeStation
    ? triggered.find((t) => t.stationId === activeStation) ?? triggered[0]
    : triggered[0];

  // 沒有路段飽和度可用（多語通報是人流事件，非車流事件），改以漫遊比例換算出一個
  // 與該站點實際觸發數據連動的預估值，而非對每個站點都給同一個固定 ETE。
  const messages = current
    ? llmAdapter.generateMultilingual("congestion", {
        location: current.locationName,
        ete: String(calcETE("Medium", 0.5 + current.roamingPct).ete),
      })
    : null;

  const selectedCount = selectedLangs.size;

  // close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && publishState === "idle") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, publishState]);

  function toggleLang(code: "zh" | "en" | "ja" | "ko") {
    setSelectedLangs((prev) => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  }

  async function handlePublish() {
    if (selectedCount === 0 || publishState !== "idle") return;
    setPublishState("loading");
    try {
      // 模擬 API 呼叫（實際接入時替換此處）
      await new Promise<void>((resolve) => setTimeout(resolve, 1200));
      setPublishState("success");
      onPublished(alertId);
      setTimeout(onClose, 1600);
    } catch {
      setPublishState("error");
      setTimeout(() => setPublishState("idle"), 2500);
    }
  }

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === backdropRef.current && publishState === "idle") onClose();
  }

  const toastContent =
    publishState === "loading"
      ? pick(language, "發布中…", "Publishing…")
      : publishState === "success"
        ? pick(language, `已發布 ${selectedCount} 種語言`, `Published ${selectedCount} languages`)
        : publishState === "error"
          ? pick(language, "發布失敗，請稍後再試", "Publish failed, please try again")
          : null;

  return (
    <div className={styles.backdrop} ref={backdropRef} onClick={handleBackdropClick} role="dialog" aria-modal="true">
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.modalHeader}>
          <div className={styles.headerLeft}>
            <span className={styles.modalTitle}>
              {pick(language, "多語警示預覽", "Multilingual Alert Preview")}
            </span>
            {current && (
              <div className={styles.metaChips}>
                <span className={styles.chip}>
                  {pick(language, "漫遊比例", "Roaming")}
                  <strong>{(current.roamingPct * 100).toFixed(0)}%</strong>
                </span>
                <span className={styles.chip}>
                  {pick(language, "已選語言", "Languages")}
                  <strong>{selectedCount}/{LANGS.length}</strong>
                </span>
              </div>
            )}
          </div>
          <button
            className={styles.closeBtn}
            onClick={onClose}
            disabled={publishState === "loading"}
            aria-label={pick(language, "關閉", "Close")}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className={styles.modalBody}>
          {triggered.length > 1 && (
            <div className={styles.stationRow}>
              {triggered.map((st) => (
                <button
                  key={st.stationId}
                  className={`${styles.stationTab} ${current?.stationId === st.stationId ? styles.stationActive : ""}`}
                  onClick={() => setActiveStation(st.stationId)}
                >
                  {st.locationName}
                </button>
              ))}
            </div>
          )}

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

          {current && messages && (
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
          )}
        </div>

        {/* Footer */}
        <div className={styles.modalFooter}>
          <button
            className={styles.cancelBtn}
            onClick={onClose}
            disabled={publishState === "loading"}
          >
            {pick(language, "取消", "Cancel")}
          </button>
          <button
            className={`${styles.confirmBtn} ${publishState === "success" ? styles.confirmSuccess : ""} ${publishState === "error" ? styles.confirmError : ""}`}
            disabled={selectedCount === 0 || publishState !== "idle"}
            onClick={handlePublish}
          >
            {publishState === "loading" ? (
              <Loader2 size={14} className={styles.spinIcon} aria-hidden="true" />
            ) : (
              <Send size={14} aria-hidden="true" />
            )}
            {publishState === "loading"
              ? pick(language, "發布中…", "Publishing…")
              : publishState === "success"
                ? pick(language, "已發布", "Published")
                : publishState === "error"
                  ? pick(language, "發布失敗", "Failed")
                  : pick(language, "確認發布", "Confirm Publish")}
          </button>
        </div>

        {toastContent && (
          <div
            className={`${styles.toast} ${publishState === "error" ? styles.toastError : publishState === "success" ? styles.toastSuccess : ""}`}
            role="status"
          >
            {toastContent}
          </div>
        )}
      </div>
    </div>
  );
}

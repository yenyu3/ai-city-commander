import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import type { AlertRecord } from "../../types";
import { ALERT_KIND_LABEL } from "../../utils/alertLabels";
import { getPublicAlertText } from "../../utils/publicView";
import styles from "./AlertOverlay.module.css";

export default function AlertOverlay() {
  const alerts = useAppStore((s) => s.alerts);
  const displayedAlertIds = useAppStore((s) => s.displayedAlertIds);
  const viewerMode = useAppStore((s) => s.viewerMode);
  const { language } = useLanguage();
  const [toastIds, setToastIds] = useState<string[]>([]);
  const seen = useRef(new Set<string>());
  const overlayRef = useRef<HTMLDivElement>(null);

  // Gated on `displayedAlertIds` (not `alerts` directly) so this toast surfaces in step
  // with the timeline marker/playhead during playback instead of the instant the rule
  // engine decided the alert, a tick early — see pushAlert in appStore.ts.
  useEffect(() => {
    // `alerts` is newest-first (see pushAlert); reverse so a batch that becomes
    // visible in the same tick is appended oldest-first, matching toastIds' order.
    const newlyVisible = alerts.filter((a) => displayedAlertIds.has(a.id) && !seen.current.has(a.id)).reverse();
    if (newlyVisible.length === 0) return;
    newlyVisible.forEach((a) => seen.current.add(a.id));
    setToastIds((ids) => [...ids, ...newlyVisible.map((a) => a.id)]);
  }, [alerts, displayedAlertIds]);

  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    // Align to the top of the newest card rather than the bottom of the panel —
    // scrolling to scrollHeight clips a tall card's title/head off the top when
    // it overflows the fixed-height viewport.
    const last = el.lastElementChild as HTMLElement | null;
    el.scrollTop = last ? last.offsetTop : el.scrollHeight;
  }, [toastIds]);

  const toasts = toastIds
    .map((id) => alerts.find((a) => a.id === id))
    .filter((a): a is AlertRecord => Boolean(a));

  if (toasts.length === 0) return null;

  return (
    <div className={styles.overlay} ref={overlayRef}>
      {toasts.map((alert) => (
        <div key={alert.id} className={styles.card}>
          <div className={styles.head}>
            <span className={styles.kind}>{pick(language, ALERT_KIND_LABEL[alert.kind].zh, ALERT_KIND_LABEL[alert.kind].en)}</span>
            <button
              className={styles.dismiss}
              onClick={() => setToastIds((ids) => ids.filter((id) => id !== alert.id))}
            >
              ×
            </button>
          </div>
          {viewerMode === "public" ? (
            <div className={styles.llm}>{getPublicAlertText(alert, language)}</div>
          ) : (
            <>
              <div className={styles.title}>{alert.title}</div>
              <div className={styles.rule}>{alert.ruleSummary}</div>
              {alert.llmText ? (
                <div className={styles.llm}>{alert.llmText}</div>
              ) : (
                <div className={styles.llmLoading}>
                  <span className={styles.spinner} aria-hidden="true" />
                  {pick(language, "AI 摘要生成中…", "Generating AI summary…")}
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

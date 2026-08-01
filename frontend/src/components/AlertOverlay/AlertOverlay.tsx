import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { ALERT_KIND_LABEL } from "../../utils/alertLabels";
import { getPublicAlertText } from "../../utils/publicView";
import styles from "./AlertOverlay.module.css";

export default function AlertOverlay() {
  const alerts = useAppStore((s) => s.alerts);
  const activeAlertId = useAppStore((s) => s.activeAlertId);
  const displayedAlertIds = useAppStore((s) => s.displayedAlertIds);
  const viewerMode = useAppStore((s) => s.viewerMode);
  const { language } = useLanguage();
  // null  = show the active alert toast
  // string = user dismissed this alert id, hide until activeAlertId changes
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // When activeAlertId changes to a new alert, reset the dismissed state so the
  // new toast surfaces automatically.
  useEffect(() => {
    setDismissedId(null);
  }, [activeAlertId]);

  const alert = activeAlertId
    ? alerts.find((a) => a.id === activeAlertId)
    : null;

  // Only show if the alert has been surfaced via displayedAlertIds (i.e. playback
  // reached its timestamp) and the user hasn't dismissed it.
  const visible = Boolean(
    alert && displayedAlertIds.has(alert.id) && dismissedId !== alert.id,
  );

  if (!visible || !alert) return null;

  return (
    <div className={styles.overlay} ref={overlayRef}>
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.kind}>
            {pick(language, ALERT_KIND_LABEL[alert.kind].zh, ALERT_KIND_LABEL[alert.kind].en)}
          </span>
          <button
            className={styles.dismiss}
            onClick={() => setDismissedId(alert.id)}
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
    </div>
  );
}

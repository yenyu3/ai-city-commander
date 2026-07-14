import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import type { AlertRecord } from "../../types";
import { ALERT_KIND_LABEL } from "../../utils/alertLabels";
import styles from "./AlertOverlay.module.css";

const DISPLAY_MS = 9000;

export default function AlertOverlay() {
  const alerts = useAppStore((s) => s.alerts);
  const { language } = useLanguage();
  const [toastIds, setToastIds] = useState<string[]>([]);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (alerts.length === 0) return;
    const newest = alerts[0];
    if (!seen.current.has(newest.id)) {
      seen.current.add(newest.id);
      setToastIds((ids) => [newest.id, ...ids]);
      const timer = setTimeout(() => {
        setToastIds((ids) => ids.filter((id) => id !== newest.id));
      }, DISPLAY_MS);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts.length]);

  const toasts = toastIds
    .map((id) => alerts.find((a) => a.id === id))
    .filter((a): a is AlertRecord => Boolean(a));

  if (toasts.length === 0) return null;

  return (
    <div className={styles.overlay}>
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
          <div className={styles.title}>{alert.title}</div>
          <div className={styles.rule}>{alert.ruleSummary}</div>
          {alert.llmText ? (
            <div className={styles.llm}>{alert.llmText}</div>
          ) : (
            <div className={styles.llmLoading}>{pick(language, "AI 摘要生成中…", "Generating AI summary…")}</div>
          )}
        </div>
      ))}
    </div>
  );
}

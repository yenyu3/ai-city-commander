import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./ReasoningChain.module.css";

const STATUS_ICON: Record<string, string> = {
  pass: "✓",
  fail: "✕",
  final: "★",
  info: "ℹ",
};

export default function ReasoningChain() {
  const reasoningLog = useAppStore((s) => s.reasoningLog);
  const { language } = useLanguage();

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>{pick(language, "推理鏈", "Reasoning Chain")}</div>
      {reasoningLog.length === 0 ? (
        <div className={styles.empty}>
          {pick(
            language,
            "尚無事件觸發，注入事故或等待壅塞門檻觸發後將顯示推理步驟",
            "No event triggered yet. Inject an incident or wait for a congestion threshold to see reasoning steps.",
          )}
        </div>
      ) : (
        <ol className={styles.steps}>
          {reasoningLog
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((step) => (
              <li key={step.order} className={styles.step}>
                <span className={`${styles.icon} ${styles[`icon_${step.status}`]}`}>
                  {STATUS_ICON[step.status]}
                </span>
                <div className={styles.body}>
                  <div className={styles.stepTitle}>{step.title}</div>
                  <div className={styles.stepDetail}>{step.detail}</div>
                  {step.sopRef && <div className={styles.sopRef}>{step.sopRef}</div>}
                </div>
              </li>
            ))}
        </ol>
      )}
    </div>
  );
}

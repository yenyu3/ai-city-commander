import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
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
  const [expanded, setExpanded] = useState(false);

  const sorted = reasoningLog.slice().sort((a, b) => a.order - b.order);
  const finalStep = sorted.find((s) => s.status === "final");
  const otherSteps = sorted.filter((s) => s !== finalStep);

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>{pick(language, "推理鏈", "Reasoning Chain")}</div>
      {sorted.length === 0 ? (
        <div className={styles.empty}>
          {pick(
            language,
            "尚無事件觸發，注入事故或等待壅塞門檻觸發後將顯示推理步驟",
            "No event triggered yet. Inject an incident or wait for a congestion threshold to see reasoning steps.",
          )}
        </div>
      ) : (
        <>
          {finalStep && (
            <div className={styles.conclusion}>
              <span className={`${styles.icon} ${styles.icon_final}`}>{STATUS_ICON.final}</span>
              <div className={styles.body}>
                <div className={styles.stepTitle}>{finalStep.title}</div>
                <div className={styles.stepDetail}>{finalStep.detail}</div>
                {finalStep.sopRef && <div className={styles.sopRef}>{finalStep.sopRef}</div>}
              </div>
            </div>
          )}

          {otherSteps.length > 0 && (
            <button
              type="button"
              className={styles.toggle}
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {expanded
                ? pick(language, "收合推理步驟", "Collapse steps")
                : pick(language, `查看完整推理過程（${otherSteps.length} 步）`, `View full reasoning (${otherSteps.length} steps)`)}
            </button>
          )}

          {expanded && (
            <ol className={styles.steps}>
              {otherSteps.map((step) => (
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
        </>
      )}
    </div>
  );
}

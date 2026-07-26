import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./ReasoningChain.module.css";

const DEFAULT_VISIBLE_STEPS = 3;

export default function ReasoningChain() {
  const reasoningLog = useAppStore((s) => s.reasoningLog);
  const { language } = useLanguage();
  const [expanded, setExpanded] = useState(false);

  const sorted = reasoningLog.slice().sort((a, b) => a.order - b.order);
  const finalStep = sorted.find((s) => s.status === "final");
  const otherSteps = sorted.filter((s) => s !== finalStep);
  const visibleSteps = expanded ? otherSteps : otherSteps.slice(0, DEFAULT_VISIBLE_STEPS);
  const hiddenCount = Math.max(0, otherSteps.length - visibleSteps.length);
  const statusLabel = (status: string) => {
    if (status === "pass") return pick(language, "通過", "Pass");
    if (status === "fail") return pick(language, "排除", "Excluded");
    if (status === "final") return pick(language, "結論", "Final");
    return pick(language, "檢核", "Check");
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div className={styles.title}>{pick(language, "推理步驟", "Reasoning Steps")}</div>
        {otherSteps.length > 0 && <span className={styles.count}>{otherSteps.length}</span>}
      </div>
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
              <span className={styles.conclusionLabel}>{pick(language, "決策結論", "Decision")}</span>
              <div className={styles.body}>
                <div className={styles.stepTitle}>{finalStep.title}</div>
                <div className={styles.stepDetail}>{finalStep.detail}</div>
                {finalStep.sopRef && <div className={styles.sopRef}>{finalStep.sopRef}</div>}
              </div>
            </div>
          )}

          {otherSteps.length > 0 && (
            <ol className={styles.steps}>
              {visibleSteps.map((step, index) => (
                <li key={step.order} className={styles.step}>
                  <span className={`${styles.number} ${styles[`number_${step.status}`]}`}>
                    {index + 1}
                  </span>
                  <div className={styles.body}>
                    <div className={styles.stepHead}>
                      <div className={styles.stepTitle}>{step.title}</div>
                      <span className={`${styles.status} ${styles[`status_${step.status}`]}`}>
                        {statusLabel(step.status)}
                      </span>
                    </div>
                    <div className={styles.stepDetail}>{step.detail}</div>
                    {step.sopRef && <div className={styles.sopRef}>{step.sopRef}</div>}
                  </div>
                </li>
              ))}
            </ol>
          )}

          {otherSteps.length > DEFAULT_VISIBLE_STEPS && (
            <button
              type="button"
              className={styles.toggle}
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {expanded
                ? pick(language, "收合推理步驟", "Collapse steps")
                : pick(language, `展開其餘 ${hiddenCount} 步`, `Show ${hiddenCount} more steps`)}
            </button>
          )}
        </>
      )}
    </div>
  );
}

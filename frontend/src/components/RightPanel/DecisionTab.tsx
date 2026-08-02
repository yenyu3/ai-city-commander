import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FileText } from "lucide-react";
import { pick, useLanguage } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import DecisionSummary from "./DecisionSummary";
import styles from "./DecisionTab.module.css";
import ETEBreakdownCard from "./ETEBreakdownCard";
import MetricsSnapshot from "./MetricsSnapshot";
import ReasoningChain from "./ReasoningChain";
import RerouteSection from "./RerouteSection";
import SignalCoordinationSection from "./SignalCoordinationSection";
import SituationOverview from "./SituationOverview";

const SUMMARY_VALUE = "__summary__";

interface DecisionOption {
  value: string;
  title: string;
}

function DecisionSelector({
  options,
  value,
  onChange,
  label,
}: {
  options: DecisionOption[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const activeOption = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!activeOption) return null;

  return (
    <div className={styles.selectorWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.selectorTrigger} ${open ? styles.selectorTriggerOpen : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.selectorIcon}>
          <FileText size={15} aria-hidden="true" />
        </span>
        <span className={styles.selectorText}>
          <span className={styles.selectorTitle}>{activeOption.title}</span>
        </span>
        <ChevronDown
          size={16}
          className={`${styles.selectorChevron} ${open ? styles.selectorChevronOpen : ""}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className={styles.selectorMenu} role="listbox" aria-label={label}>
          {options.map((option) => {
            const selectedOption = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                className={`${styles.selectorOption} ${selectedOption ? styles.selectorOptionSelected : ""}`}
                role="option"
                aria-selected={selectedOption}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className={styles.optionMain}>
                  <span className={styles.optionTitle}>{option.title}</span>
                </span>
                {selectedOption && (
                  <Check size={15} className={styles.optionCheck} aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function DecisionTab() {
  const { language } = useLanguage();
  const alerts = useAppStore((s) => s.alerts);
  const activeAlertId = useAppStore((s) => s.activeAlertId);
  const incidentGovernmentSummary = useAppStore((s) => s.incidentGovernmentSummary);
  const governmentSummary = useAppStore((s) => s.governmentSummary);
  const hasSummary = !!(incidentGovernmentSummary ?? governmentSummary);

  const [selected, setSelected] = useState<string>(SUMMARY_VALUE);
  const effectiveSelected = hasSummary ? selected : (activeAlertId ?? alerts[0]?.id ?? "");
  const showSummary = effectiveSelected === SUMMARY_VALUE && hasSummary;
  const selectorOptions = useMemo<DecisionOption[]>(() => {
    const summaryOptions: DecisionOption[] = hasSummary
      ? [{
          value: SUMMARY_VALUE,
          title: pick(language, "綜合摘要", "Summary"),
        }]
      : [];

    return [
      ...summaryOptions,
      ...alerts.map((alert) => ({
        value: alert.id,
        title: alert.title,
      })),
    ];
  }, [alerts, hasSummary, language]);

  const handleChange = (value: string) => {
    setSelected(value);
    if (value !== SUMMARY_VALUE) {
      useAppStore.setState({ activeAlertId: value });
    }
  };

  return (
    <div className={styles.wrap}>
      {(hasSummary || alerts.length > 0) && (
        <DecisionSelector
          options={selectorOptions}
          value={effectiveSelected}
          onChange={handleChange}
          label={pick(language, "選擇決策項目", "Select decision")}
        />
      )}

      {!showSummary && <SituationOverview />}
      <DecisionSummary showSummary={showSummary} />

      {!showSummary && (
        <>
          <ETEBreakdownCard />
          <section id="decision-reasoning" className={styles.section}>
            <MetricsSnapshot />
            <ReasoningChain />
          </section>
          <section id="decision-reroute" className={styles.section}>
            <RerouteSection />
          </section>
          <section id="decision-signals" className={styles.section}>
            <SignalCoordinationSection />
          </section>
        </>
      )}
    </div>
  );
}

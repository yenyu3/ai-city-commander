import { useState } from "react";
import { ChevronDown, Clock3, Send } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { checkMultilingualNeeded } from "../../engine/multilingualCheck";
import { pick, useLanguage } from "../../i18n";
import { ALERT_KIND_LABEL } from "../../utils/alertLabels";
import { formatDisplayTimestamp } from "../../utils/timeUtils";
import FieldPositionHint from "../common/FieldPositionHint";
import PublishPreviewModal from "./PublishPreviewModal";
import styles from "./DecisionSummary.module.css";

function scrollToAnchor(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

function getPrimaryMetric(
  latest: {
    kind: string;
    title: string;
    ruleSummary: string;
    ete?: number;
  },
  language: "zh" | "en",
  kindLabel: string,
): { value: string; label: string } {
  if (latest.ete !== undefined) {
    return {
      value: String(latest.ete),
      label: pick(language, "分鐘後預估恢復通行", "min estimated until traffic recovers"),
    };
  }

  const tier = latest.title.match(/([AB])\s*級/)?.[1] ?? latest.ruleSummary.match(/[→=]\s*([AB])\s*級/)?.[1];
  if (tier) {
    return {
      value: `${tier}${pick(language, "級", "")}`,
      label: pick(language, "目前壅塞分級", "current congestion tier"),
    };
  }

  const roamingPct = latest.ruleSummary.match(/Roaming_User_Pct=(\d+)%/)?.[1];
  if (roamingPct) {
    return {
      value: `${roamingPct}%`,
      label: pick(language, "漫遊用戶占比", "roaming user share"),
    };
  }

  const userCount = latest.ruleSummary.match(/User_Count=([\d,]+)/)?.[1];
  if (userCount) {
    return {
      value: userCount,
      label: pick(language, "站點人流", "station crowd"),
    };
  }

  if (latest.kind === "signal_failure") {
    return {
      value: pick(language, "中斷", "Down"),
      label: pick(language, "號誌狀態", "signal status"),
    };
  }

  return {
    value: kindLabel,
    label: pick(language, "事件類型", "event type"),
  };
}

export default function DecisionSummary() {
  const alerts = useAppStore((s) => s.alerts);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const stations = useAppStore((s) => s.stations);
  const currentTime = useAppStore((s) => s.currentTime);
  const { language } = useLanguage();
  const latest = alerts[0];
  const [modalOpen, setModalOpen] = useState(false);

  const multilingualTriggered = checkMultilingualNeeded(
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
  const [publishedAlertIds, setPublishedAlertIds] = useState<Set<string>>(() => new Set());
  // canPublish 以卡片當前事件 id 為 key：事件換了就重新判斷，發布過的同一事件不重複發
  const canPublish = multilingualTriggered.length > 0 && !publishedAlertIds.has(latest?.id ?? "");

  if (!latest) {
    return (
      <div className={styles.wrap}>
        <div className={styles.title}>{pick(language, "事件摘要", "Event Summary")}</div>
        <FieldPositionHint />
        <div className={styles.empty}>
          {pick(language, "城市監控中，尚無事件需要處理", "Monitoring the city — no incident requires action yet")}
        </div>
      </div>
    );
  }

  const actionItems = latest.actions;
  const kindLabel = pick(language, ALERT_KIND_LABEL[latest.kind].zh, ALERT_KIND_LABEL[latest.kind].en);
  const primaryMetric = getPrimaryMetric(latest, language, kindLabel);

  return (
    <>
    <div className={styles.wrap}>
      <div className={styles.summaryCard}>
        <div className={styles.cardHeaderRow}>
          <span className={styles.title}>{pick(language, "決策摘要", "Decision Summary")}</span>
          <button
            className={styles.publishTriggerBtn}
            disabled={!canPublish}
            onClick={() => setModalOpen(true)}
            title={pick(language, "發布多語警示", "Publish multilingual alert")}
            aria-label={pick(language, "發布多語警示", "Publish multilingual alert")}
          >
            <Send size={13} aria-hidden="true" />
            {pick(language, "發布警示", "Publish Alert")}
          </button>
        </div>
        <FieldPositionHint />
        <div className={styles.cardHead}>
          <span className={styles.eventTitle}>{latest.title}</span>
        </div>
        <div className={styles.metaRow}>
          <span className={styles.eventTime}>
            <Clock3 size={14} aria-hidden="true" />
            {formatDisplayTimestamp(latest.timestamp, timeOffsetMs)}
          </span>
          <span className={styles.kind}>{kindLabel}</span>
        </div>
        <div className={styles.primaryMetric}>
          <strong>{primaryMetric.value}</strong>
          <span>{primaryMetric.label}</span>
        </div>
        <div className={styles.summaryBlock}>
          {latest.llmText ? (
            <p className={styles.summaryText}>{latest.llmText}</p>
          ) : (
            <p className={styles.aiLoading}>
              <span className={styles.spinner} aria-hidden="true" />
              {pick(language, "AI 摘要生成中…", "Generating AI summary…")}
            </p>
          )}
        </div>
        <div className={styles.navLinks}>
          <a href="#decision-actions" className={styles.navLink} onClick={(e) => scrollToAnchor(e, "decision-actions")}>
            <span>{pick(language, "建議行動", "Actions")}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </a>
          <a href="#decision-reasoning" className={styles.navLink} onClick={(e) => scrollToAnchor(e, "decision-reasoning")}>
            <span>{pick(language, "推理與數據依據", "Reasoning & metrics")}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </a>
          <a href="#decision-reroute" className={styles.navLink} onClick={(e) => scrollToAnchor(e, "decision-reroute")}>
            <span>{pick(language, "替代路徑", "Rerouting")}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </a>
          <a href="#decision-signals" className={styles.navLink} onClick={(e) => scrollToAnchor(e, "decision-signals")}>
            <span>{pick(language, "號誌聯動", "Coordination")}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </a>
          <a href="#decision-multilingual" className={styles.navLink} onClick={(e) => scrollToAnchor(e, "decision-multilingual")}>
            <span>{pick(language, "多語警示", "Multilingual")}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </a>
        </div>
      </div>

      <div id="decision-actions" className={styles.actionsBlock}>
        <span className={styles.actionsLabel}>{pick(language, "建議行動", "Recommended Actions")}</span>
        <ol className={styles.actionList}>
          {actionItems.map((item, index) => (
            <li key={item} className={styles.actionItem}>
              <span className={styles.actionNumber}>{index + 1}</span>
              <p>{item}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
    {modalOpen && (
      <PublishPreviewModal
        onClose={() => setModalOpen(false)}
        onPublished={(alertId) => {
          setPublishedAlertIds((prev) => new Set(prev).add(alertId));
          setModalOpen(false);
        }}
        alertId={latest.id}
      />
    )}
    </>
  );
}

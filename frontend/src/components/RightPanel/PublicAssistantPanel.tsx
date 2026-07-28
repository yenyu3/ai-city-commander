import { MessageCircle, Route } from "lucide-react";
import { useMemo } from "react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import CollapsibleSection from "../common/CollapsibleSection";
import ChatPanel from "./ChatPanel";
import styles from "./PublicAssistantPanel.module.css";

/** 常見問題：點擊後直接送進下方的 AI 對話框 */
const SUGGESTED_QUESTIONS: { zh: string; en: string }[] = [
  { zh: "我要去小巨蛋，現在適合嗎？", en: "Is it okay to go to Taipei Arena now?" },
  { zh: "哪幾個區域建議避開？", en: "Which areas should I avoid?" },
  { zh: "現在哪個車站人潮最多？", en: "Which station is the most crowded now?" },
  { zh: "請幫我產生英文旅客提醒。", en: "Create an English visitor notice." },
];

export default function PublicAssistantPanel() {
  const { language } = useLanguage();
  const segments = useAppStore((s) => s.segments);
  const stations = useAppStore((s) => s.stations);
  const activeIncidents = useAppStore((s) => s.activeIncidents);
  const sendChatMessage = useAppStore((s) => s.sendChatMessage);

  const mostAffectedRoad = useMemo(
    () =>
      Object.values(segments)
        .filter((segment) => segment.tier !== "Normal" || segment.isIncidentSource)
        .sort((a, b) => b.saturation - a.saturation)[0],
    [segments],
  );

  const busiestStation = useMemo(
    () => Object.values(stations).sort((a, b) => b.userCount - a.userCount)[0],
    [stations],
  );

  const primaryAdvice = mostAffectedRoad
    ? pick(
        language,
        `${mostAffectedRoad.name} 周邊可能延誤，建議改道或延後出發。`,
        `${mostAffectedRoad.name} may be delayed. Consider rerouting or leaving later.`,
      )
    : pick(language, "目前主要道路狀態穩定，可依原路線移動。", "Major roads are stable. You can continue as planned.");

  return (
    <div className={styles.wrap}>
      <div className={styles.scroller}>
        <section className={styles.hero}>
          <p className={styles.eyebrow}>{pick(language, "市民助手", "Public Assistant")}</p>
          <h2>{pick(language, "取得安全、路線與人潮建議", "Safety, route, and crowd guidance")}</h2>
        </section>

        <section className={styles.card}>
          <div className={styles.cardTitle}>
            <Route size={16} aria-hidden="true" />
            <h3>{pick(language, "目前建議", "Current Advice")}</h3>
          </div>
          <p>{primaryAdvice}</p>
          {busiestStation && (
            <p>
              {pick(language, "人潮較多站點：", "Busiest station: ")}
              <strong>{busiestStation.name}</strong>
            </p>
          )}
        </section>

        <CollapsibleSection
          storageKey="public-prompts"
          defaultOpen
          className={styles.promptsCard}
          title={pick(language, "常見問題（點擊直接發問）", "Common Questions (tap to ask)")}
        >
          <div className={styles.prompts}>
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q.zh}
                type="button"
                className={styles.promptBtn}
                onClick={() => sendChatMessage(pick(language, q.zh, q.en), "public")}
              >
                {pick(language, q.zh, q.en)}
              </button>
            ))}
          </div>
        </CollapsibleSection>

        <section className={styles.notice}>
          <MessageCircle size={16} aria-hidden="true" />
          <p>
            {activeIncidents.length > 0
              ? pick(language, "目前有事件處理中，公開資訊會以官方可發布內容為準。", "Incidents are active. Public guidance is filtered for release.")
              : pick(language, "目前沒有重大公開事件。", "No major public incidents are active.")}
          </p>
        </section>
      </div>

      <section className={styles.chatSection}>
        <ChatPanel
          variant="public"
          title={pick(language, "AI 對話", "AI Chat")}
          suggestions={[]}
          placeholder={pick(language, "輸入你想問的問題…", "Ask a question…")}
        />
      </section>
    </div>
  );
}

import { MessageCircle, Route } from "lucide-react";
import { useMemo } from "react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import CollapsibleSection from "../common/CollapsibleSection";
import styles from "./PublicAssistantPanel.module.css";

export default function PublicAssistantPanel() {
  const { language } = useLanguage();
  const segments = useAppStore((s) => s.segments);
  const stations = useAppStore((s) => s.stations);
  const activeIncidents = useAppStore((s) => s.activeIncidents);

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
      <section className={styles.hero}>
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
        className={styles.promptsCard}
        title={pick(language, "可詢問的問題", "Suggested Questions")}
      >
        <div className={styles.prompts}>
          <span>{pick(language, "我要去小巨蛋，現在適合嗎？", "Is it okay to go to Taipei Arena now?")}</span>
          <span>{pick(language, "哪幾個區域建議避開？", "Which areas should I avoid?")}</span>
          <span>{pick(language, "請幫我產生英文旅客提醒。", "Create an English visitor notice.")}</span>
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
  );
}

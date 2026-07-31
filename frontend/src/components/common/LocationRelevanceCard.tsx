import { AlertTriangle } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { findNearestTrackedAlert, NEARBY_THRESHOLD_M } from "../../utils/geoDistance";
import { ALERT_KIND_LABEL } from "../../utils/alertLabels";
import styles from "./LocationRelevanceCard.module.css";

/** 依現場定位（小人）與注入事件的實際距離，鄰近某個尚未解決的事件時顯示一張獨立的警示卡片。
 *  「附近沒事件」的情況不在這裡顯示——那段文字改成融入 DecisionSummary/PublicAssistantPanel
 *  自己的摘要框裡（見那兩個檔案的 locationNote/isFarFromEvents），因為那是平靜的日常狀態，
 *  不需要另外疊一張顯眼的卡片；鄰近事件才需要獨立、醒目的警示。沒有定位或不鄰近時完全不顯示。 */
export default function LocationRelevanceCard() {
  const position = useAppStore((s) => s.fieldInspectorPosition);
  const alerts = useAppStore((s) => s.alerts);
  const roadPaths = useAppStore((s) => s.roadPaths);
  const stationCoords = useAppStore((s) => s.stationCoords);
  const seekTime = useAppStore((s) => s.seekTime);
  const { language } = useLanguage();

  if (!position) return null;

  const match = findNearestTrackedAlert([position.lng, position.lat], alerts, roadPaths, stationCoords);
  if (!match || match.distanceMeters > NEARBY_THRESHOLD_M) return null;

  const { alert, distanceMeters } = match;
  return (
    <div className={`${styles.card} ${styles.near}`}>
      <div className={styles.head}>
        <AlertTriangle size={15} aria-hidden="true" />
        <span>{pick(language, "您的定位鄰近事件", "Your location is near an incident")}</span>
      </div>
      <div className={styles.title}>{alert.title}</div>
      <div className={styles.meta}>
        {pick(language, `距離約 ${Math.round(distanceMeters)} 公尺`, `~${Math.round(distanceMeters)}m away`)}
        {" · "}
        {pick(language, ALERT_KIND_LABEL[alert.kind].zh, ALERT_KIND_LABEL[alert.kind].en)}
      </div>
      {alert.actions[0] && <p className={styles.action}>{alert.actions[0]}</p>}
      <button type="button" className={styles.link} onClick={() => seekTime(alert.timestamp)}>
        {pick(language, "查看事件詳情", "View incident details")}
      </button>
    </div>
  );
}

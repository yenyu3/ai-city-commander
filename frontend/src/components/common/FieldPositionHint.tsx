import { MapPin } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./FieldPositionHint.module.css";

export default function FieldPositionHint() {
  const fieldInspectorPosition = useAppStore((s) => s.fieldInspectorPosition);
  const fieldInspectorLocateStatus = useAppStore((s) => s.fieldInspectorLocateStatus);
  const { language } = useLanguage();

  if (!fieldInspectorPosition) {
    if (fieldInspectorLocateStatus !== "denied" && fieldInspectorLocateStatus !== "unavailable") return null;
    return (
      <div className={styles.hint}>
        <MapPin size={12} aria-hidden="true" />
        <span>
          {pick(
            language,
            "無法取得您的位置，小助手將以城市整體狀況回答。",
            "Can't get your location — answers will use overall city status.",
          )}
        </span>
      </div>
    );
  }

  return (
    <div className={styles.hint}>
      <MapPin size={12} aria-hidden="true" />
      <span>
        {pick(language, "現場定位已回報：", "Field position reported: ")}
        {fieldInspectorPosition.lat.toFixed(5)}, {fieldInspectorPosition.lng.toFixed(5)}
        {fieldInspectorPosition.nearestRoadName
          ? ` · ${pick(language, "鄰近", "near")} ${fieldInspectorPosition.nearestRoadName}`
          : ""}
      </span>
    </div>
  );
}

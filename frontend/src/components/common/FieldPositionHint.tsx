import { MapPin } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./FieldPositionHint.module.css";

export default function FieldPositionHint() {
  const fieldInspectorPosition = useAppStore((s) => s.fieldInspectorPosition);
  const { language } = useLanguage();

  if (!fieldInspectorPosition) return null;

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

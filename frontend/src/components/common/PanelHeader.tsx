import { Minimize2, Maximize2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import type { FocusZone } from "../../types";
import styles from "./PanelHeader.module.css";

export default function PanelHeader({
  icon: Icon,
  title,
  zone,
}: {
  icon: LucideIcon;
  title: string;
  zone: FocusZone;
}) {
  const focusZone = useAppStore((s) => s.focusZone);
  const toggleFocusZone = useAppStore((s) => s.toggleFocusZone);
  const { language } = useLanguage();
  const active = focusZone === zone;

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>
        <Icon size={13} aria-hidden="true" />
        <span>{title}</span>
      </div>
      <button
        type="button"
        className={styles.btn}
        aria-pressed={active}
        aria-label={`focus-toggle-${zone}`}
        title={active ? pick(language, "還原版面", "Restore layout") : pick(language, "放大此區塊", "Expand this panel")}
        onClick={() => toggleFocusZone(zone)}
      >
        {active ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
    </div>
  );
}

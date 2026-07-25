import { Minimize2, Maximize2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { pick, useLanguage } from "../../i18n";
import styles from "./PanelHeader.module.css";

export default function PanelHeader({
  icon: Icon,
  title,
  expanded,
  onToggleExpand,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  expanded?: boolean;
  onToggleExpand?: () => void;
  actions?: ReactNode;
}) {
  const { language } = useLanguage();

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>
        <Icon size={15} aria-hidden="true" />
        <span>{title}</span>
      </div>
      <div className={styles.actions}>
        {actions}
        {onToggleExpand && (
          <button
            type="button"
            className={styles.btn}
            aria-pressed={expanded}
            aria-label={expanded ? pick(language, "還原版面", "Restore layout") : pick(language, "放大此區塊", "Expand this panel")}
            title={expanded ? pick(language, "還原版面", "Restore layout") : pick(language, "放大此區塊", "Expand this panel")}
            onClick={onToggleExpand}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        )}
      </div>
    </div>
  );
}

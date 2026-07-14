import { useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { pick, useLanguage } from "../../i18n";
import styles from "./CollapsibleSection.module.css";

const STORAGE_PREFIX = "collapsible-open:";

function readStoredOpen(storageKey: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + storageKey) === "1";
  } catch {
    return false;
  }
}

export default function CollapsibleSection({
  storageKey,
  title,
  children,
  className,
}: {
  storageKey: string;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { language } = useLanguage();
  const [open, setOpen] = useState(() => readStoredOpen(storageKey));

  const handleToggle = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open;
    setOpen(next);
    try {
      window.localStorage.setItem(STORAGE_PREFIX + storageKey, next ? "1" : "0");
    } catch {
      // ignore storage errors (private browsing, etc.)
    }
  };

  return (
    <details className={`${styles.wrap} ${className ?? ""}`} open={open} onToggle={handleToggle}>
      <summary className={styles.summary}>
        <span className={styles.title}>{title}</span>
        <span className={styles.hint}>
          <ChevronDown size={13} className={styles.chevron} aria-hidden="true" />
          {open ? pick(language, "收合", "Collapse") : pick(language, "展開", "Expand")}
        </span>
      </summary>
      <div className={styles.content}>{children}</div>
    </details>
  );
}

import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./InfoPopover.module.css";

export default function InfoPopover({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.btn}
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Info size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className={styles.panel} role="dialog" aria-label={label}>
          {title && <div className={styles.panelTitle}>{title}</div>}
          {children}
        </div>
      )}
    </div>
  );
}

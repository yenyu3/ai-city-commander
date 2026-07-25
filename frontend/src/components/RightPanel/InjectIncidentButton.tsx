import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { reformatEmbeddedTimestamp } from "../../utils/timeUtils";
import styles from "./InjectIncidentButton.module.css";

const DEMO_INJECT_COUNT = 3;

export default function InjectIncidentButton() {
  const allIncidents = useAppStore((s) => s.allIncidents);
  const injectedIncidentIds = useAppStore((s) => s.injectedIncidentIds);
  const injectIncident = useAppStore((s) => s.injectIncident);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const { language } = useLanguage();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showMenu) return;
    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    }
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [showMenu]);

  return (
    <div className={styles.wrap} ref={menuRef}>
      <button
        type="button"
        className={styles.btn}
        aria-label={pick(language, "注入示範事件", "Inject demo incident")}
        title={pick(language, "注入示範事件", "Inject demo incident")}
        onClick={() => setShowMenu((v) => !v)}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
      {showMenu && (
        <div className={styles.menu}>
          <div className={styles.menuTitle}>
            {pick(language, "選擇要注入的事件（Demo）", "Choose an incident to inject (Demo)")}
          </div>
          {allIncidents.slice(0, DEMO_INJECT_COUNT).map((incident) => {
            const injected = injectedIncidentIds.has(incident.eventId);
            return (
              <button
                key={incident.eventId}
                className={`${styles.option} ${injected ? styles.optionDone : ""}`}
                disabled={injected}
                title={reformatEmbeddedTimestamp(incident.description, incident.timestamp, timeOffsetMs)}
                onClick={() => {
                  injectIncident(incident.eventId);
                  setShowMenu(false);
                }}
              >
                {injected ? "✓ " : "⚠ "}
                {incident.location}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { reformatEmbeddedTimestamp } from "../../utils/timeUtils";
import CollapsibleSection from "../common/CollapsibleSection";
import styles from "./IncidentInjectButton.module.css";

export default function IncidentInjectButton() {
  const allIncidents = useAppStore((s) => s.allIncidents);
  const injectedIncidentIds = useAppStore((s) => s.injectedIncidentIds);
  const injectIncident = useAppStore((s) => s.injectIncident);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const { language } = useLanguage();

  return (
    <CollapsibleSection
      storageKey="incident-inject"
      title={pick(language, "事件注入（Demo 控制）", "Incident Injection (Demo)")}
    >
      <div className={styles.buttons}>
        {allIncidents.map((incident) => {
          const injected = injectedIncidentIds.has(incident.eventId);
          return (
            <button
              key={incident.eventId}
              className={`${styles.btn} ${injected ? styles.injected : ""}`}
              disabled={injected}
              onClick={() => injectIncident(incident.eventId)}
              title={reformatEmbeddedTimestamp(incident.description, incident.timestamp, timeOffsetMs)}
            >
              {injected ? "✓ " : "⚠ "}
              {incident.location}
            </button>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./IncidentInjectButton.module.css";

export default function IncidentInjectButton() {
  const allIncidents = useAppStore((s) => s.allIncidents);
  const injectedIncidentIds = useAppStore((s) => s.injectedIncidentIds);
  const injectIncident = useAppStore((s) => s.injectIncident);
  const { language } = useLanguage();

  return (
    <div className={styles.wrap}>
      <span className={styles.title}>
        {pick(language, "事件注入（Demo 控制）", "Incident Injection (Demo)")}
      </span>
      <div className={styles.buttons}>
        {allIncidents.map((incident) => {
          const injected = injectedIncidentIds.has(incident.eventId);
          return (
            <button
              key={incident.eventId}
              className={`${styles.btn} ${injected ? styles.injected : ""}`}
              disabled={injected}
              onClick={() => injectIncident(incident.eventId)}
              title={incident.description}
            >
              {injected ? "✓ " : "⚠ "}
              {incident.location}
            </button>
          );
        })}
      </div>
    </div>
  );
}

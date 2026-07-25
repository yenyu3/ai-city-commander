import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./IncidentPriorityList.module.css";

const SEVERITY_RANK: Record<string, number> = { Critical: 0, High: 1, Medium: 2 };

export default function IncidentPriorityList({ limit }: { limit?: number }) {
  const activeIncidents = useAppStore((s) => s.activeIncidents);
  const incidentEte = useAppStore((s) => s.incidentEte);
  const setSelectedSegment = useAppStore((s) => s.setSelectedSegment);
  const setSelectedStation = useAppStore((s) => s.setSelectedStation);

  const { language } = useLanguage();

  if (activeIncidents.length === 0) return null;

  const focusIncident = (incident: (typeof activeIncidents)[number]) => {
    const target = incident.affectedSegment ?? incident.affectedRoad;
    if (!target) return;
    if (target.startsWith("BS_")) setSelectedStation(target);
    else setSelectedSegment(target);
  };

  const sorted = [...activeIncidents].sort((a, b) => {
    const sevDiff = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (sevDiff !== 0) return sevDiff;
    const affectedA = (a.affectedSegment ? 1 : 0) + (a.affectedRoad ? 1 : 0);
    const affectedB = (b.affectedSegment ? 1 : 0) + (b.affectedRoad ? 1 : 0);
    if (affectedB !== affectedA) return affectedB - affectedA;
    return (incidentEte[b.eventId] ?? 0) - (incidentEte[a.eventId] ?? 0);
  }).slice(0, limit);

  return (
    <div className={styles.wrap}>
      <span className={styles.title}>{pick(language, "多事件優先處理順序", "Multi-incident Priority Order")}</span>
      <div className={styles.list}>
        {sorted.map((incident, idx) => (
          <div
            key={incident.eventId}
            className={styles.item}
            role="button"
            tabIndex={0}
            onClick={() => focusIncident(incident)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                focusIncident(incident);
              }
            }}
          >
            <span className={styles.rank}>#{idx + 1}</span>
            <span className={styles.sev} data-sev={incident.severity}>
              {incident.severity}
            </span>
            <span className={styles.loc}>{incident.location}</span>
            {incidentEte[incident.eventId] !== undefined && (
              <span className={styles.ete}>
                ETE {incidentEte[incident.eventId]} {pick(language, "分", "min")}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

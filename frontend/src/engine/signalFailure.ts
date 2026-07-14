import type { LiveIncident } from "../types";

export function checkSignalFailure(incident: LiveIncident): boolean {
  return (
    incident.type === "Power_Failure" ||
    /號誌失效|故障/.test(incident.description)
  );
}

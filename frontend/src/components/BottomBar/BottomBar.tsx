import IncidentPriorityList from "./IncidentPriorityList";
import ExportReportButton from "./ExportReportButton";
import styles from "./BottomBar.module.css";

export default function BottomBar() {
  return (
    <div className={styles.wrap}>
      <IncidentPriorityList />
      <ExportReportButton />
    </div>
  );
}

import { Clock3 } from "lucide-react";
import IncidentTimeline from "./IncidentTimeline";
import IncidentPriorityList from "./IncidentPriorityList";
import ExportReportButton from "./ExportReportButton";
import AlertLogList from "./AlertLogList";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import PanelHeader from "../common/PanelHeader";
import styles from "./BottomBar.module.css";

export default function BottomBar() {
  const focusZone = useAppStore((s) => s.focusZone);
  const { language } = useLanguage();
  const isFocused = focusZone === "bottom";

  return (
    <div className={styles.outer}>
      <div className={styles.headerRow}>
        <PanelHeader
          icon={Clock3}
          title={pick(language, "事件時間軸", "Incident Timeline")}
          zone="bottom"
        />
      </div>
      <div className={styles.wrap}>
        <div className={styles.main}>
          <IncidentTimeline />
          <IncidentPriorityList />
        </div>
        <div className={styles.side}>
          <ExportReportButton />
        </div>
      </div>
      {isFocused && <AlertLogList />}
    </div>
  );
}

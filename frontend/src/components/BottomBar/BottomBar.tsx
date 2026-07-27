import { useState } from "react";
import { Clock3 } from "lucide-react";
import IncidentTimeline from "./IncidentTimeline";
import IncidentPriorityList from "./IncidentPriorityList";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import PanelHeader from "../common/PanelHeader";
import styles from "./BottomBar.module.css";

const COLLAPSED_PRIORITY_PREVIEW = 2;

export default function BottomBar() {
  const mapExpanded = useAppStore((s) => s.mapExpanded);
  const { language } = useLanguage();
  const [expanded, setExpanded] = useState(false);

  // Map fullscreen and the timeline dock fight for the same vertical space -
  // hide this block entirely rather than let both try to expand at once.
  if (mapExpanded) return null;

  return (
    <div className={styles.outer}>
      <PanelHeader
        icon={Clock3}
        title={pick(language, "事件時間軸", "Incident Timeline")}
        expanded={expanded}
        onToggleExpand={() => setExpanded((v) => !v)}
      />
      <div className={styles.wrap}>
        <IncidentTimeline />
        <IncidentPriorityList limit={expanded ? undefined : COLLAPSED_PRIORITY_PREVIEW} />
      </div>
    </div>
  );
}

import SegmentList from "./SegmentList";
import StationList from "./StationList";
import Legend from "./Legend";
import styles from "./LeftPanel.module.css";

export default function LeftPanel() {
  return (
    <div className={styles.wrap}>
      <Legend />
      <div className={styles.section}>
        <SegmentList />
      </div>
      <div className={styles.section}>
        <StationList />
      </div>
    </div>
  );
}

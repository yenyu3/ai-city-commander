import { pick, useLanguage } from "../../i18n";
import CollapsibleSection from "../common/CollapsibleSection";
import styles from "./Legend.module.css";

const ITEMS = [
  { color: "var(--ok)", zh: "正常", en: "Normal" },
  { color: "var(--warn)", zh: "B 級壅擠", en: "Tier B congestion" },
  { color: "var(--crit)", zh: "A 級癱瘓", en: "Tier A gridlock" },
  { color: "var(--cyan)", zh: "主疏散路徑", en: "Primary evacuation route" },
  { color: "var(--amber)", zh: "次要疏散 / 城市觸發路段★", en: "Secondary evac / city-trigger segment★" },
];

export default function Legend() {
  const { language } = useLanguage();
  return (
    <CollapsibleSection storageKey="legend" title={pick(language, "圖例", "Legend")}>
      <div className={styles.wrap}>
        {ITEMS.map((item) => (
          <div key={item.zh} className={styles.item}>
            <span className={styles.swatch} style={{ background: item.color }} />
            {pick(language, item.zh, item.en)}
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}

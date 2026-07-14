import { useEffect, useMemo, useState } from "react";
import { Languages, Moon, Sun } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./Header.module.css";

type Theme = "dark" | "light";

export default function Header() {
  const segments = useAppStore((s) => s.segments);
  const alerts = useAppStore((s) => s.alerts);
  const { language, toggleLanguage } = useLanguage();

  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("theme");
    return saved === "light" || saved === "dark" ? saved : "dark";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("theme", theme);
  }, [theme]);

  const counts = useMemo(() => {
    const list = Object.values(segments);
    return {
      Normal: list.filter((s) => s.tier === "Normal").length,
      B: list.filter((s) => s.tier === "B").length,
      A: list.filter((s) => s.tier === "A").length,
    };
  }, [segments]);

  const activeSopRefs = useMemo(() => {
    const set = new Set<string>();
    for (const a of alerts) if (a.sopRef) set.add(a.sopRef);
    return Array.from(set);
  }, [alerts]);

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.brandAmber}>{pick(language, "城市應變", "AI City Commander")}</span>
        <span>{pick(language, "指揮官 AI Agent", "AI Agent")}</span>
      </div>

      <div className={styles.tiers}>
        <span className={styles.tierStat}>
          <span className={`${styles.dot} ${styles.dotOk}`} />
          {pick(language, "正常", "Normal")} {counts.Normal}
        </span>
        <span className={styles.tierStat}>
          <span className={`${styles.dot} ${styles.dotWarn}`} />
          {pick(language, "B 級", "Tier B")} {counts.B}
        </span>
        <span className={styles.tierStat}>
          <span className={`${styles.dot} ${styles.dotCrit}`} />
          {pick(language, "A 級", "Tier A")} {counts.A}
        </span>
      </div>

      <div className={styles.sopTags}>
        {activeSopRefs.length === 0 ? (
          <span className={styles.sopEmpty}>
            {pick(language, "尚無 SOP 條款啟動", "No SOP clause triggered")}
          </span>
        ) : (
          activeSopRefs.map((ref, i) => (
            <span key={ref} className={styles.sopTag}>
              {i > 0 && <span className={styles.sopDivider}>·</span>}
              {ref}
            </span>
          ))
        )}
      </div>

      <div className={styles.right}>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={pick(language, `切換為${theme === "dark" ? "淺色" : "深色"}模式`, `Switch to ${theme === "dark" ? "light" : "dark"} mode`)}
            title={pick(language, `切換為${theme === "dark" ? "淺色" : "深色"}模式`, `Switch to ${theme === "dark" ? "light" : "dark"} mode`)}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            type="button"
            className={styles.langBtn}
            aria-label={pick(language, "切換為英文", "Switch to Chinese")}
            title={pick(language, "切換為英文", "Switch to Chinese")}
            onClick={toggleLanguage}
          >
            <Languages size={14} aria-hidden="true" />
            <span>{language === "zh" ? "EN" : "中"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

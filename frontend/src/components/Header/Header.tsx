import { useEffect, useMemo, useState } from "react";
import { Building2, Languages, Moon, Sun, Users } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import type { ViewerMode } from "../../types";
import TimeFilter from "../MapStage/TimeFilter";
import styles from "./Header.module.css";

type Theme = "dark" | "light";
type RiskLevel = "normal" | "elevated" | "critical";

const modeOptions: { mode: ViewerMode; icon: typeof Users }[] = [
  { mode: "public", icon: Users },
  { mode: "government", icon: Building2 },
];

export default function Header() {
  const segments = useAppStore((s) => s.segments);
  const viewerMode = useAppStore((s) => s.viewerMode);
  const setViewerMode = useAppStore((s) => s.setViewerMode);
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
      b: list.filter((s) => s.tier === "B").length,
      a: list.filter((s) => s.tier === "A").length,
    };
  }, [segments]);

  const riskLevel: RiskLevel = counts.a > 0 ? "critical" : counts.b > 0 ? "elevated" : "normal";
  const governmentRiskLabel = {
    normal: pick(language, "正常", "Normal"),
    elevated: pick(language, "升高", "Elevated"),
    critical: pick(language, "嚴重", "Critical"),
  }[riskLevel];
  const publicRiskLabel = {
    normal: pick(language, "正常", "Normal"),
    elevated: pick(language, "注意", "Advisory"),
    critical: pick(language, "緊急", "Emergency"),
  }[riskLevel];

  return (
    <header className={styles.header}>
      <div className={styles.topRow}>
        <div className={styles.brand}>
          <span className={styles.brandAmber}>{pick(language, "AI 城市指揮官", "AI City Commander")}</span>
          <span>
            {viewerMode === "public"
              ? pick(language, "市民資訊", "Public View")
              : pick(language, "AI Agent", "AI Agent")}
          </span>
        </div>

        <div className={styles.stats}>
          <span className={styles.riskBadge} data-risk={riskLevel}>
            <span className={styles.dot} />
            {viewerMode === "public"
              ? `${pick(language, "城市狀態", "City Status")}: ${publicRiskLabel}`
              : `${pick(language, "城市風險", "City Risk")}: ${governmentRiskLabel}`}
          </span>
        </div>

        <div className={styles.right}>
          <div className={styles.actions}>
            <div className={styles.modeSwitch} role="group" aria-label={pick(language, "切換檢視模式", "Switch viewer mode")}>
              {modeOptions.map(({ mode, icon: Icon }) => {
                const active = viewerMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    className={active ? styles.modeBtnActive : styles.modeBtn}
                    aria-pressed={active}
                    title={mode === "public" ? pick(language, "一般民眾", "Public") : pick(language, "政府單位", "Government")}
                    onClick={() => setViewerMode(mode)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span>{mode === "public" ? pick(language, "民眾", "Public") : pick(language, "政府", "Gov")}</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label={pick(language, "切換主題", `Switch to ${theme === "dark" ? "light" : "dark"} mode`)}
              title={pick(language, "切換主題", `Switch to ${theme === "dark" ? "light" : "dark"} mode`)}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              type="button"
              className={styles.langBtn}
              aria-label={pick(language, "切換語言", "Switch language")}
              title={pick(language, "切換語言", "Switch language")}
              onClick={toggleLanguage}
            >
              <Languages size={14} aria-hidden="true" />
              <span>{language === "zh" ? "EN" : "中"}</span>
            </button>
          </div>
        </div>
      </div>

      <div className={styles.bottomRow}>
        <TimeFilter />
      </div>
    </header>
  );
}

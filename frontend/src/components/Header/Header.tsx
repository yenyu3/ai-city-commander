import { Building2, Languages, Moon, Sun, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { pick, useLanguage } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import type { ViewerMode } from "../../types";
import styles from "./Header.module.css";

type Theme = "dark" | "light";

const modeOptions: { mode: ViewerMode; icon: LucideIcon }[] = [
  { mode: "public", icon: Users },
  { mode: "government", icon: Building2 },
];

export default function Header() {
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

  return (
    <header className={styles.header}>
      <div className={styles.topRow}>
        <div className={styles.brand} aria-label="AI City Commander">
          <img
            className={styles.brandLogo}
            src={theme === "light" ? "/logo-light.png" : "/logo-dark.png"}
            alt=""
            aria-hidden="true"
          />
          <div className={styles.brandText}>
            <span className={styles.brandPrimary}>AI City</span>
            <span className={styles.brandSecondary}>
              Commander
              <span className={styles.brandBang} aria-hidden="true">
                !
              </span>
            </span>
          </div>
        </div>

        <div className={styles.right}>
          <div className={styles.actions}>
            <div
              className={styles.modeSwitch}
              role="group"
              aria-label={pick(language, "切換檢視模式", "Switch viewer mode")}
            >
              {modeOptions.map(({ mode, icon: Icon }) => {
                const active = viewerMode === mode;
                const modeLabel =
                  mode === "public"
                    ? pick(language, "民眾模式", "Public")
                    : pick(language, "政府模式", "Government");

                return (
                  <button
                    key={mode}
                    type="button"
                    className={active ? styles.modeBtnActive : styles.modeBtn}
                    aria-pressed={active}
                    aria-label={modeLabel}
                    title={modeLabel}
                    onClick={() => setViewerMode(mode)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span>
                      {mode === "public"
                        ? pick(language, "民眾", "Public")
                        : pick(language, "政府", "Gov")}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className={styles.groupDivider} aria-hidden="true" />
            <div
              className={styles.prefsGroup}
              role="group"
              aria-label={pick(language, "偏好設定", "Preferences")}
            >
              <button
                type="button"
                className={styles.prefsBtn}
                aria-label={pick(
                  language,
                  "切換深淺色模式",
                  `Switch to ${theme === "dark" ? "light" : "dark"} mode`,
                )}
                title={pick(
                  language,
                  "切換深淺色模式",
                  `Switch to ${theme === "dark" ? "light" : "dark"} mode`,
                )}
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <div className={styles.prefsDivider} aria-hidden="true" />
              <button
                type="button"
                className={styles.prefsBtn}
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
      </div>
    </header>
  );
}

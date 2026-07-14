import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { getInitialLanguage, LanguageContext } from "./i18n";
import type { Language, LanguageContextValue } from "./i18n";

export default function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(getInitialLanguage);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-Hant" : "en";
    window.localStorage.setItem("language", language);
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      setLanguage,
      toggleLanguage: () => setLanguage((current) => (current === "zh" ? "en" : "zh")),
    }),
    [language],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

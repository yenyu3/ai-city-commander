import { createContext, useContext } from "react";

export type Language = "zh" | "en";

export type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  toggleLanguage: () => void;
};

export const LanguageContext = createContext<LanguageContextValue | null>(null);

export function getInitialLanguage(): Language {
  const saved = window.localStorage.getItem("language");
  if (saved === "en" || saved === "zh") return saved;
  return "zh";
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within LanguageProvider");
  }
  return context;
}

export function pick(language: Language, zh: string, en: string) {
  return language === "en" ? en : zh;
}

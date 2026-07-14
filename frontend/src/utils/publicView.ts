import type { AlertRecord } from "../types";
import { ALERT_KIND_LABEL } from "./alertLabels";
import type { Language } from "../i18n";
import { pick } from "../i18n";

/**
 * Public mode must never show raw internal alert titles (e.g. city_response
 * titles embed the raw Tier letter, "...觸發 B 級壅塞") before the LLM summary
 * arrives. Fall back to the generic, already-translated alert-kind label instead.
 */
export function getPublicAlertText(alert: AlertRecord, language: Language): string {
  if (alert.llmText) return alert.llmText;
  const label = ALERT_KIND_LABEL[alert.kind];
  return pick(language, `${label.zh}，官方摘要準備中…`, `${label.en} — preparing official summary…`);
}

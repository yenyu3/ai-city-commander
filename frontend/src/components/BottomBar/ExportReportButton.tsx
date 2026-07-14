import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./ExportReportButton.module.css";

export default function ExportReportButton() {
  const alerts = useAppStore((s) => s.alerts);
  const { language } = useLanguage();

  function exportJson() {
    const report = alerts
      .slice()
      .reverse()
      .map((a) => ({
        時間: a.timestamp,
        事件: a.title,
        觸發條款: a.sopRef,
        決策: a.ruleSummary,
        ETE: a.ete ?? "",
        AI摘要: a.llmText ?? "",
      }));
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "city-commander-report.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={styles.wrap}>
      <button className={styles.btn} onClick={exportJson} disabled={alerts.length === 0}>
        ⬇ {pick(language, "匯出事後報告 (JSON)", "Export After-Action Report (JSON)")}
      </button>
      <button className={styles.btn} onClick={() => window.print()} disabled={alerts.length === 0}>
        🖨 {pick(language, "列印報告", "Print Report")}
      </button>
    </div>
  );
}

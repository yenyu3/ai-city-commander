import { Download } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { formatDisplayTimestamp } from "../../utils/timeUtils";
import styles from "./ExportReportButton.module.css";

export default function ExportReportButton() {
  const alerts = useAppStore((s) => s.alerts);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const { language } = useLanguage();

  // 不接 GET /api/incidents/{eventId}/report：ready 狀態只回一個 downloadUrl
  // （"/internal/emergency-reports/..."），但 internal-results bucket 有
  // aws_s3_bucket_public_access_block（terraform/storage.tf），API Gateway 也沒有
  // 對應的 "/internal/*" route（terraform/api.tf）——這個 downloadUrl 目前打不通，
  // 前端沒有能拿到真正報告內容的方式。維持本地把 alerts 組成 JSON 下載。
  function exportJson() {
    const report = alerts
      .slice()
      .reverse()
      .map((a) => ({
        時間: formatDisplayTimestamp(a.timestamp, timeOffsetMs),
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
    <button
      type="button"
      className={styles.btn}
      onClick={exportJson}
      disabled={alerts.length === 0}
      aria-label={pick(language, "匯出報告", "Export Report")}
      title={pick(language, "匯出報告", "Export Report")}
    >
      <Download size={16} aria-hidden="true" />
    </button>
  );
}

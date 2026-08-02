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
        建議行動: a.actions,
        AI摘要: a.llmText ?? "",
        ...(a.ete !== undefined && {
          ETE預估分鐘: a.ete,
          ETE基礎分鐘: a.eteBase,
          ETE壅塞加成分鐘: a.etePenalty,
        }),
        ...(a.segmentMetrics && {
          路段名稱: a.segmentMetrics.segmentName,
          即時車流量_pcuh: a.segmentMetrics.flowPcuh,
          道路飽和度_VC: a.segmentMetrics.saturation,
        }),
        ...(a.reroute && {
          主要疏散路徑: a.reroute.primaryRouteName ?? "無",
          次要替代路徑: a.reroute.secondaryRouteNames,
          排除候選路段: a.reroute.excluded.map((e) => `${e.segmentName}：${e.reason}`),
          疏散路徑亦壅塞: a.reroute.congestionWarning,
        }),
        ...(a.signalCoordination?.signalTimings?.length && {
          號誌調整: a.signalCoordination.signalTimings.map(
            (t) => `${t.intersectionName} 綠燈+${t.adjustPct}% ${t.goal}`,
          ),
        }),
        ...(a.crossSystemCoordination?.interAgencyActions?.length && {
          跨機關聯動: a.crossSystemCoordination.interAgencyActions.map(
            (act) => `${act.agency}：${act.text}`,
          ),
        }),
        推理步驟: (a.reasoningSteps ?? []).map((s) => ({
          步驟: s.order,
          狀態: s.status,
          標題: s.title,
          說明: s.detail,
          ...(s.sopRef && { SOP: s.sopRef }),
        })),
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

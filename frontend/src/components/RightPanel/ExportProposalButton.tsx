import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { DATA_SOURCE } from "../../config";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import * as apiClient from "../../services/apiClient";
import { toScenarioAt } from "../../utils/timeUtils";
import styles from "./ExportProposalButton.module.css";

const REPORT_POLL_ATTEMPTS = 4;
const DEFAULT_REPORT_RETRY_SECONDS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getReadyBackendReport(eventId: string, scenarioAt: string): Promise<string | null> {
  for (let attempt = 0; attempt < REPORT_POLL_ATTEMPTS; attempt++) {
    const res = await apiClient.getIncidentReport(eventId, "pdf", scenarioAt);
    if (res.report.status === "ready") return res.report.downloadUrl;
    if (res.report.status === "failed") {
      throw new Error(res.report.errorMessage ?? "Backend report generation failed");
    }
    const retrySeconds = res.report.retryAfterSeconds ?? DEFAULT_REPORT_RETRY_SECONDS;
    await sleep(retrySeconds * 1000);
  }
  return null;
}

function downloadFromUrl(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function makeReportFilename(id: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `city-commander-report-${id}-${timestamp}.pdf`;
}

export default function ExportProposalButton() {
  const alerts = useAppStore((s) => s.alerts);
  const currentTime = useAppStore((s) => s.currentTime);
  const { language } = useLanguage();
  const latest = alerts[0];
  const [isExporting, setIsExporting] = useState(false);

  async function exportLocalPdf(filename: string): Promise<void> {
    const el = document.getElementById("proposal-document");
    if (!el) return;

    const prevScrollY = window.scrollY;
    window.scrollTo(0, 0);
    el.style.visibility = "visible";
    const prevMinWidth = document.body.style.minWidth;
    const exportWidth = Math.ceil(el.scrollWidth);
    const exportHeight = Math.ceil(el.scrollHeight);
    document.body.style.minWidth = `${exportWidth}px`;
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        scrollX: 0,
        scrollY: 0,
        width: exportWidth,
        height: exportHeight,
        windowWidth: exportWidth,
        windowHeight: exportHeight,
      });
      const pageWidthMm = 210;
      const pageHeightMm = (canvas.height / canvas.width) * pageWidthMm;
      const pdf = new jsPDF({
        unit: "mm",
        format: [pageWidthMm, pageHeightMm],
        orientation: "portrait",
      });
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.98), "JPEG", 0, 0, pageWidthMm, pageHeightMm);
      pdf.save(filename);
    } finally {
      document.body.style.minWidth = prevMinWidth;
      el.style.visibility = "";
      window.scrollTo(0, prevScrollY);
    }
  }

  async function handleExport() {
    if (!latest || isExporting) return;

    setIsExporting(true);
    const reportId = latest.sourceIncidentId ?? latest.id;
    const filename = makeReportFilename(reportId);
    try {
      if (DATA_SOURCE === "api" && latest.sourceIncidentId) {
        try {
          const downloadUrl = await getReadyBackendReport(
            latest.sourceIncidentId,
            toScenarioAt(currentTime || latest.timestamp),
          );
          if (downloadUrl) {
            downloadFromUrl(downloadUrl, filename);
            return;
          }
        } catch (err) {
          console.warn(
            "[ExportProposalButton] GET /api/incidents/{eventId}/report failed; falling back to local PDF export",
            err,
          );
        }
      }

      await exportLocalPdf(filename);
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <button
      type="button"
      className={styles.btn}
      onClick={handleExport}
      disabled={!latest || isExporting}
      aria-label={pick(language, "匯出報告", "Export Proposal")}
      title={pick(language, "匯出應變中心報告 PDF", "Export ops-center proposal (PDF)")}
    >
      {isExporting ? (
        <Loader2 size={16} className={styles.spin} aria-hidden="true" />
      ) : (
        <Download size={16} aria-hidden="true" />
      )}
    </button>
  );
}

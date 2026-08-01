import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./ExportProposalButton.module.css";

function makeReportFilename(id: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `city-commander-report-${id}-${timestamp}.pdf`;
}

export default function ExportProposalButton() {
  const alerts = useAppStore((s) => s.alerts);
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
      // GET /api/incidents/{eventId}/report only ever produces a report-v1.json (see
      // backend/service/report_builder.py) — there is no PDF producer anywhere in the
      // backend, so polling it with format=pdf can never succeed. Render the in-app
      // proposal document (already fed by the same decision data) straight to PDF instead.
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

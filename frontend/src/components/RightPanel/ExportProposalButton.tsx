import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import styles from "./ExportProposalButton.module.css";

export default function ExportProposalButton() {
  const alerts = useAppStore((s) => s.alerts);
  const { language } = useLanguage();
  const latest = alerts[0];
  const [isExporting, setIsExporting] = useState(false);

  async function handleExport() {
    if (!latest || isExporting) return;
    const el = document.getElementById("proposal-document");
    if (!el) return;

    setIsExporting(true);
    const prevScrollY = window.scrollY;
    window.scrollTo(0, 0);
    el.style.clipPath = "none";
    const prevMinWidth = document.body.style.minWidth;
    document.body.style.minWidth = "794px";
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      const canvas = await html2canvas(el, { scale: 2, useCORS: true, scrollX: 0, scrollY: 0 });
      // 直接用截圖的長寬比算出單張自訂尺寸的頁面（寬固定為 A4 寬 210mm），
      // 不做分頁裁切——文件不長，單頁完整呈現比處理跨頁裁切簡單可靠。
      const pageWidthMm = 210;
      const pageHeightMm = (canvas.height / canvas.width) * pageWidthMm;
      const pdf = new jsPDF({
        unit: "mm",
        format: [pageWidthMm, pageHeightMm],
        orientation: "portrait",
      });
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.98), "JPEG", 0, 0, pageWidthMm, pageHeightMm);
      pdf.save(`交控中心建議書_${latest.id}.pdf`);
    } finally {
      document.body.style.minWidth = prevMinWidth;
      el.style.clipPath = "";
      window.scrollTo(0, prevScrollY);
      setIsExporting(false);
    }
  }

  return (
    <button
      type="button"
      className={styles.btn}
      onClick={handleExport}
      disabled={!latest || isExporting}
      aria-label={pick(language, "匯出建議書", "Export Proposal")}
      title={pick(language, "匯出交控中心建議書 (PDF)", "Export ops-center proposal (PDF)")}
    >
      {isExporting ? (
        <Loader2 size={16} className={styles.spin} aria-hidden="true" />
      ) : (
        <Download size={16} aria-hidden="true" />
      )}
    </button>
  );
}

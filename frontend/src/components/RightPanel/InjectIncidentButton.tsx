import { useEffect, useRef, useState } from "react";
import { Plus, UploadCloud } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { reformatEmbeddedTimestamp } from "../../utils/timeUtils";
import type { LiveIncident } from "../../types";
import styles from "./InjectIncidentButton.module.css";

export default function InjectIncidentButton() {
  const allIncidents = useAppStore((s) => s.allIncidents);
  const injectedIncidentIds = useAppStore((s) => s.injectedIncidentIds);
  const injectIncident = useAppStore((s) => s.injectIncident);
  const addIncidents = useAppStore((s) => s.addIncidents);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const { language } = useLanguage();
  const [showMenu, setShowMenu] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ type: "ok" | "error"; message: string } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!uploadStatus) return;
    const t = setTimeout(() => setUploadStatus(null), 4000);
    return () => clearTimeout(t);
  }, [uploadStatus]);

  function parseAndAdd(text: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      setUploadStatus({ type: "error", message: pick(language, "JSON 格式錯誤，請確認檔案內容", "Invalid JSON — please check the file content") });
      return;
    }
    const arr: unknown[] = Array.isArray(raw) ? raw : [raw];
    const valid: LiveIncident[] = [];
    let skipped = 0;
    for (const item of arr) {
      if (typeof item !== "object" || item === null) { skipped++; continue; }
      const i = item as Record<string, unknown>;
      const incident: LiveIncident = {
        eventId: String(i.event_id ?? i.eventId ?? ""),
        type: String(i.type ?? ""),
        location: String(i.location ?? ""),
        affectedSegment: String(i.affected_segment ?? i.affectedSegment ?? ""),
        affectedRoad: i.affected_road != null ? String(i.affected_road) : i.affectedRoad != null ? String(i.affectedRoad) : undefined,
        status: String(i.status ?? ""),
        severity: String(i.severity ?? ""),
        description: String(i.description ?? ""),
        timestamp: String(i.timestamp ?? ""),
      };
      if (incident.eventId && incident.type && incident.location && incident.affectedSegment && incident.status && incident.severity && incident.timestamp) {
        valid.push(incident);
      } else {
        skipped++;
      }
    }
    if (valid.length === 0) {
      setUploadStatus({ type: "error", message: pick(language, skipped > 0 ? `所有 ${skipped} 筆事件皆缺少必要欄位` : "檔案中未找到有效事件", skipped > 0 ? `All ${skipped} incident(s) missing required fields` : "No valid incidents found") });
      return;
    }
    addIncidents(valid);
    setUploadStatus({ type: "ok", message: pick(language, skipped > 0 ? `已新增 ${valid.length} 筆，略過 ${skipped} 筆` : `已新增 ${valid.length} 筆事件`, skipped > 0 ? `Added ${valid.length}, skipped ${skipped}` : `Added ${valid.length} incident(s)`) });
  }

  function readFile(file: File) {
    const reader = new FileReader();
    reader.onload = (ev) => parseAndAdd(ev.target?.result as string);
    reader.onerror = () => setUploadStatus({ type: "error", message: pick(language, "檔案讀取失敗", "Failed to read file") });
    reader.readAsText(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) readFile(file);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  }

  useEffect(() => {
    if (!showMenu) return;
    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    }
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [showMenu]);

  return (
    <div className={styles.wrap} ref={menuRef}>
      <button
        type="button"
        className={styles.btn}
        aria-label={pick(language, "注入示範事件", "Inject demo incident")}
        title={pick(language, "注入示範事件", "Inject demo incident")}
        onClick={() => setShowMenu((v) => !v)}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className={styles.fileInput}
        onChange={handleFileInput}
      />
      {showMenu && (
        <div className={styles.menu}>
          {uploadStatus && (
            <div className={`${styles.status} ${uploadStatus.type === "error" ? styles.statusError : styles.statusOk}`} role="status">
              {uploadStatus.message}
            </div>
          )}
          <div className={styles.menuTitle}>
            {pick(language, "選擇要注入的事件（Demo）", "Choose an incident to inject (Demo)")}
          </div>
          {allIncidents.map((incident) => {
            const injected = injectedIncidentIds.has(incident.eventId);
            return (
              <button
                key={incident.eventId}
                className={`${styles.option} ${injected ? styles.optionDone : ""}`}
                disabled={injected}
                title={reformatEmbeddedTimestamp(incident.description, incident.timestamp, timeOffsetMs)}
                onClick={() => {
                  injectIncident(incident.eventId);
                  setShowMenu(false);
                }}
              >
                <span className={styles.optionIcon}>{injected ? "✓" : "⚠"}</span>
                <span className={styles.optionText}>{incident.location}</span>
              </button>
            );
          })}
          <div
            className={`${styles.dropzone} ${isDragOver ? styles.dropzoneOver : ""}`}
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
            aria-label={pick(language, "上傳事件 JSON", "Upload incident JSON")}
          >
            <UploadCloud size={18} aria-hidden="true" />
            <span>{pick(language, "拖曳或點擊上傳 JSON", "Drop or click to upload JSON")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

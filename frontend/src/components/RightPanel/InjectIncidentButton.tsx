import { useEffect, useRef, useState } from "react";
import { Plus, UploadCloud } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import type { LiveIncident } from "../../types";
import styles from "./InjectIncidentButton.module.css";

export default function InjectIncidentButton() {
  const submitIncident = useAppStore((s) => s.submitIncident);
  const { language } = useLanguage();
  const [showMenu, setShowMenu] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ type: "ok" | "error"; message: string } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!uploadStatus) return;
    const timer = window.setTimeout(() => setUploadStatus(null), 4000);
    return () => window.clearTimeout(timer);
  }, [uploadStatus]);

  function parseAndAdd(text: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      setUploadStatus({
        type: "error",
        message: pick(language, "JSON 格式無效，請檢查檔案內容", "Invalid JSON. Please check the file content."),
      });
      return;
    }

    const items: unknown[] = Array.isArray(raw) ? raw : [raw];
    const valid: LiveIncident[] = [];
    let skipped = 0;

    for (const item of items) {
      if (typeof item !== "object" || item === null) {
        skipped += 1;
        continue;
      }

      const source = item as Record<string, unknown>;
      const incident: LiveIncident = {
        eventId: String(source.event_id ?? source.eventId ?? ""),
        type: String(source.type ?? ""),
        location: String(source.location ?? ""),
        affectedSegmentId: String(source.affectedSegmentId ?? source.affected_segment ?? source.affectedSegment ?? ""),
        affectedRoad:
          source.affected_road != null
            ? String(source.affected_road)
            : source.affectedRoad != null
              ? String(source.affectedRoad)
              : undefined,
        status: String(source.status ?? ""),
        severity: String(source.severity ?? ""),
        description: String(source.description ?? ""),
        occurredAt: String(source.occurredAt ?? source.timestamp ?? ""),
      };

      if (
        incident.eventId &&
        incident.type &&
        incident.location &&
        incident.affectedSegmentId &&
        incident.status &&
        incident.severity &&
        incident.occurredAt
      ) {
        valid.push(incident);
      } else {
        skipped += 1;
      }
    }

    if (valid.length === 0) {
      setUploadStatus({
        type: "error",
        message:
          skipped > 0
            ? pick(language, `${skipped} 筆事件缺少必要欄位`, `All ${skipped} incident(s) are missing required fields`)
            : pick(language, "找不到有效事件", "No valid incidents found"),
      });
      return;
    }

    valid.forEach(submitIncident);
    setUploadStatus({
      type: "ok",
      message:
        skipped > 0
          ? pick(language, `已加入 ${valid.length} 筆，略過 ${skipped} 筆`, `Added ${valid.length}, skipped ${skipped}`)
          : pick(language, `已加入 ${valid.length} 筆事件`, `Added ${valid.length} incident(s)`),
    });
  }

  function readFile(file: File) {
    const reader = new FileReader();
    reader.onload = (event) => parseAndAdd(String(event.target?.result ?? ""));
    reader.onerror = () => {
      setUploadStatus({
        type: "error",
        message: pick(language, "讀取檔案失敗", "Failed to read file"),
      });
    };
    reader.readAsText(file);
  }

  function handleFileInput(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) readFile(file);
    event.target.value = "";
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setIsDragOver(false);
    const file = event.dataTransfer.files?.[0];
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
        aria-label={pick(language, "注入緊急事件", "Inject incident")}
        title={pick(language, "注入緊急事件", "Inject incident")}
        onClick={() => setShowMenu((value) => !value)}
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
            {pick(language, "上傳事件 JSON", "Upload incident JSON")}
          </div>
          <div
            className={`${styles.dropzone} ${isDragOver ? styles.dropzoneOver : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
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

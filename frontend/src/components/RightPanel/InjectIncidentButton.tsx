import { useEffect, useRef, useState } from "react";
import { Plus, UploadCloud } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import { reformatEmbeddedTimestamp } from "../../utils/timeUtils";
import type { LiveIncident } from "../../types";
import styles from "./InjectIncidentButton.module.css";

const DEMO_INJECT_COUNT = 3;

export default function InjectIncidentButton() {
  const allIncidents = useAppStore((s) => s.allIncidents);
  const injectedIncidentIds = useAppStore((s) => s.injectedIncidentIds);
  const injectIncident = useAppStore((s) => s.injectIncident);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const addIncidents = useAppStore((s) => s.addIncidents);
  const { language } = useLanguage();
  const [showMenu, setShowMenu] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [uploadedIds, setUploadedIds] = useState<Set<string>>(new Set());
  const [uploadStatus, setUploadStatus] = useState<{ type: "ok" | "error"; message: string } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!uploadStatus) return;
    const t = setTimeout(() => setUploadStatus(null), 4000);
    return () => clearTimeout(t);
  }, [uploadStatus]);

  function parseIncidents(text: string): { valid: LiveIncident[]; skipped: number } {
    const raw = JSON.parse(text);
    const arr: unknown[] = Array.isArray(raw) ? raw : [raw];
    const candidates = arr.filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
    );
    const valid: LiveIncident[] = [];
    let skipped = 0;
    for (const item of candidates) {
      const incident: LiveIncident = {
        eventId: String(item.event_id ?? item.eventId ?? ""),
        type: String(item.type ?? ""),
        location: String(item.location ?? ""),
        affectedSegment: String(item.affected_segment ?? item.affectedSegment ?? ""),
        affectedRoad: item.affected_road != null ? String(item.affected_road) : item.affectedRoad != null ? String(item.affectedRoad) : undefined,
        status: String(item.status ?? ""),
        severity: String(item.severity ?? ""),
        description: String(item.description ?? ""),
        timestamp: String(item.timestamp ?? ""),
      };
      const hasRequiredFields =
        incident.eventId &&
        incident.type &&
        incident.location &&
        incident.affectedSegment &&
        incident.status &&
        incident.severity &&
        incident.timestamp;
      if (hasRequiredFields) {
        valid.push(incident);
      } else {
        skipped += 1;
      }
    }
    return { valid, skipped };
  }

  function parseAndAdd(text: string) {
    let result: { valid: LiveIncident[]; skipped: number };
    try {
      result = parseIncidents(text);
    } catch {
      setUploadStatus({
        type: "error",
        message: pick(language, "JSON 格式錯誤，請確認檔案內容", "Invalid JSON — please check the file content"),
      });
      return;
    }
    const { valid, skipped } = result;
    if (valid.length === 0) {
      setUploadStatus({
        type: "error",
        message: pick(
          language,
          skipped > 0 ? `所有 ${skipped} 筆事件皆缺少必要欄位，未新增任何事件` : "檔案中未找到有效事件",
          skipped > 0 ? `All ${skipped} incident(s) were missing required fields — nothing added` : "No valid incidents found in file",
        ),
      });
      return;
    }
    addIncidents(valid);
    setUploadedIds((prev) => {
      const next = new Set(prev);
      valid.forEach((i) => next.add(i.eventId));
      return next;
    });
    setUploadStatus({
      type: "ok",
      message: pick(
        language,
        skipped > 0 ? `已新增 ${valid.length} 筆事件，略過 ${skipped} 筆（缺少必要欄位）` : `已新增 ${valid.length} 筆事件`,
        skipped > 0 ? `Added ${valid.length} incident(s), skipped ${skipped} (missing required fields)` : `Added ${valid.length} incident(s)`,
      ),
    });
  }

  function readFile(file: File) {
    const reader = new FileReader();
    reader.onload = (ev) => parseAndAdd(ev.target?.result as string);
    reader.onerror = () =>
      setUploadStatus({
        type: "error",
        message: pick(language, "檔案讀取失敗", "Failed to read file"),
      });
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
        ref={btnRef}
        onClick={() => {
          if (!showMenu && btnRef.current) {
            const r = btnRef.current.getBoundingClientRect();
            setMenuPos({ top: r.bottom + 8, right: window.innerWidth - r.right });
          }
          setShowMenu((v) => !v);
        }}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
      {/* anchor for fixed menu positioning */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className={styles.fileInput}
        onChange={handleFileInput}
      />
      {showMenu && (
        <div className={styles.menu} style={menuPos ? { top: menuPos.top, right: menuPos.right } : undefined}>
          <div className={styles.menuTitle}>
            {pick(language, "選擇要注入的事件（Demo）", "Choose an incident to inject (Demo)")}
          </div>
          <div className={styles.optionList}>
            {allIncidents
              .filter((incident, idx) => idx < DEMO_INJECT_COUNT || uploadedIds.has(incident.eventId))
              .map((incident) => {
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
          </div>
          {uploadStatus && (
            <div
              className={`${styles.status} ${uploadStatus.type === "error" ? styles.statusError : styles.statusOk}`}
              role="status"
            >
              {uploadStatus.message}
            </div>
          )}
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

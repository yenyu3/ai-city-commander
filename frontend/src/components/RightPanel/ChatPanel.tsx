import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { SOP_SECTIONS } from "../../services/sopRetrieval";
import { pick, useLanguage } from "../../i18n";
import { reformatEmbeddedTimestamp } from "../../utils/timeUtils";
import styles from "./ChatPanel.module.css";

const DEMO_INJECT_COUNT = 3;

const SUGGESTIONS = [
  "若 BL17 人數增加到 40000 人會怎樣？",
  "光復南路封閉時的疏散路徑規則是什麼？",
  "台北101的漫遊用戶佔比 45% 會怎麼處理？",
  "ETE 的計算公式是什麼？",
];

function sopIdFromRef(ref: string): string | null {
  const m = ref.match(/\d+/);
  return m ? m[0] : null;
}

export default function ChatPanel() {
  const chatMessages = useAppStore((s) => s.chatMessages);
  const sendChatMessage = useAppStore((s) => s.sendChatMessage);
  const allIncidents = useAppStore((s) => s.allIncidents);
  const injectedIncidentIds = useAppStore((s) => s.injectedIncidentIds);
  const injectIncident = useAppStore((s) => s.injectIncident);
  const timeOffsetMs = useAppStore((s) => s.timeOffsetMs);
  const { language } = useLanguage();
  const [input, setInput] = useState("");
  const [expandedRef, setExpandedRef] = useState<string | null>(null);
  const [showInjectMenu, setShowInjectMenu] = useState(false);
  const injectMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showInjectMenu) return;
    function handlePointerDown(event: MouseEvent) {
      if (injectMenuRef.current && !injectMenuRef.current.contains(event.target as Node)) {
        setShowInjectMenu(false);
      }
    }
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [showInjectMenu]);

  function submit(text: string) {
    if (!text.trim()) return;
    sendChatMessage(text.trim());
    setInput("");
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>{pick(language, "對話式 SOP 問答", "SOP Q&A Chat")}</div>

      <div className={styles.messages}>
        {chatMessages.length === 0 && (
          <div className={styles.suggestions}>
            {SUGGESTIONS.map((q) => (
              <button key={q} className={styles.suggestion} onClick={() => submit(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        {chatMessages.map((m) => (
          <div key={m.id} className={`${styles.bubble} ${m.role === "user" ? styles.user : styles.assistant}`}>
            <div className={styles.bubbleText}>{m.text}</div>
            {m.sopRefs && m.sopRefs.length > 0 && (
              <div className={styles.refRow}>
                {m.sopRefs.map((ref) => {
                  const id = sopIdFromRef(ref);
                  const section = SOP_SECTIONS.find((s) => s.id === id);
                  const key = `${m.id}_${ref}`;
                  return (
                    <div key={ref} className={styles.refWrap}>
                      <button
                        className={styles.refTag}
                        onClick={() => setExpandedRef(expandedRef === key ? null : key)}
                      >
                        {pick(language, "依據", "Ref")}：{ref}
                      </button>
                      {expandedRef === key && section && (
                        <pre className={styles.refText}>{section.text}</pre>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={styles.inputRow}>
        <div className={styles.injectWrap} ref={injectMenuRef}>
          <button
            type="button"
            className={styles.injectBtn}
            aria-label={pick(language, "注入示範事件", "Inject demo incident")}
            title={pick(language, "注入示範事件", "Inject demo incident")}
            onClick={() => setShowInjectMenu((v) => !v)}
          >
            <Plus size={16} />
          </button>
          {showInjectMenu && (
            <div className={styles.injectMenu}>
              <div className={styles.injectMenuTitle}>
                {pick(language, "選擇要注入的事件（Demo）", "Choose an incident to inject (Demo)")}
              </div>
              {allIncidents.slice(0, DEMO_INJECT_COUNT).map((incident) => {
                const injected = injectedIncidentIds.has(incident.eventId);
                return (
                  <button
                    key={incident.eventId}
                    className={`${styles.injectOption} ${injected ? styles.injectOptionDone : ""}`}
                    disabled={injected}
                    title={reformatEmbeddedTimestamp(incident.description, incident.timestamp, timeOffsetMs)}
                    onClick={() => {
                      injectIncident(incident.eventId);
                      setShowInjectMenu(false);
                    }}
                  >
                    {injected ? "✓ " : "⚠ "}
                    {incident.location}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <input
          className={styles.input}
          placeholder={pick(language, "輸入假設性問題…", "Ask a what-if question…")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit(input)}
        />
        <button className={styles.sendBtn} onClick={() => submit(input)}>
          {pick(language, "送出", "Send")}
        </button>
      </div>
    </div>
  );
}

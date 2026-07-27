import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { SOP_SECTIONS } from "../../services/sopRetrieval";
import { pick, useLanguage } from "../../i18n";
import styles from "./ChatPanel.module.css";

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
  const { language } = useLanguage();
  const [input, setInput] = useState("");
  const [expandedRef, setExpandedRef] = useState<string | null>(null);

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

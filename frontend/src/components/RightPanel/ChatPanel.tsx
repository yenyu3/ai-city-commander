import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, X } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import type { ViewerMode } from "../../types";
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

type ChatPanelProps = {
  /** "public" 隱藏事件注入與 SOP 條號，供市民助手複用同一個對話框。 */
  variant?: ViewerMode;
  title?: string;
  suggestions?: string[];
  placeholder?: string;
};

export default function ChatPanel({
  variant = "government",
  title,
  suggestions = SUGGESTIONS,
  placeholder,
}: ChatPanelProps) {
  const chatMessages = useAppStore((s) => s.chatMessages);
  const sendChatMessage = useAppStore((s) => s.sendChatMessage);
  const fieldInspectorPosition = useAppStore((s) => s.fieldInspectorPosition);
  const { language } = useLanguage();
  const [input, setInput] = useState("");
  const [expandedRef, setExpandedRef] = useState<string | null>(null);
  const [expandedReasoningId, setExpandedReasoningId] = useState<string | null>(null);
  const [contextDismissed, setContextDismissed] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const isPublic = variant === "public";
  // 小人移動到新路段時視為新的 context，重新自動附加，讓 Tag 行為像「目前位置」而非一次性選取
  useEffect(() => {
    setContextDismissed(false);
  }, [fieldInspectorPosition?.nearestRoadId]);
  const attachedContext =
    !contextDismissed && fieldInspectorPosition?.nearestRoadId ? fieldInspectorPosition : null;
  // 政府／市民兩種模式各自一條對話串，切換模式不會看到對方的訊息
  const messages = useMemo(
    () => chatMessages.filter((m) => m.audience === variant),
    [chatMessages, variant],
  );

  // 新訊息（含從推薦問題送出的）進來時自動捲到底
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function submit(text: string) {
    if (!text.trim()) return;
    sendChatMessage(text.trim(), variant, attachedContext);
    setInput("");
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>
        {title ?? pick(language, "對話式 SOP 問答", "SOP Q&A Chat")}
      </div>

      <div className={styles.messages} ref={messagesRef}>
        {messages.length === 0 && suggestions.length > 0 && (
          <div className={styles.suggestions}>
            {suggestions.map((q) => (
              <button key={q} className={styles.suggestion} onClick={() => submit(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`${styles.bubble} ${m.role === "user" ? styles.user : styles.assistant}`}>
            <div className={styles.bubbleText}>{m.text}</div>
            {!isPublic && m.sopRefs && m.sopRefs.length > 0 && (
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
            {!isPublic && m.reasoningSteps && m.reasoningSteps.length > 0 && (
              <div className={styles.reasoningWrap}>
                <button
                  className={styles.reasoningToggle}
                  onClick={() =>
                    setExpandedReasoningId(expandedReasoningId === m.id ? null : m.id)
                  }
                >
                  {pick(language, "查看推理過程", "View reasoning")} ({m.reasoningSteps.length})
                </button>
                {expandedReasoningId === m.id && (
                  <ol className={styles.reasoningList}>
                    {m.reasoningSteps
                      .slice()
                      .sort((a, b) => a.order - b.order)
                      .map((step) => (
                        <li key={step.order} className={styles.reasoningStep}>
                          <div className={styles.reasoningStepHead}>
                            <span className={styles.reasoningStepTitle}>{step.title}</span>
                            {step.sopRef && (
                              <span className={styles.reasoningStepRef}>{step.sopRef}</span>
                            )}
                          </div>
                          <p className={styles.reasoningStepDetail}>{step.detail}</p>
                        </li>
                      ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {attachedContext && (
        <div className={styles.contextBar}>
          <span className={styles.contextTag}>
            <MapPin size={12} aria-hidden="true" />
            {pick(language, "鄰近", "Near")} {attachedContext.nearestRoadName}
            <button
              type="button"
              className={styles.contextRemove}
              onClick={() => setContextDismissed(true)}
              aria-label={pick(language, "移除位置附件", "Remove location attachment")}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        </div>
      )}

      <div className={styles.inputRow}>
        <input
          className={styles.input}
          placeholder={placeholder ?? pick(language, "輸入假設性問題…", "Ask a what-if question…")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit(input)}
        />
        <button
          className={styles.sendBtn}
          onClick={() => submit(input)}
          disabled={!input.trim()}
        >
          {pick(language, "送出", "Send")}
        </button>
      </div>
    </div>
  );
}

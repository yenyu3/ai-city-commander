import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

function renderInlineMarkdown(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  const boldPattern = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = boldPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(<strong key={`${match.index}-${match[1]}`}>{match[1]}</strong>);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length > 0 ? nodes : text;
}

function ChatMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }

    const boldHeading = line.match(/^\*\*(.+?)\*\*$/);
    if (boldHeading) {
      blocks.push(
        <h4 key={`h-${index}`} className={styles.markdownHeading}>
          {boldHeading[1]}
        </h4>,
      );
      index += 1;
      continue;
    }

    if (/^(?:[•\-*])\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^(?:[•\-*])\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`} className={styles.markdownList}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`} className={styles.markdownList}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const nextLine = lines[index].trim();
      if (
        !nextLine ||
        /^\*\*(.+?)\*\*$/.test(nextLine) ||
        /^(?:[•\-*])\s+/.test(nextLine) ||
        /^\d+[.)]\s+/.test(nextLine)
      ) {
        break;
      }
      paragraph.push(nextLine);
      index += 1;
    }
    blocks.push(
      <p key={`p-${index}`} className={styles.markdownParagraph}>
        {renderInlineMarkdown(paragraph.join(" "))}
      </p>,
    );
  }

  return <div className={styles.markdown}>{blocks}</div>;
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
            <div className={styles.bubbleText}>
              {m.isPending ? (
                <span className={styles.thinking} aria-label="Thinking">
                  Thinking
                  <span className={styles.thinkingDots} aria-hidden="true">
                    <span>.</span>
                    <span>.</span>
                    <span>.</span>
                  </span>
                </span>
              ) : (
                m.role === "assistant" ? <ChatMarkdown text={m.text} /> : m.text
              )}
            </div>
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

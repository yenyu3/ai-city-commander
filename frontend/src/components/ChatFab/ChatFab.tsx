import { useState } from "react";
import { Bot, X } from "lucide-react";
import { pick, useLanguage } from "../../i18n";
import ChatPanel from "../RightPanel/ChatPanel";
import styles from "./ChatFab.module.css";

export default function ChatFab() {
  const [open, setOpen] = useState(false);
  const { language } = useLanguage();

  return (
    <>
      {open && (
        <div className={styles.panel} role="dialog" aria-label={pick(language, "What-if 問答", "What-if Q&A")}>
          <ChatPanel />
        </div>
      )}
      <button
        type="button"
        className={styles.fab}
        aria-expanded={open}
        aria-label={open ? pick(language, "關閉聊天", "Close chat") : pick(language, "開啟 AI 問答", "Open AI chat")}
        title={open ? pick(language, "關閉聊天", "Close chat") : pick(language, "開啟 AI 問答", "Open AI chat")}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X size={22} /> : <Bot size={22} />}
      </button>
    </>
  );
}

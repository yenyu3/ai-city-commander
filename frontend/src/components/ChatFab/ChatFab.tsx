import { useEffect, useRef, useState } from "react";
import { Bot, GripHorizontal, X } from "lucide-react";
import { pick, useLanguage } from "../../i18n";
import ChatPanel from "../RightPanel/ChatPanel";
import styles from "./ChatFab.module.css";

const FAB_SIZE = 52;
const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 560;
const PANEL_GAP = 12;
const VIEWPORT_MARGIN = 16;

type Position = {
  x: number;
  y: number;
};

type PanelMetrics = Position & {
  width: number;
  height: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function getDefaultFabPosition(): Position {
  if (typeof window === "undefined") {
    return { x: 24, y: 24 };
  }

  return {
    x: window.innerWidth - FAB_SIZE - 24,
    y: window.innerHeight - FAB_SIZE - 24,
  };
}

function constrainFabPosition(position: Position): Position {
  if (typeof window === "undefined") return position;

  return {
    x: clamp(position.x, VIEWPORT_MARGIN, window.innerWidth - FAB_SIZE - VIEWPORT_MARGIN),
    y: clamp(position.y, VIEWPORT_MARGIN, window.innerHeight - FAB_SIZE - VIEWPORT_MARGIN),
  };
}

function getPanelSize() {
  const panelWidth = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const panelHeight = Math.min(PANEL_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2 - FAB_SIZE - PANEL_GAP);

  return {
    width: panelWidth,
    height: panelHeight,
  };
}

function getPanelMetrics(fabPosition: Position): PanelMetrics {
  if (typeof window === "undefined") {
    return { ...fabPosition, width: PANEL_WIDTH, height: PANEL_HEIGHT };
  }

  const { width, height } = getPanelSize();

  return {
    x: clamp(fabPosition.x + FAB_SIZE - width, VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
    y: clamp(fabPosition.y - height - PANEL_GAP, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
    width,
    height,
  };
}

function getOpenFabPosition(panel: PanelMetrics): Position {
  if (typeof window === "undefined") return panel;

  const sideY = clamp(panel.y, VIEWPORT_MARGIN, window.innerHeight - FAB_SIZE - VIEWPORT_MARGIN);
  const rightX = panel.x + panel.width + PANEL_GAP;
  if (rightX <= window.innerWidth - FAB_SIZE - VIEWPORT_MARGIN) {
    return { x: rightX, y: sideY };
  }

  const leftX = panel.x - FAB_SIZE - PANEL_GAP;
  if (leftX >= VIEWPORT_MARGIN) {
    return { x: leftX, y: sideY };
  }

  const bottomY = panel.y + panel.height + PANEL_GAP;
  const rowX = clamp(panel.x + panel.width - FAB_SIZE, VIEWPORT_MARGIN, window.innerWidth - FAB_SIZE - VIEWPORT_MARGIN);
  if (bottomY <= window.innerHeight - FAB_SIZE - VIEWPORT_MARGIN) {
    return { x: rowX, y: bottomY };
  }

  const topY = panel.y - FAB_SIZE - PANEL_GAP;
  if (topY >= VIEWPORT_MARGIN) {
    return { x: rowX, y: topY };
  }

  return {
    x: clamp(panel.x + panel.width - FAB_SIZE - 8, VIEWPORT_MARGIN, window.innerWidth - FAB_SIZE - VIEWPORT_MARGIN),
    y: clamp(panel.y + 8, VIEWPORT_MARGIN, window.innerHeight - FAB_SIZE - VIEWPORT_MARGIN),
  };
}

export default function ChatFab() {
  const [open, setOpen] = useState(false);
  const [fabPosition, setFabPosition] = useState<Position>(() => constrainFabPosition(getDefaultFabPosition()));
  const wasDraggedRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const { language } = useLanguage();
  const panelMetrics = getPanelMetrics(fabPosition);
  const buttonPosition = open ? getOpenFabPosition(panelMetrics) : fabPosition;

  useEffect(() => {
    function handleResize() {
      setFabPosition((position) => constrainFabPosition(position));
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  function startDrag(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: fabPosition.x,
      originY: fabPosition.y,
    };
    wasDraggedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
      wasDraggedRef.current = true;
    }

    setFabPosition(constrainFabPosition({ x: drag.originX + deltaX, y: drag.originY + deltaY }));
  }

  function endDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <>
      {open && (
        <div
          className={styles.panel}
          style={{ left: panelMetrics.x, top: panelMetrics.y }}
          role="dialog"
          aria-label={pick(language, "What-if 問答", "What-if Q&A")}
        >
          <div
            className={styles.dragHandle}
            title={pick(language, "拖曳移動", "Drag to move")}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <GripHorizontal size={18} aria-hidden="true" />
          </div>
          <ChatPanel />
        </div>
      )}
      <button
        type="button"
        className={styles.fab}
        style={{ left: buttonPosition.x, top: buttonPosition.y }}
        aria-expanded={open}
        aria-label={open ? pick(language, "關閉聊天", "Close chat") : pick(language, "開啟 AI 問答", "Open AI chat")}
        title={open ? pick(language, "關閉聊天", "Close chat") : pick(language, "開啟 AI 問答", "Open AI chat")}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={() => {
          if (wasDraggedRef.current) {
            wasDraggedRef.current = false;
            return;
          }
          setOpen((value) => !value);
        }}
      >
        {open ? <X size={22} /> : <Bot size={22} />}
      </button>
    </>
  );
}

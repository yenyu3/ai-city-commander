import { Box, Layers, Map as MapIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pick, useLanguage } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import AlertOverlay from "../AlertOverlay/AlertOverlay";
import PanelHeader from "../common/PanelHeader";
import FieldInspectorFigure from "./FieldInspectorFigure";
import styles from "./MapStage.module.css";
import NetworkGraph from "./NetworkGraph";

type CameraMode = "top" | "tilt";
type DisplayMode = "flow" | "risk";

/** Pointer movement below this, between down and up, counts as a tap rather than a drag. */
const CLICK_MOVE_THRESHOLD_PX = 6;

/** 兩個固定示範定位點：
 *  near — 光復南路（RD_TPE_002）忠孝東路口，距路徑 < 50m，時間軸推到 22:10 後必定觸發「鄰近事件」判定。
 *  far  — 敦化南路二段（RD_TPE_012）南端，地圖西南角邊緣，距所有進行中事件 > 2km，觸發「遠離事件」文案。 */
const DEMO_LOCATIONS = {
  near: { lng: 121.5576, lat: 25.0413 },
  far: { lng: 121.5486, lat: 25.021 },
} as const;

export default function MapStage() {
  const segments = useAppStore((s) => s.segments);
  const stations = useAppStore((s) => s.stations);
  const viewerMode = useAppStore((s) => s.viewerMode);
  const roadPaths = useAppStore((s) => s.roadPaths);
  const stationCoords = useAppStore((s) => s.stationCoords);
  const mapCenter = useAppStore((s) => s.mapCenter);
  const mapExpanded = useAppStore((s) => s.mapExpanded);
  const toggleMapExpanded = useAppStore((s) => s.toggleMapExpanded);
  const selectedId = useAppStore((s) => s.selectedSegmentId);
  const setSelectedSegment = useAppStore((s) => s.setSelectedSegment);
  const selectedStationId = useAppStore((s) => s.selectedStationId);
  const setSelectedStation = useAppStore((s) => s.setSelectedStation);
  const fieldInspectorPosition = useAppStore((s) => s.fieldInspectorPosition);
  const setFieldInspectorPosition = useAppStore(
    (s) => s.setFieldInspectorPosition,
  );
  const { language } = useLanguage();
  const [cameraMode, setCameraMode] = useState<CameraMode>("tilt");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("flow");
  const [isDragging, setIsDragging] = useState(false);
  const dragGhostRef = useRef<HTMLDivElement>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragLatestPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const dragStartPointRef = useRef<{ x: number; y: number } | null>(null);
  // Mirrors store state into a ref so the pointerup handler (registered once
  // per drag session, not re-subscribed per pixel) can read the latest value
  // without pulling fieldInspectorPosition into that effect's deps.
  const fieldInspectorPositionRef = useRef(fieldInspectorPosition);

  useEffect(() => {
    fieldInspectorPositionRef.current = fieldInspectorPosition;
  }, [fieldInspectorPosition]);

  useEffect(() => {
    setDisplayMode(viewerMode === "public" ? "risk" : "flow");
    setSelectedSegment(null);
  }, [viewerMode, setSelectedSegment]);

  const segmentList = useMemo(() => Object.values(segments), [segments]);
  const stationList = useMemo(() => Object.values(stations), [stations]);
  const cameraClass =
    cameraMode === "top" ? styles.cameraTop : styles.cameraTilt;

  const handleSegmentClick = useCallback(
    (id: string) => setSelectedSegment(id === selectedId ? null : id),
    [selectedId, setSelectedSegment],
  );
  const handleStationClick = useCallback(
    (id: string) => setSelectedStation(id === selectedStationId ? null : id),
    [selectedStationId, setSelectedStation],
  );

  const moveDragGhost = useCallback((x: number, y: number) => {
    dragLatestPointRef.current = { x, y };
    if (dragFrameRef.current !== null) return;

    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const point = dragLatestPointRef.current;
      if (!point || !dragGhostRef.current) return;
      dragGhostRef.current.style.transform = `translate3d(${point.x}px, ${point.y}px, 0) translate(-50%, -50%)`;
    });
  }, []);

  // Listeners are (re)subscribed only when a drag session starts/ends, not on
  // every pointermove — re-subscribing per pixel of movement was causing the
  // stutter/stuck feeling while carrying the field-inspector figure across
  // the screen, since it also forced the whole map+deck.gl tree to re-render.
  useEffect(() => {
    if (!isDragging) return;
    const initialPoint = dragLatestPointRef.current;
    if (initialPoint) moveDragGhost(initialPoint.x, initialPoint.y);

    const handlePointerMove = (event: PointerEvent) => {
      if (
        dragPointerIdRef.current !== null &&
        event.pointerId !== dragPointerIdRef.current
      )
        return;
      moveDragGhost(event.clientX, event.clientY);
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (
        dragPointerIdRef.current !== null &&
        event.pointerId !== dragPointerIdRef.current
      )
        return;
      setIsDragging(false);
      dragPointerIdRef.current = null;
      dragLatestPointRef.current = null;

      const start = dragStartPointRef.current;
      dragStartPointRef.current = null;
      const movedDistance = start
        ? Math.hypot(event.clientX - start.x, event.clientY - start.y)
        : Number.POSITIVE_INFINITY;

      // A tap (negligible movement) toggles removal of an already-placed
      // figure — the "recycle" gesture — instead of dropping a new one on
      // top of the toolbar button. A real drag still places/repositions it.
      if (movedDistance < CLICK_MOVE_THRESHOLD_PX) {
        if (fieldInspectorPositionRef.current) setFieldInspectorPosition(null);
        return;
      }

      window.dispatchEvent(
        new CustomEvent("field-inspection-drop", {
          detail: { clientX: event.clientX, clientY: event.clientY },
        }),
      );
    };

    // A pointercancel (touch scroll takeover, OS gesture, stylus hover loss)
    // or the window losing focus (alt-tab, devtools) never fires pointerup —
    // without this the drag would stay "stuck" active until a stray pointerup
    // happened to land somewhere, which is what made it feel unresponsive.
    const abortDrag = () => {
      setIsDragging(false);
      dragPointerIdRef.current = null;
      dragLatestPointRef.current = null;
      dragStartPointRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", abortDrag, { once: true });
    window.addEventListener("blur", abortDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", abortDrag);
      window.removeEventListener("blur", abortDrag);
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
    };
  }, [isDragging, moveDragGhost, setFieldInspectorPosition]);

  return (
    <div className={styles.wrap}>
      <PanelHeader
        icon={MapIcon}
        title={pick(language, "即時地圖", "Live Map")}
        expanded={mapExpanded}
        onToggleExpand={toggleMapExpanded}
      />
      <div className={styles.graphArea}>
        <div className={styles.layerControls} aria-label="Map view controls">
          <button
            type="button"
            className={
              cameraMode === "top" ? styles.activeIconBtn : styles.iconBtn
            }
            title="Top view"
            aria-label="Top view"
            onClick={() => setCameraMode("top")}
          >
            <Layers size={17} />
          </button>
          <button
            type="button"
            className={
              cameraMode === "tilt" ? styles.activeIconBtn : styles.iconBtn
            }
            title="Tilted 3D view"
            aria-label="Tilted 3D view"
            onClick={() => setCameraMode("tilt")}
          >
            <Box size={17} />
          </button>
          <button
            type="button"
            className={[
              isDragging ? styles.activePegmanBtn : styles.pegmanBtn,
              fieldInspectorPosition && !isDragging
                ? styles.pegmanBtnPlaced
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={
              fieldInspectorPosition
                ? "Click to remove field inspector, drag to reposition"
                : "Drag field inspector to map"
            }
            aria-label={
              fieldInspectorPosition
                ? "Remove field inspector from map"
                : "Drag field inspector to map"
            }
            onPointerDown={(event) => {
              event.preventDefault();
              dragPointerIdRef.current = event.pointerId;
              dragStartPointRef.current = {
                x: event.clientX,
                y: event.clientY,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              moveDragGhost(event.clientX, event.clientY);
              setIsDragging(true);
            }}
          >
            <span className={styles.pegmanIcon} aria-hidden="true">
              <FieldInspectorFigure size={23} animated={false} />
            </span>
          </button>
        </div>

        {isDragging && (
          <div
            ref={dragGhostRef}
            className={styles.dragGhost}
            aria-hidden="true"
          >
            <FieldInspectorFigure size={46} walking />
          </div>
        )}

        <div className={`${styles.camera} ${cameraClass}`}>
          <NetworkGraph
            segments={segmentList}
            stations={stationList}
            onSegmentClick={handleSegmentClick}
            onStationClick={handleStationClick}
            selectedSegmentId={selectedId}
            selectedStationId={selectedStationId}
            displayMode={displayMode}
            cameraMode={cameraMode}
            roadPaths={roadPaths}
            stationCoords={stationCoords}
            mapCenter={mapCenter}
            viewerMode={viewerMode}
            language={language}
            pauseAnimation={isDragging}
          />
        </div>

        <div className={styles.bottomOverlay}>
          <div className={styles.displayToggle}>
            <span
              className={
                displayMode === "flow"
                  ? `${styles.toggleLabel} ${styles.toggleLabelActive}`
                  : styles.toggleLabel
              }
            >
              {viewerMode === "public" ? "Hexagons" : "Hexagons"}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={displayMode === "risk"}
              aria-label={
                viewerMode === "public"
                  ? "Toggle advisory view"
                  : "Toggle risk view"
              }
              className={styles.switch}
              onClick={() =>
                setDisplayMode(displayMode === "risk" ? "flow" : "risk")
              }
            >
              <span className={styles.switchKnob} />
            </button>
            <span
              className={
                displayMode === "risk"
                  ? `${styles.toggleLabel} ${styles.toggleLabelActive}`
                  : styles.toggleLabel
              }
            ></span>
          </div>
        </div>

        <AlertOverlay />
      </div>
    </div>
  );
}

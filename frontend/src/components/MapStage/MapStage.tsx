import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Layers, Map as MapIcon, PersonStanding } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import PanelHeader from "../common/PanelHeader";
import AlertOverlay from "../AlertOverlay/AlertOverlay";
import NetworkGraph from "./NetworkGraph";
import SegmentCard from "./SegmentCard";
import styles from "./MapStage.module.css";

type CameraMode = "top" | "tilt";
type DisplayMode = "flow" | "risk";

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
  const { language } = useLanguage();
  const [cameraMode, setCameraMode] = useState<CameraMode>("tilt");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("flow");
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    setDisplayMode(viewerMode === "public" ? "risk" : "flow");
    setSelectedSegment(null);
  }, [viewerMode, setSelectedSegment]);

  const segmentList = useMemo(() => Object.values(segments), [segments]);
  const stationList = useMemo(() => Object.values(stations), [stations]);
  const selected = selectedId ? segments[selectedId] : null;
  const cameraClass = cameraMode === "top" ? styles.cameraTop : styles.cameraTilt;

  const handleSegmentClick = useCallback(
    (id: string) => setSelectedSegment(id === selectedId ? null : id),
    [selectedId, setSelectedSegment],
  );
  const handleStationClick = useCallback(
    (id: string) => setSelectedStation(id === selectedStationId ? null : id),
    [selectedStationId, setSelectedStation],
  );

  // Listeners are (re)subscribed only when a drag session starts/ends, not on
  // every pointermove — re-subscribing per pixel of movement was causing the
  // stutter/stuck feeling while carrying the field-inspector figure across
  // the screen, since it also forced the whole map+deck.gl tree to re-render.
  useEffect(() => {
    if (!isDragging) return;

    const handlePointerMove = (event: PointerEvent) => {
      setDragPoint({ x: event.clientX, y: event.clientY });
    };

    const handlePointerUp = (event: PointerEvent) => {
      setIsDragging(false);
      setDragPoint(null);
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
      setDragPoint(null);
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
    };
  }, [isDragging]);

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
            className={cameraMode === "top" ? styles.activeIconBtn : styles.iconBtn}
            title="Top view"
            aria-label="Top view"
            onClick={() => setCameraMode("top")}
          >
            <Layers size={17} />
          </button>
          <button
            type="button"
            className={cameraMode === "tilt" ? styles.activeIconBtn : styles.iconBtn}
            title="Tilted 3D view"
            aria-label="Tilted 3D view"
            onClick={() => setCameraMode("tilt")}
          >
            <Box size={17} />
          </button>
          <button
            type="button"
            className={dragPoint ? styles.activePegmanBtn : styles.pegmanBtn}
            title="Drag field inspector to map"
            aria-label="Drag field inspector to map"
            onPointerDown={(event) => {
              event.preventDefault();
              setDragPoint({ x: event.clientX, y: event.clientY });
              setIsDragging(true);
            }}
          >
            <PersonStanding size={19} />
          </button>
        </div>

        {dragPoint && (
          <div
            className={styles.dragGhost}
            style={{ left: dragPoint.x, top: dragPoint.y }}
            aria-hidden="true"
          >
            <PersonStanding size={28} />
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
          />
        </div>

        <div className={styles.bottomOverlay}>
          <div className={styles.displayToggle} aria-label="Display mode">
            <button
              type="button"
              className={displayMode === "flow" ? styles.activeMode : styles.mode}
              onClick={() => setDisplayMode("flow")}
            >
              {viewerMode === "public" ? "Routes" : "Flow"}
            </button>
            <button
              type="button"
              className={displayMode === "risk" ? styles.activeMode : styles.mode}
              onClick={() => setDisplayMode("risk")}
            >
              {viewerMode === "public" ? "Advisory" : "Risk"}
            </button>
          </div>
        </div>

        {viewerMode === "government" && selected && <SegmentCard segment={selected} onClose={() => setSelectedSegment(null)} />}

        <AlertOverlay />
      </div>
    </div>
  );
}

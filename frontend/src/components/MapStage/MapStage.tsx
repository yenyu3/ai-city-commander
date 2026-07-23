import { useEffect, useState } from "react";
import { Box, Layers, Maximize2, Minimize2 } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { pick, useLanguage } from "../../i18n";
import NetworkGraph from "./NetworkGraph";
import SegmentCard from "./SegmentCard";
import IncidentInjectButton from "./IncidentInjectButton";
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
  const focusZone = useAppStore((s) => s.focusZone);
  const toggleFocusZone = useAppStore((s) => s.toggleFocusZone);
  const { language } = useLanguage();
  const isFocused = focusZone === "center";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>("tilt");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("flow");

  useEffect(() => {
    setDisplayMode(viewerMode === "public" ? "risk" : "flow");
    setSelectedId(null);
  }, [viewerMode]);

  const segmentList = Object.values(segments);
  const selected = selectedId ? segments[selectedId] : null;
  const cameraClass = cameraMode === "top" ? styles.cameraTop : styles.cameraTilt;

  return (
    <div className={styles.wrap}>
      <div className={styles.graphArea}>
        <div className={styles.stageHeader}>
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.expandBtn}`}
            aria-pressed={isFocused}
            title={isFocused ? pick(language, "還原版面", "Restore layout") : pick(language, "放大地圖區域", "Expand map")}
            onClick={() => toggleFocusZone("center")}
          >
            {isFocused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>

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
        </div>

        <div className={`${styles.camera} ${cameraClass}`}>
          <NetworkGraph
            segments={segmentList}
            stations={Object.values(stations)}
            onSegmentClick={(id) => setSelectedId(id === selectedId ? null : id)}
            selectedSegmentId={selectedId}
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

        {viewerMode === "government" && selected && <SegmentCard segment={selected} onClose={() => setSelectedId(null)} />}
      </div>
      {viewerMode === "government" && !isFocused && (
        <div className={styles.controls}>
          <IncidentInjectButton />
        </div>
      )}
    </div>
  );
}

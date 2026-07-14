import { useState } from "react";
import { Box, Layers, RotateCcw, RotateCw, Route } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import NetworkGraph from "./NetworkGraph";
import SegmentCard from "./SegmentCard";
import TimeFilter from "./TimeFilter";
import IncidentInjectButton from "./IncidentInjectButton";
import styles from "./MapStage.module.css";

type CameraMode = "top" | "tilt" | "street";
type DisplayMode = "flow" | "risk";

export default function MapStage() {
  const segments = useAppStore((s) => s.segments);
  const stations = useAppStore((s) => s.stations);
  const alerts = useAppStore((s) => s.alerts);
  const roadPaths = useAppStore((s) => s.roadPaths);
  const stationCoords = useAppStore((s) => s.stationCoords);
  const mapCenter = useAppStore((s) => s.mapCenter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>("tilt");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("flow");

  const segmentList = Object.values(segments);
  const selected = selectedId ? segments[selectedId] : null;
  const criticalCount = segmentList.filter((segment) => segment.tier === "A").length;
  const flowCount = segmentList.reduce((sum, segment) => sum + segment.vehicleCount, 0);

  const cameraClass =
    cameraMode === "street"
      ? styles.cameraStreet
      : cameraMode === "top"
        ? styles.cameraTop
        : styles.cameraTilt;

  return (
    <div className={styles.wrap}>
      <div className={styles.graphArea}>
        <div className={styles.stageHeader}>
          <div className={styles.stats}>
            <span>{segmentList.length} roads</span>
            <span>{criticalCount} critical</span>
            <span>{flowCount.toLocaleString()} vehicles</span>
          </div>
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
          <button
            type="button"
            className={cameraMode === "street" ? styles.activeIconBtn : styles.iconBtn}
            title="Street-level angle"
            aria-label="Street-level angle"
            onClick={() => setCameraMode("street")}
          >
            <Route size={17} />
          </button>
        </div>

        <div className={styles.rotateControls} aria-label="Map rotation controls">
          <button
            type="button"
            className={styles.iconBtn}
            title="Rotate counterclockwise"
            aria-label="Rotate counterclockwise"
            onClick={() => setCameraMode(cameraMode === "street" ? "tilt" : "street")}
          >
            <RotateCcw size={17} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            title="Rotate clockwise"
            aria-label="Rotate clockwise"
            onClick={() => setCameraMode(cameraMode === "top" ? "tilt" : "top")}
          >
            <RotateCw size={17} />
          </button>
        </div>

        <div className={styles.displayToggle} aria-label="Display mode">
          <button
            type="button"
            className={displayMode === "flow" ? styles.activeMode : styles.mode}
            onClick={() => setDisplayMode("flow")}
          >
            Flow
          </button>
          <button
            type="button"
            className={displayMode === "risk" ? styles.activeMode : styles.mode}
            onClick={() => setDisplayMode("risk")}
          >
            Risk
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
          />
        </div>

        <div className={styles.storyBadge}>
          <span>Active SOP</span>
          <strong>{alerts[0]?.sopRef ?? "Monitoring"}</strong>
          <p>{alerts[0]?.title ?? "No emergency clause triggered"}</p>
        </div>

        {selected && (
          <SegmentCard segment={selected} onClose={() => setSelectedId(null)} />
        )}
      </div>
      <div className={styles.controls}>
        <IncidentInjectButton />
        <TimeFilter />
      </div>
    </div>
  );
}

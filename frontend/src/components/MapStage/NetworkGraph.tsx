import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttributionControl, Map, useControl, type MapRef } from "react-map-gl/mapbox";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Map as MapboxMap } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  AmbientLight,
  DirectionalLight,
  LightingEffect,
  type Color,
  type Layer,
  type PickingInfo,
  type Position,
} from "@deck.gl/core";
import { PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { HexagonLayer } from "@deck.gl/aggregation-layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { withElevation } from "./geometry";
import type { SegmentRuntimeState, StationRuntimeState } from "../../store/appStore";
import type { RoadPathDef, ViewerMode } from "../../types";
import { pick, type Language } from "../../i18n";
import styles from "./NetworkGraph.module.css";

type CameraMode = "top" | "tilt" | "street";
type DisplayMode = "flow" | "risk";

export interface NetworkGraphProps {
  segments: SegmentRuntimeState[];
  stations: StationRuntimeState[];
  onSegmentClick: (segmentId: string) => void;
  selectedSegmentId?: string | null;
  displayMode?: DisplayMode;
  cameraMode?: CameraMode;
  roadPaths: Map<string, RoadPathDef>;
  stationCoords: Record<string, [number, number]>;
  mapCenter: [number, number];
  viewerMode: ViewerMode;
  language: Language;
}

function roadRiskLabel(tier: string, language: Language): string {
  if (tier === "A") return pick(language, "建議避開", "Avoid");
  if (tier === "B") return pick(language, "可能延誤", "Expect delay");
  return pick(language, "暢通", "Open");
}

function crowdLabel(userCount: number, language: Language): string {
  if (userCount >= 20000) return pick(language, "人潮較多", "Busy");
  return pick(language, "人潮正常", "Normal");
}

interface RoadPath {
  segmentId: string;
  name: string;
  path: Position[];
  dashed: boolean;
  saturation: number;
  vehicleCount: number;
  tier: string;
  isCityTrigger: boolean;
  isEvacuationMain: boolean;
  isEvacuationSecondary: boolean;
  isIncidentSource: boolean;
}

interface StationPoint {
  stationId: string;
  name: string;
  position: Position;
  userCount: number;
  growthRate: number;
  roamingPct: number;
}

interface FlowProbe {
  id: string;
  segmentId: string;
  roadName: string;
  position: Position;
  tone: "cyan" | "white" | "blue";
  role: string;
  status: string;
  action: string;
  vehicleCount: number;
  saturation: number;
}

interface HeatPoint {
  position: Position;
  weight: number;
}

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
const MAP_STYLE = "mapbox://styles/mapbox/dark-v11";

const VIEWS: Record<CameraMode, { pitch: number; bearing: number; zoom: number }> = {
  top: { pitch: 0, bearing: 0, zoom: 15.4 },
  tilt: { pitch: 55, bearing: -22, zoom: 16.2 },
  street: { pitch: 72, bearing: 28, zoom: 17 },
};

const ambientLight = new AmbientLight({
  color: [255, 255, 255],
  intensity: 0.75,
});

const directionalLight = new DirectionalLight({
  color: [210, 225, 245],
  intensity: 1.55,
  direction: [-3, -4, -8],
});

const lightingEffect = new LightingEffect({ ambientLight, directionalLight });

function tierColor(road: RoadPath): Color {
  if (road.isIncidentSource) return [232, 91, 108, 235];
  if (road.isEvacuationMain) return [190, 236, 255, 255];
  if (road.isEvacuationSecondary) return [232, 197, 112, 235];
  if (road.tier === "A") return [232, 91, 108, 225];
  if (road.tier === "B") return [228, 169, 78, 225];
  return [120, 170, 190, 205];
}

/** Evenly samples `count` points along an arbitrary-length real polyline. */
function samplePath(path: Position[], count: number): Position[] {
  if (path.length === 1) return Array.from({ length: count }, () => path[0]);
  const cumulative: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    const [x1, y1] = path[i - 1];
    const [x2, y2] = path[i];
    cumulative.push(cumulative[i - 1] + Math.hypot(x2 - x1, y2 - y1));
  }
  const total = cumulative[cumulative.length - 1];
  const points: Position[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const target = t * total;
    let idx = cumulative.findIndex((c) => c >= target);
    if (idx <= 0) idx = 1;
    const segStart = cumulative[idx - 1];
    const segEnd = cumulative[idx];
    const localT = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
    const a = path[idx - 1];
    const b = path[idx];
    points.push([
      a[0] + (b[0] - a[0]) * localT,
      a[1] + (b[1] - a[1]) * localT,
      (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * localT,
    ]);
  }
  return points;
}

function makeFlowProbes(roads: RoadPath[]): FlowProbe[] {
  return roads.flatMap((road, roadIndex) =>
    samplePath(road.path, 4).map((position, pointIndex) => ({
      id: `${road.segmentId}-probe-${pointIndex}`,
      segmentId: road.segmentId,
      roadName: road.name,
      position: [
        position[0] + Math.sin((roadIndex + pointIndex) * 1.7) * 0.00022,
        position[1] + Math.cos((roadIndex + pointIndex) * 1.3) * 0.00018,
        34 + pointIndex * 3,
      ],
      tone: pointIndex % 5 === 0 ? "white" : pointIndex % 3 === 0 ? "cyan" : "blue",
      role: road.isIncidentSource
        ? "Incident response node"
        : road.isEvacuationMain
          ? "Primary evacuation flow"
          : road.isEvacuationSecondary
            ? "Secondary diversion flow"
            : "Traffic sensing node",
      status: road.isIncidentSource
        ? "Critical segment under control"
        : road.saturation >= 0.9
          ? "Congestion pressure rising"
          : "Live flow monitored",
      action: road.isIncidentSource
        ? "Close affected lane and route vehicles to alternatives."
        : road.isEvacuationMain
          ? "Keep main dispersal route clear for crowd release."
          : road.isEvacuationSecondary
            ? "Absorb overflow when the primary route reaches threshold."
            : "Continue monitoring speed, volume, and saturation.",
      vehicleCount: road.vehicleCount,
      saturation: road.saturation,
    })),
  );
}

function DeckGLOverlay(props: ConstructorParameters<typeof MapboxOverlay>[0]) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

function addBuildingLayer(map: MapboxMap) {
  if (map.getLayer("3d-buildings")) return;
  const styleLayers = map.getStyle()?.layers ?? [];
  const labelLayerId = styleLayers.find(
    (layer) => layer.type === "symbol" && "text-field" in (layer.layout ?? {}),
  )?.id;
  map.addLayer(
    {
      id: "3d-buildings",
      source: "composite",
      "source-layer": "building",
      filter: ["==", "extrude", "true"],
      type: "fill-extrusion",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": "#3a4048",
        "fill-extrusion-height": ["get", "height"],
        "fill-extrusion-base": ["get", "min_height"],
        "fill-extrusion-opacity": 0.85,
      },
    },
    labelLayerId,
  );
}

export default function NetworkGraph({
  segments,
  stations,
  onSegmentClick,
  selectedSegmentId,
  displayMode = "flow",
  cameraMode = "tilt",
  roadPaths,
  stationCoords,
  mapCenter,
  viewerMode,
  language,
}: NetworkGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapRef>(null);
  const [currentTime, setCurrentTime] = useState(34);
  const [activeProbe, setActiveProbe] = useState<FlowProbe | null>(null);

  useEffect(() => {
    let frame = 0;
    let raf = 0;
    const tick = () => {
      frame = (frame + 0.36) % 100;
      setCurrentTime(frame);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const view = VIEWS[cameraMode];
    map.easeTo({
      center: mapCenter,
      zoom: view.zoom,
      pitch: view.pitch,
      bearing: view.bearing,
      duration: 900,
    });
  }, [cameraMode, mapCenter]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const resize = () => {
      window.requestAnimationFrame(() => mapRef.current?.getMap().resize());
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const handleLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (map) addBuildingLayer(map);
  }, []);

  const roads = useMemo<RoadPath[]>(() => {
    const list: RoadPath[] = [];
    for (const runtime of segments) {
      const def = roadPaths.get(runtime.segmentId);
      if (!def) continue;
      list.push({
        segmentId: runtime.segmentId,
        name: runtime.name,
        path: withElevation(def.path),
        dashed: def.dashed,
        saturation: runtime.saturation,
        vehicleCount: runtime.vehicleCount,
        tier: runtime.tier,
        isCityTrigger: runtime.isCityTrigger,
        isEvacuationMain: runtime.isEvacuationMain,
        isEvacuationSecondary: runtime.isEvacuationSecondary,
        isIncidentSource: runtime.isIncidentSource,
      });
    }
    return list;
  }, [segments, roadPaths]);

  const stationPoints = useMemo<StationPoint[]>(
    () =>
      stations.flatMap((station) => {
        const position = stationCoords[station.stationId];
        if (!position) return [];
        return [
          {
            stationId: station.stationId,
            name: station.name,
            position: [position[0], position[1], 42],
            userCount: station.userCount,
            growthRate: station.growthRate,
            roamingPct: station.roamingPct,
          },
        ];
      }),
    [stations, stationCoords],
  );

  const flowProbes = useMemo(() => makeFlowProbes(roads), [roads]);

  const heatPoints = useMemo<HeatPoint[]>(
    () => [
      ...roads.flatMap((road) =>
        samplePath(road.path, 8).map((position) => ({
          position,
          weight: 1 + road.saturation * 5 + (road.isIncidentSource ? 8 : 0),
        })),
      ),
      ...stationPoints.map((station) => ({
        position: station.position,
        weight: Math.max(1, station.userCount / 4200),
      })),
    ],
    [roads, stationPoints],
  );

  const maxVehicleCount = Math.max(1, ...roads.map((road) => road.vehicleCount));

  const layers = useMemo<Layer[]>(() => {
    const routeLayers: Layer[] = [
      new PathLayer<RoadPath>({
        id: "road-base",
        data: roads,
        getColor: [66, 76, 92, 185],
        getPath: (road) => road.path,
        getWidth: (road) => 18 + (road.vehicleCount / maxVehicleCount) * 18,
        jointRounded: true,
        capRounded: true,
        widthMinPixels: 5,
        pickable: false,
      }),
      new TripsLayer<RoadPath>({
        id: "traffic-trips",
        data: roads.filter((road) => !road.isIncidentSource),
        getColor: tierColor,
        getPath: (road) => road.path,
        getTimestamps: () => [0, 48, 100],
        getWidth: (road) =>
          road.isEvacuationMain ? 7 : road.isEvacuationSecondary ? 5 : 3.5,
        currentTime,
        trailLength: 26,
        fadeTrail: true,
        capRounded: true,
        jointRounded: true,
        widthMinPixels: 2,
        opacity: displayMode === "flow" ? 0.94 : 0.42,
        pickable: false,
      }),
      new PathLayer<RoadPath>({
        id: "selected-and-status-routes",
        data: roads,
        getColor: (road) =>
          selectedSegmentId === road.segmentId
            ? [255, 255, 255, 255]
            : tierColor(road),
        getPath: (road) => road.path,
        getWidth: (road) =>
          selectedSegmentId === road.segmentId
            ? 9
            : road.isIncidentSource
              ? 8
              : road.isEvacuationMain
                ? 7
                : road.isEvacuationSecondary
                  ? 5
                  : 2.5,
        opacity: 0.92,
        capRounded: true,
        jointRounded: true,
        widthMinPixels: 2,
        pickable: true,
        onClick: ({ object }) => {
          if (object) onSegmentClick(object.segmentId);
        },
      }),
      new ScatterplotLayer<StationPoint>({
        id: "station-glow",
        data: stationPoints,
        getFillColor: (station) =>
          station.roamingPct >= 0.3 ? [180, 255, 244, 132] : [138, 205, 255, 104],
        getLineColor: [255, 255, 255, 145],
        getLineWidth: 2,
        getPosition: (station) => station.position,
        getRadius: (station) => 58 + Math.min(130, station.userCount / 165),
        lineWidthMinPixels: 1,
        opacity: 0.75,
        pickable: true,
        radiusMinPixels: 10,
        stroked: true,
      }),
      new TextLayer<RoadPath | StationPoint>({
        id: "map-labels",
        data: [...roads.filter((road) => road.isCityTrigger || road.isIncidentSource), ...stationPoints],
        characterSet: "auto",
        fontFamily: "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif",
        getColor: [230, 238, 245, 150],
        getPosition: (item) => ("path" in item ? item.path[Math.floor(item.path.length / 2)] : item.position),
        getSize: (item) => ("path" in item ? 11 : 12),
        getText: (item) => item.name,
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
        background: true,
        getBackgroundColor: [8, 10, 13, 115],
        backgroundPadding: [4, 2],
        billboard: false,
      }),
    ];

    if (displayMode === "risk") {
      routeLayers.splice(
        1,
        0,
        new HexagonLayer<HeatPoint>({
          id: "risk-hexagons",
          data: heatPoints,
          getPosition: (point) => point.position,
          getColorWeight: (point) => point.weight,
          getElevationWeight: (point) => point.weight,
          colorRange: [
            [64, 48, 118, 52],
            [88, 62, 144, 78],
            [130, 88, 158, 104],
            [174, 120, 164, 132],
            [219, 176, 190, 166],
            [247, 237, 235, 210],
          ],
          elevationRange: [0, 90],
          elevationScale: cameraMode === "top" ? 0 : 2.4,
          extruded: cameraMode !== "top",
          opacity: 0.72,
          radius: 190,
          coverage: 0.9,
          pickable: false,
        }),
      );
    }

    if (viewerMode === "government" && (cameraMode === "street" || displayMode === "flow")) {
      routeLayers.push(
        new ScatterplotLayer<FlowProbe>({
          id: "flow-probes",
          data: flowProbes,
          getFillColor: (probe) =>
            probe.tone === "white"
              ? [255, 255, 255, 220]
              : probe.tone === "cyan"
                ? [170, 255, 245, 175]
                : [126, 178, 255, 150],
          getLineColor: [255, 255, 255, 64],
          getLineWidth: 1,
          getPosition: (probe) => probe.position,
          getRadius: (probe) => (probe.tone === "white" ? 42 : 34),
          opacity: 0.86,
          pickable: true,
          radiusMinPixels: 5,
          radiusMaxPixels: 18,
          stroked: true,
          onClick: ({ object }) => {
            if (object) setActiveProbe(object);
          },
        }),
      );
    }

    return routeLayers;
  }, [
    cameraMode,
    currentTime,
    displayMode,
    flowProbes,
    heatPoints,
    maxVehicleCount,
    onSegmentClick,
    roads,
    selectedSegmentId,
    stationPoints,
    viewerMode,
  ]);

  const tooltip = ({ object, layer }: PickingInfo) => {
    if (!object || !layer) return null;
    if (layer.id === "selected-and-status-routes") {
      const road = object as RoadPath;
      if (viewerMode === "public") {
        return { text: `${road.name}\n${roadRiskLabel(road.tier, language)}` };
      }
      return {
        text: `${road.name}\nSaturation ${road.saturation.toFixed(2)}\n${road.vehicleCount.toLocaleString()} vehicles`,
      };
    }
    if (layer.id === "station-glow") {
      const station = object as StationPoint;
      if (viewerMode === "public") {
        return { text: `${station.name}\n${crowdLabel(station.userCount, language)}` };
      }
      return {
        text: `${station.name}\n${station.userCount.toLocaleString()} users\nGrowth ${(station.growthRate * 100).toFixed(0)}%`,
      };
    }
    return null;
  };

  if (!MAPBOX_TOKEN) {
    return (
      <div className={styles.mapShell}>
        <div className={styles.tokenMissing}>
          <strong>需要 Mapbox Access Token</strong>
          <p>請在專案根目錄的 .env.local 設定 VITE_MAPBOX_TOKEN，並重新啟動開發伺服器。</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.mapShell} ref={containerRef}>
      <Map
        ref={mapRef}
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={{
          longitude: mapCenter[0],
          latitude: mapCenter[1],
          zoom: VIEWS[cameraMode].zoom,
          pitch: VIEWS[cameraMode].pitch,
          bearing: VIEWS[cameraMode].bearing,
        }}
        mapStyle={MAP_STYLE}
        onLoad={handleLoad}
        attributionControl={false}
        cooperativeGestures
      >
        <AttributionControl compact position="bottom-right" />
        <DeckGLOverlay
          interleaved
          effects={[lightingEffect]}
          layers={layers}
          getTooltip={tooltip}
          onClick={(info: PickingInfo) => {
            if (!info.object) setActiveProbe(null);
          }}
        />
      </Map>
      <div className={styles.vignette} />
      <div className={styles.legend} aria-hidden="true">
        <span>Low</span>
        <i />
        <span>High</span>
      </div>
      {activeProbe && (
        <div className={styles.agentPopup}>
          <div className={styles.agentHeader}>
            <span className={styles.avatar}>S</span>
            <div>
              <strong>{activeProbe.role}</strong>
              <p>{activeProbe.action}</p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Road</dt>
              <dd>{activeProbe.roadName}</dd>
            </div>
            <div>
              <dt>Segment</dt>
              <dd>{activeProbe.segmentId}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{activeProbe.status}</dd>
            </div>
            <div>
              <dt>Saturation</dt>
              <dd>{activeProbe.saturation.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Vehicles</dt>
              <dd>{activeProbe.vehicleCount.toLocaleString()}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

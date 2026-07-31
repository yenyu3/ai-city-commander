import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttributionControl, Map, Marker, useControl, type MapRef } from "react-map-gl/mapbox";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { ExpressionSpecification, Map as MapboxMap } from "mapbox-gl";
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
import { PathLayer, TextLayer } from "@deck.gl/layers";
import { HexagonLayer } from "@deck.gl/aggregation-layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { AlertTriangle } from "lucide-react";
import { withElevation } from "./geometry";
import { useAppStore, type SegmentRuntimeState, type StationRuntimeState } from "../../store/appStore";
import type { RoadPathDef, ViewerMode } from "../../types";
import { pick, type Language } from "../../i18n";
import { pathMidpoint } from "../../utils/geoDistance";
import FieldInspectorFigure from "./FieldInspectorFigure";
import styles from "./NetworkGraph.module.css";

type CameraMode = "top" | "tilt";
type DisplayMode = "flow" | "risk";

export interface NetworkGraphProps {
  segments: SegmentRuntimeState[];
  stations: StationRuntimeState[];
  onSegmentClick: (segmentId: string) => void;
  onStationClick?: (stationId: string) => void;
  selectedSegmentId?: string | null;
  selectedStationId?: string | null;
  displayMode?: DisplayMode;
  cameraMode?: CameraMode;
  roadPaths: Map<string, RoadPathDef>;
  stationCoords: Record<string, [number, number]>;
  mapCenter: [number, number];
  viewerMode: ViewerMode;
  language: Language;
  pauseAnimation?: boolean;
}

function roadRiskLabel(tier: string, language: Language): string {
  if (tier === "A") return pick(language, "建議避開", "Avoid");
  if (tier === "B") return pick(language, "可能延誤", "Expect delay");
  return pick(language, "暢通", "Open");
}

/** Maps each crowd-monitoring base station to the /public/icon asset for its real-world category. */
const STATION_ICON_CATEGORY: Record<string, string> = {
  BS_MRT_BL16: "metro",
  BS_MRT_BL17: "metro",
  BS_MRT_BL18: "metro",
  BS_TPE_DOME: "bigegg",
  BS_BUS_TERM: "bus",
  BS_XY_VIESHOW: "shopping-center",
  BS_XY_ATT: "shopping-center",
  BS_TPE_101: "taipei-101",
  BS_SS_PARK: "park",
};

function stationIconSrc(stationId: string): string {
  return `/icon/${STATION_ICON_CATEGORY[stationId] ?? "metro"}.png`;
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

interface HeatPoint {
  position: Position;
  weight: number;
}

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
const MAP_STYLE = "mapbox://styles/mapbox/dark-v11";

const VIEWS: Record<CameraMode, { pitch: number; bearing: number; zoom: number }> = {
  top: { pitch: 0, bearing: 0, zoom: 15.4 },
  tilt: { pitch: 55, bearing: -22, zoom: 16.2 },
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

function DeckGLOverlay(props: ConstructorParameters<typeof MapboxOverlay>[0]) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

function positionDistance(a: Position, b: Position): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function findNearestRoad(position: Position, roads: RoadPath[]): RoadPath | null {
  let nearest: RoadPath | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const road of roads) {
    for (const sample of samplePath(road.path, 12)) {
      const distance = positionDistance(position, sample);
      if (distance < nearestDistance) {
        nearest = road;
        nearestDistance = distance;
      }
    }
  }

  return nearest;
}

function applyLabelLanguage(map: MapboxMap, language: Language) {
  const field: ExpressionSpecification =
    language === "en"
      ? ["coalesce", ["get", "name_en"], ["get", "name"]]
      : ["coalesce", ["get", "name_zh-Hant"], ["get", "name_zh"], ["get", "name"]];
  const styleLayers = map.getStyle()?.layers ?? [];
  for (const layer of styleLayers) {
    if (layer.type !== "symbol" || !("text-field" in (layer.layout ?? {}))) continue;
    map.setLayoutProperty(layer.id, "text-field", field);
  }
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

function NetworkGraph({
  segments,
  stations,
  onSegmentClick,
  onStationClick,
  selectedSegmentId,
  selectedStationId,
  displayMode = "flow",
  cameraMode = "tilt",
  roadPaths,
  stationCoords,
  mapCenter,
  viewerMode,
  language,
  pauseAnimation = false,
}: NetworkGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapRef>(null);
  const [currentTime, setCurrentTime] = useState(34);
  const [isMarkerDragging, setIsMarkerDragging] = useState(false);
  // Bumped on every placement/reposition so the figure replays its landing
  // hop each time it's set down, even if it lands on the exact same spot.
  const [placementSeq, setPlacementSeq] = useState(0);
  const fieldInspectorPosition = useAppStore((s) => s.fieldInspectorPosition);
  const setFieldInspectorPosition = useAppStore((s) => s.setFieldInspectorPosition);
  const alerts = useAppStore((s) => s.alerts);

  // 目前尚未解決的注入事件位置——地圖上顯示跳動的警示圖示，表示「此時此地有事件發生中」。
  // RD_ 路段取路徑近似中點，BS_ 站點直接取站點座標。事件一旦解決（resolvedAt 有值）就消失。
  const incidentMarkers = useMemo(() => {
    const result: { id: string; lng: number; lat: number; title: string }[] = [];
    for (const a of alerts) {
      if (a.origin !== "incident" || !a.trackedSegmentId || a.resolvedAt) continue;
      if (a.trackedSegmentId.startsWith("BS_")) {
        const coords = stationCoords[a.trackedSegmentId];
        if (coords) result.push({ id: a.id, lng: coords[0], lat: coords[1], title: a.title });
      } else {
        const path = roadPaths.get(a.trackedSegmentId)?.path;
        if (path && path.length > 0) {
          const [lng, lat] = pathMidpoint(path);
          result.push({ id: a.id, lng, lat, title: a.title });
        }
      }
    }
    return result;
  }, [alerts, roadPaths, stationCoords]);
  const setFieldInspectorLocateStatus = useAppStore((s) => s.setFieldInspectorLocateStatus);
  // Briefly shown once the camera finishes panning to a newly selected
  // segment, so the operator can tell which road on the map just got
  // selected without a label sitting on the map permanently.
  const [flashSegmentId, setFlashSegmentId] = useState<string | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  const [mapZoom, setMapZoom] = useState(VIEWS[cameraMode].zoom);

  useEffect(() => {
    if (pauseAnimation || isMarkerDragging) return;
    let frame = 0;
    let raf = 0;
    const tick = () => {
      frame = (frame + 0.36) % 100;
      setCurrentTime(frame);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isMarkerDragging, pauseAnimation]);

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
    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = null;
    }
    if (!selectedSegmentId) {
      setFlashSegmentId(null);
      return;
    }
    const map = mapRef.current?.getMap();
    const def = roadPaths.get(selectedSegmentId);
    if (!map || !def || def.path.length === 0) return;
    const mid = def.path[Math.floor(def.path.length / 2)];
    map.easeTo({ center: [mid[0], mid[1]], duration: 700 });

    const handleMoveEnd = () => {
      setFlashSegmentId(selectedSegmentId);
      flashTimeoutRef.current = window.setTimeout(() => setFlashSegmentId(null), 1600);
    };
    map.once("moveend", handleMoveEnd);
    return () => {
      map.off("moveend", handleMoveEnd);
    };
  }, [selectedSegmentId, roadPaths]);

  useEffect(() => {
    if (!selectedStationId) return;
    const map = mapRef.current?.getMap();
    const coord = stationCoords[selectedStationId];
    if (!map || !coord) return;
    map.easeTo({ center: [coord[0], coord[1]], duration: 700 });
  }, [selectedStationId, stationCoords]);

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
    if (!map) return;
    addBuildingLayer(map);
    applyLabelLanguage(map, language);
    const onZoom = () => setMapZoom(map.getZoom());
    map.on("zoom", onZoom);
  }, [language]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;
    applyLabelLanguage(map, language);
  }, [language]);

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

  const roadNameCharacterSet = useMemo(
    () => Array.from(new Set(roads.flatMap((road) => Array.from(road.name)))),
    [roads],
  );

  const stationPoints = useMemo<StationPoint[]>(
    () =>
      Object.keys(STATION_ICON_CATEGORY).flatMap((stationId) => {
        const position = stationCoords[stationId];
        if (!position) return [];
        const runtime = stations.find((s) => s.stationId === stationId);
        return [
          {
            stationId,
            name: runtime?.name ?? stationId,
            position: [position[0], position[1], 42],
            userCount: runtime?.userCount ?? 0,
            growthRate: runtime?.growthRate ?? 0,
            roamingPct: runtime?.roamingPct ?? 0,
          },
        ];
      }),
    [stations, stationCoords],
  );

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

  const placeInspectionPoint = useCallback(
    (lng: number, lat: number) => {
      const nearestRoad = findNearestRoad([lng, lat, 58], roads);
      // Position is handed off to the store (not shown as a popup) so the
      // decision-summary panel and, eventually, the backend judgement call
      // can pick it up without interrupting the operator's placement flow.
      // The store is also the single source of truth for the marker itself
      // (see the Marker render below), so the toolbar button can remove it
      // by clearing the store without NetworkGraph needing to know about it.
      setFieldInspectorPosition({
        lng,
        lat,
        nearestRoadId: nearestRoad?.segmentId ?? null,
        nearestRoadName: nearestRoad?.name ?? null,
      });
      setPlacementSeq((seq) => seq + 1);
    },
    [roads, setFieldInspectorPosition],
  );

  // Mirrors `roads` into a ref so the one-shot auto-locate effect below can read the latest
  // value from inside an async geolocation callback without re-running every tick (roads is
  // recomputed on every simulation tick since it carries live saturation/vehicleCount).
  const roadsRef = useRef(roads);
  useEffect(() => {
    roadsRef.current = roads;
  }, [roads]);

  const hasAutoLocatedRef = useRef(false);
  useEffect(() => {
    if (hasAutoLocatedRef.current) return;
    hasAutoLocatedRef.current = true;
    if (fieldInspectorPosition) return;

    if (!("geolocation" in navigator)) {
      setFieldInspectorLocateStatus("unavailable");
      return;
    }

    setFieldInspectorLocateStatus("pending");
    navigator.geolocation.getCurrentPosition(
      (geoPosition) => {
        const point: Position = [geoPosition.coords.longitude, geoPosition.coords.latitude, 58];
        const nearestRoad = findNearestRoad(point, roadsRef.current);
        const nearestDistance = nearestRoad
          ? samplePath(nearestRoad.path, 12).reduce(
              (min, sample) => Math.min(min, positionDistance(point, sample)),
              Number.POSITIVE_INFINITY,
            )
          : Number.POSITIVE_INFINITY;

        // Demo dataset only covers Taipei's city core — a real-world fix that lands far outside
        // it (e.g. testing from another city) shouldn't get snapped to a distant road; treat it
        // the same as "couldn't locate you" so the chatbot falls back to the overall city answer.
        if (!nearestRoad || nearestDistance > 0.05) {
          setFieldInspectorLocateStatus("unavailable");
          return;
        }

        setFieldInspectorPosition({
          lng: geoPosition.coords.longitude,
          lat: geoPosition.coords.latitude,
          nearestRoadId: nearestRoad.segmentId,
          nearestRoadName: nearestRoad.name,
        });
        setPlacementSeq((seq) => seq + 1);
        setFieldInspectorLocateStatus("granted");
      },
      () => setFieldInspectorLocateStatus("denied"),
      { timeout: 8000 },
    );
  }, [fieldInspectorPosition, setFieldInspectorPosition, setFieldInspectorLocateStatus]);

  useEffect(() => {
    const handleInspectionDrop = (event: Event) => {
      const detail = (event as CustomEvent<{ clientX: number; clientY: number }>).detail;
      const map = mapRef.current?.getMap();
      const canvas = map?.getCanvas();
      if (!detail || !map || !canvas) return;

      const rect = canvas.getBoundingClientRect();
      if (
        detail.clientX < rect.left ||
        detail.clientX > rect.right ||
        detail.clientY < rect.top ||
        detail.clientY > rect.bottom
      ) {
        return;
      }

      const lngLat = map.unproject([detail.clientX - rect.left, detail.clientY - rect.top]);
      placeInspectionPoint(lngLat.lng, lngLat.lat);
    };

    window.addEventListener("field-inspection-drop", handleInspectionDrop);
    return () => window.removeEventListener("field-inspection-drop", handleInspectionDrop);
  }, [placeInspectionPoint]);

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
      new TextLayer<RoadPath>({
        id: "map-labels",
        data: roads.filter((road) => road.isCityTrigger || road.isIncidentSource),
        characterSet: "auto",
        fontFamily: "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif",
        getColor: [230, 238, 245, 170],
        getPosition: (road) => road.path[Math.floor(road.path.length / 2)],
        getSize: 11,
        getText: (road) => road.name,
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
        background: true,
        getBackgroundColor: [8, 10, 13, 115],
        backgroundPadding: [4, 2],
        billboard: false,
      }),
      new TextLayer<RoadPath>({
        id: "selection-flash-label",
        data: roads.filter((road) => road.segmentId === flashSegmentId),
        // "auto" only samples characters present in `data` at layer creation;
        // since this layer mounts with empty data (nothing flashing yet), it
        // never sees the label text and its atlas stays empty forever. Seed it
        // from every road name up front so any segment's flash label works.
        characterSet: roadNameCharacterSet,
        fontFamily: "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif",
        getColor: [255, 255, 255, 255],
        getPosition: (road) => {
          const [lng, lat] = road.path[Math.floor(road.path.length / 2)];
          // Floated above street level so it clears typical rooftops in this
          // dataset instead of getting hidden behind 3D buildings.
          return [lng, lat, 70];
        },
        getSize: 16,
        getText: (road) => road.name,
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
        background: true,
        getBackgroundColor: [32, 140, 255, 235],
        backgroundPadding: [7, 5],
        // Billboarded (unlike map-labels) so it stays legible from the tilted
        // camera instead of lying flat on the ground and foreshortening away.
        billboard: true,
        pickable: false,
        updateTriggers: { data: flashSegmentId },
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

    return routeLayers;
  }, [
    cameraMode,
    currentTime,
    displayMode,
    flashSegmentId,
    heatPoints,
    maxVehicleCount,
    onSegmentClick,
    roads,
    selectedSegmentId,
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
        // Station markers stopPropagation on click, so this only ever fires
        // for clicks elsewhere on the map (roads, empty space) - dismissing
        // whichever station label is currently showing.
        onClick={() => {
          if (selectedStationId) onStationClick?.(selectedStationId);
        }}
        attributionControl={false}
      >
        <AttributionControl compact position="bottom-right" />
        <DeckGLOverlay
          interleaved
          effects={[lightingEffect]}
          layers={layers}
          getTooltip={tooltip}
        />
        {fieldInspectorPosition && (
          <Marker
            longitude={fieldInspectorPosition.lng}
            latitude={fieldInspectorPosition.lat}
            anchor="bottom"
            draggable
            onDragStart={() => setIsMarkerDragging(true)}
            onDragEnd={(event) => {
              setIsMarkerDragging(false);
              placeInspectionPoint(event.lngLat.lng, event.lngLat.lat);
            }}
          >
            <div className={styles.inspectionMarker}>
              <FieldInspectorFigure
                size={44}
                walking={isMarkerDragging}
                placementKey={placementSeq}
                aria-label="Field inspection position, drag to reposition"
              />
            </div>
          </Marker>
        )}
        {incidentMarkers.map((marker) => (
          <Marker key={marker.id} longitude={marker.lng} latitude={marker.lat} anchor="bottom">
            <div className={styles.incidentMarker} title={marker.title} aria-label={marker.title} role="img">
              <AlertTriangle size={15} />
            </div>
          </Marker>
        ))}
        {stationPoints.map((station) => {
          const isSelected = station.stationId === selectedStationId;
          const iconSize = Math.round(6 * Math.pow(2, mapZoom - 14));
          return (
            <Marker
              key={station.stationId}
              longitude={station.position[0]}
              latitude={station.position[1]}
              anchor="bottom"
            >
              <button
                type="button"
                className={styles.stationMarker}
                aria-label={station.name}
                onClick={(event) => {
                  event.stopPropagation();
                  onStationClick?.(station.stationId);
                }}
              >
                {isSelected && <span className={styles.stationLabel}>{station.name}</span>}
                <img
                  src={stationIconSrc(station.stationId)}
                  alt=""
                  className={isSelected ? styles.stationIconSelected : styles.stationIcon}
                  style={{ width: iconSize, height: iconSize }}
                />
              </button>
            </Marker>
          );
        })}
      </Map>
      <div className={styles.vignette} />
    </div>
  );
}

export default memo(NetworkGraph);

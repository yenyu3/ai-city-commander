import Papa from "papaparse";
import type {
  CrowdSnapshot,
  LiveIncident,
  RoadPathDef,
  RoadSegment,
  TrafficSnapshot,
} from "../types";
import { DATA_SOURCE } from "../config";

export interface LoadedData {
  traffic: TrafficSnapshot[];
  crowd: CrowdSnapshot[];
  segments: Map<string, RoadSegment>;
  nameToId: Record<string, string>;
  incidents: LiveIncident[];
  sopText: string;
  roadPaths: Map<string, RoadPathDef>;
  stationCoords: Record<string, [number, number]>;
  stationNames: Record<string, string>;
  mapCenter: [number, number];
}

async function fetchText(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.text();
}

function parseCsv<T extends Record<string, string>>(csvText: string): T[] {
  const { data } = Papa.parse<T>(csvText, {
    header: true,
    skipEmptyLines: true,
  });
  return data;
}

function parsePercent(raw: string): number {
  const n = parseFloat(raw.replace("%", "").trim());
  return n / 100;
}

async function loadTraffic(): Promise<TrafficSnapshot[]> {
  if (DATA_SOURCE === "api") return [];
  const csv = await fetchText("/data/city_traffic_flow.csv");
  const rows = parseCsv<Record<string, string>>(csv);
  return rows.map((r) => ({
    observedAt: r.Timestamp,
    segmentId: r.Segment_ID,
    roadName: r.Road_Name,
    avgSpeedKph: Number(r.Avg_Speed),
    vehicleCount: Number(r.Vehicle_Count),
    saturationScore: Number(r.Saturation_Score),
    laneStatus: r.Lane_Status as TrafficSnapshot["laneStatus"],
  }));
}

async function loadCrowd(): Promise<CrowdSnapshot[]> {
  if (DATA_SOURCE === "api") return [];
  const csv = await fetchText("/data/signaling_crowd_density.csv");
  const rows = parseCsv<Record<string, string>>(csv);
  return rows.map((r) => ({
    observedAt: r.Timestamp,
    stationId: r.BS_ID,
    locationName: r.Location_Name,
    userCount: Number(r.User_Count),
    stayTimeAvgMinutes: Number(r.Stay_Time_Avg),
    growthRate: Number(r.Growth_Rate),
    roamingUserPct: parsePercent(r.Roaming_User_Pct),
  }));
}

/**
 * 後端目前沒有 reference-data API（見 docs/frontend-backend-coordination-issues.md 第 3 項），
 * demo 模式才從既有 CSV 衍生站名；api 模式不補 demo 站名，直接顯示後端 stationId。
 */
async function loadStationNames(): Promise<Record<string, string>> {
  if (DATA_SOURCE === "api") return {};
  const csv = await fetchText("/data/signaling_crowd_density.csv");
  const rows = parseCsv<Record<string, string>>(csv);
  const names: Record<string, string> = {};
  for (const r of rows) {
    if (r.BS_ID && r.Location_Name && !names[r.BS_ID]) {
      names[r.BS_ID] = r.Location_Name;
    }
  }
  return names;
}

interface RawSegment {
  segment_id: string;
  name: string;
  flow_direction: string;
  intersections: string[];
  capacity_vph: number;
  alternatives: string[];
  nearby_stations: string[];
}

async function loadSegments(): Promise<{
  segments: Map<string, RoadSegment>;
  nameToId: Record<string, string>;
}> {
  const json = await fetchText("/data/road_network_geometry.json");
  const raw: RawSegment[] = JSON.parse(json);

  // Build name -> segmentId lookup directly from the dataset itself,
  // since intersections reference road names, not IDs.
  const nameToId: Record<string, string> = {};
  for (const seg of raw) {
    nameToId[seg.name] = seg.segment_id;
  }

  const segments = new Map<string, RoadSegment>();
  for (const seg of raw) {
    const intersectionIds = seg.intersections
      .map((name) => nameToId[name])
      .filter((id): id is string => Boolean(id));
    segments.set(seg.segment_id, {
      segmentId: seg.segment_id,
      name: seg.name,
      flowDirection: seg.flow_direction,
      intersections: seg.intersections,
      intersectionIds,
      capacityVph: seg.capacity_vph,
      alternatives: seg.alternatives,
      nearbyStations: seg.nearby_stations,
    });
  }

  return { segments, nameToId };
}

interface RawIncident {
  event_id: string;
  type: string;
  location: string;
  affected_segment: string;
  affected_road?: string;
  status: string;
  severity: string;
  description: string;
  timestamp: string;
}

async function loadIncidents(): Promise<LiveIncident[]> {
  if (DATA_SOURCE === "api") return [];
  const json = await fetchText("/data/live_incidents.json");
  const raw: RawIncident[] = JSON.parse(json);
  return raw.map((i) => ({
    eventId: i.event_id,
    type: i.type,
    location: i.location,
    affectedSegmentId: i.affected_segment,
    affectedRoad: i.affected_road,
    status: i.status,
    severity: i.severity,
    description: i.description,
    occurredAt: i.timestamp,
  }));
}

interface RawRoadPath {
  segment_id: string;
  path: [number, number][];
  dashed: boolean;
}

async function loadRoadPaths(): Promise<Map<string, RoadPathDef>> {
  const json = await fetchText("/data/road_paths.json");
  const raw: RawRoadPath[] = JSON.parse(json);
  return new Map(
    raw.map((r) => [
      r.segment_id,
      { segmentId: r.segment_id, path: r.path, dashed: r.dashed },
    ]),
  );
}

interface RawStationCoords {
  stations: Record<string, [number, number]>;
  mapCenter: [number, number];
}

async function loadStationCoords(): Promise<{
  stationCoords: Record<string, [number, number]>;
  mapCenter: [number, number];
}> {
  const json = await fetchText("/data/station_coords.json");
  const raw: RawStationCoords = JSON.parse(json);
  return { stationCoords: raw.stations, mapCenter: raw.mapCenter };
}

export async function loadAllData(): Promise<LoadedData> {
  const [
    traffic,
    crowd,
    { segments, nameToId },
    incidents,
    sopText,
    roadPaths,
    { stationCoords, mapCenter },
    stationNames,
  ] = await Promise.all([
    loadTraffic(),
    loadCrowd(),
    loadSegments(),
    loadIncidents(),
    DATA_SOURCE === "api" ? Promise.resolve("") : fetchText("/data/emergency_traffic_sop.txt"),
    loadRoadPaths(),
    loadStationCoords(),
    loadStationNames(),
  ]);

  return {
    traffic,
    crowd,
    segments,
    nameToId,
    incidents,
    sopText,
    roadPaths,
    stationCoords,
    stationNames,
    mapCenter,
  };
}

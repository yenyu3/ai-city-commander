import type { AlertRecord, RoadPathDef, RoadSegment } from "../types";

/** 事件與使用者定位之間，判定為「鄰近」的距離門檻（公尺）——在這個小範圍地圖（信義/大安
 *  一小塊，最遠角落約 1~1.5 公里）下，500 公尺大致對應「事件影響範圍內／步行可達」。 */
export const NEARBY_THRESHOLD_M = 500;

/** 城市尺度的平面近似換算（等距圓柱投影），比真正的球面距離公式簡單很多，
 *  在信義/大安區這種公里級小範圍內誤差可忽略。 */
export function metersBetween([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]): number {
  const latRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dx = (lng2 - lng1) * 111320 * Math.cos(latRad);
  const dy = (lat2 - lat1) * 111320;
  return Math.hypot(dx, dy);
}

/** 沿路徑均勻取樣後，回傳與其中最近取樣點的距離——路徑不長且只用於「找最近」，
 *  取樣密度不需要真的做線段投影。 */
function distanceToPath(position: [number, number], path: [number, number][], samples = 20): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1) return metersBetween(position, path[0]);

  let totalLength = 0;
  const segmentLengths: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const len = metersBetween(path[i - 1], path[i]);
    segmentLengths.push(len);
    totalLength += len;
  }
  if (totalLength === 0) return metersBetween(position, path[0]);

  let best = Number.POSITIVE_INFINITY;
  for (let s = 0; s <= samples; s++) {
    const targetDist = (s / samples) * totalLength;
    let covered = 0;
    for (let i = 0; i < segmentLengths.length; i++) {
      const segLen = segmentLengths[i];
      if (covered + segLen >= targetDist || i === segmentLengths.length - 1) {
        const t = segLen > 0 ? Math.min(1, Math.max(0, (targetDist - covered) / segLen)) : 0;
        const [x1, y1] = path[i];
        const [x2, y2] = path[i + 1];
        const point: [number, number] = [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
        best = Math.min(best, metersBetween(position, point));
        break;
      }
      covered += segLen;
    }
  }
  return best;
}

/** 路段路徑上的代表座標（近似中點）——用來在地圖上標出「這起事件大概發生在路段的哪裡」，
 *  不需要精確到肇事地點，取路徑中段索引即可。 */
export function pathMidpoint(path: [number, number][]): [number, number] {
  if (path.length === 0) return [0, 0];
  return path[Math.floor((path.length - 1) / 2)];
}

/** 找出離某個經緯度最近的路段（不限距離），供示範定位按鈕解析 nearestRoadId/nearestRoadName 用。 */
export function findNearestRoadId(
  position: [number, number],
  roadPaths: Map<string, RoadPathDef>,
  segmentDefs: Map<string, RoadSegment>,
): { segmentId: string; name: string } | null {
  let best: { segmentId: string; name: string; distance: number } | null = null;
  for (const [segmentId, def] of roadPaths) {
    const distance = distanceToPath(position, def.path);
    if (!best || distance < best.distance) {
      best = { segmentId, name: segmentDefs.get(segmentId)?.name ?? segmentId, distance };
    }
  }
  return best ? { segmentId: best.segmentId, name: best.name } : null;
}

/** 事件對應座標：RD_ 路段取路徑上最近點，BS_ 站點直接取站點座標。 */
function distanceToTrackedSegment(
  position: [number, number],
  trackedSegmentId: string,
  roadPaths: Map<string, RoadPathDef>,
  stationCoords: Record<string, [number, number]>,
): number | null {
  if (trackedSegmentId.startsWith("BS_")) {
    const coords = stationCoords[trackedSegmentId];
    return coords ? metersBetween(position, coords) : null;
  }
  const path = roadPaths.get(trackedSegmentId);
  return path ? distanceToPath(position, path.path) : null;
}

/** 找出離使用者定位最近的「尚未解決」注入事件，用來判斷 AI 決策面板/對話回答
 *  是否要與該事件做位置關聯（見 LocationRelevanceCard、appStore.ts 的 sendChatMessage）。 */
export function findNearestTrackedAlert(
  position: [number, number],
  alerts: AlertRecord[],
  roadPaths: Map<string, RoadPathDef>,
  stationCoords: Record<string, [number, number]>,
): { alert: AlertRecord; distanceMeters: number } | null {
  let best: { alert: AlertRecord; distanceMeters: number } | null = null;
  for (const alert of alerts) {
    if (alert.origin !== "incident" || !alert.trackedSegmentId || alert.resolvedAt) continue;
    const distance = distanceToTrackedSegment(position, alert.trackedSegmentId, roadPaths, stationCoords);
    if (distance === null) continue;
    if (!best || distance < best.distanceMeters) {
      best = { alert, distanceMeters: distance };
    }
  }
  return best;
}

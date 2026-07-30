import type { Position } from "@deck.gl/core";

const DEFAULT_ROUTE_SIMPLIFY_TOLERANCE = 0.0004;

function perpendicularDistance(
  point: [number, number],
  start: [number, number],
  end: [number, number],
) {
  const [px, py] = point;
  const [sx, sy] = start;
  const [ex, ey] = end;
  const dx = ex - sx;
  const dy = ey - sy;

  if (dx === 0 && dy === 0) return Math.hypot(px - sx, py - sy);

  const t = Math.max(
    0,
    Math.min(1, ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy)),
  );
  const projectedX = sx + t * dx;
  const projectedY = sy + t * dy;
  return Math.hypot(px - projectedX, py - projectedY);
}

function simplifySection(
  path: [number, number][],
  startIndex: number,
  endIndex: number,
  tolerance: number,
  keep: boolean[],
) {
  if (endIndex <= startIndex + 1) return;

  let maxDistance = 0;
  let maxIndex = startIndex;
  const start = path[startIndex];
  const end = path[endIndex];

  for (let i = startIndex + 1; i < endIndex; i++) {
    const distance = perpendicularDistance(path[i], start, end);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }

  if (maxDistance > tolerance) {
    keep[maxIndex] = true;
    simplifySection(path, startIndex, maxIndex, tolerance, keep);
    simplifySection(path, maxIndex, endIndex, tolerance, keep);
  }
}

export function simplifyPath(
  path: [number, number][],
  tolerance = DEFAULT_ROUTE_SIMPLIFY_TOLERANCE,
): [number, number][] {
  if (path.length <= 2) return path;

  const keep = Array.from({ length: path.length }, () => false);
  keep[0] = true;
  keep[path.length - 1] = true;
  simplifySection(path, 0, path.length - 1, tolerance, keep);

  return path.filter((_, index) => keep[index]);
}

export function withElevation(path: [number, number][], z = 12): Position[] {
  return simplifyPath(path).map(([lng, lat]) => [lng, lat, z]);
}

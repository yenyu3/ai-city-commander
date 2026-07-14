import type { Position } from "@deck.gl/core";

export function withElevation(path: [number, number][], z = 12): Position[] {
  return path.map(([lng, lat]) => [lng, lat, z]);
}

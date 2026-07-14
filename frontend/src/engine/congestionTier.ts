import type { CityResponseResult, Tier } from "../types";

export function getTier(saturation: number): Tier {
  if (saturation >= 0.95) return "A";
  if (saturation >= 0.85) return "B";
  return "Normal";
}

export const CITY_TRIGGER_SEGMENTS = ["RD_TPE_001", "RD_TPE_002"];

export function checkCityResponse(
  segmentId: string,
  tier: Tier,
): CityResponseResult | null {
  if (!CITY_TRIGGER_SEGMENTS.includes(segmentId)) return null;
  if (tier === "Normal") return null;

  const actions = [
    "通報交控中心啟動「長綠燈時制」",
    "替代道路綠燈配時 +25%",
    "調度警力淨空路口",
  ];
  if (tier === "A") {
    actions.push("同步觸發替代路徑引導（見事故應變規則）");
  }
  return { segmentId, tier, actions };
}

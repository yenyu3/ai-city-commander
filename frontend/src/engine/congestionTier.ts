import type { CityResponseResult, Tier } from "../types";

/** SOP §1 分級門檻，UI 端顯示「判定門檻」文字時應引用這裡，不要重複寫死數字。 */
export const TIER_THRESHOLDS: Record<Exclude<Tier, "Normal">, number> = {
  A: 0.95,
  B: 0.85,
};

export function getTier(saturation: number): Tier {
  if (saturation >= TIER_THRESHOLDS.A) return "A";
  if (saturation >= TIER_THRESHOLDS.B) return "B";
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

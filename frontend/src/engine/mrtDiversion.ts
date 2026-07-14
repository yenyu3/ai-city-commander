import type { CrowdSnapshot } from "../types";

export function checkMrtDiversion(bl17: CrowdSnapshot): boolean {
  return bl17.growthRate > 0.3 || bl17.userCount > 25000;
}

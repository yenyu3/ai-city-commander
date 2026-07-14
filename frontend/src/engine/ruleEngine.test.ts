import { describe, expect, it } from "vitest";
import type { CrowdSnapshot, LiveIncident, RoadSegment } from "../types";
import { getTier, checkCityResponse } from "./congestionTier";
import { isAccidentTrigger, selectEvacuationRoute } from "./accidentResponse";
import { checkMrtDiversion } from "./mrtDiversion";
import { checkDomeDispersal } from "./domeDispersal";
import { checkSignalFailure } from "./signalFailure";
import { checkMultilingualNeeded } from "./multilingualCheck";
import { calcETE } from "./ete";

// --- helpers to build a minimal segment graph mirroring road_network_geometry.json ---
function seg(
  segmentId: string,
  name: string,
  flowDirection: string,
  intersections: string[],
  intersectionIds: string[],
  capacityVph: number,
  alternatives: string[],
): RoadSegment {
  return {
    segmentId,
    name,
    flowDirection,
    intersections,
    intersectionIds,
    capacityVph,
    alternatives,
    nearbyStations: [],
  };
}

const segments = new Map<string, RoadSegment>([
  [
    "RD_TPE_001",
    seg(
      "RD_TPE_001",
      "忠孝東路四段",
      "東西向",
      ["延吉街", "光復南路", "基隆路一段"],
      ["RD_TPE_008", "RD_TPE_002", "RD_TPE_003"],
      3000,
      ["RD_TPE_004", "RD_TPE_005", "RD_TPE_007"],
    ),
  ],
  [
    "RD_TPE_002",
    seg(
      "RD_TPE_002",
      "光復南路",
      "南北向 (事故影響南下車流)",
      ["市民大道四段", "忠孝東路四段", "仁愛路四段"],
      ["RD_TPE_004", "RD_TPE_001", "RD_TPE_005"],
      1800,
      ["RD_TPE_004", "RD_TPE_005", "RD_TPE_006", "RD_TPE_008"],
    ),
  ],
  [
    "RD_TPE_004",
    seg(
      "RD_TPE_004",
      "市民大道四段",
      "東西向",
      ["復興南路一段", "敦化南路一段", "光復南路"],
      ["RD_TPE_015", "RD_TPE_006", "RD_TPE_002"],
      2500,
      ["RD_TPE_001", "RD_TPE_006"],
    ),
  ],
  [
    "RD_TPE_005",
    seg(
      "RD_TPE_005",
      "仁愛路四段",
      "東西向",
      ["敦化南路一段", "光復南路", "市府路"],
      ["RD_TPE_006", "RD_TPE_002", "RD_TPE_010"],
      4000,
      ["RD_TPE_001", "RD_TPE_010"],
    ),
  ],
  [
    "RD_TPE_006",
    seg(
      "RD_TPE_006",
      "敦化南路一段",
      "南北向",
      ["市民大道四段", "忠孝東路四段", "仁愛路四段"],
      ["RD_TPE_004", "RD_TPE_001", "RD_TPE_005"],
      3200,
      ["RD_TPE_002", "RD_TPE_004", "RD_TPE_008"],
    ),
  ],
  [
    "RD_TPE_008",
    seg(
      "RD_TPE_008",
      "延吉街",
      "南北向",
      ["忠孝東路四段", "仁愛路四段"],
      ["RD_TPE_001", "RD_TPE_005"],
      600,
      ["RD_TPE_002"],
    ),
  ],
]);

describe("§4.1 壅塞分級 + 城市觸發", () => {
  it("classifies tiers by saturation thresholds", () => {
    expect(getTier(0.84)).toBe("Normal");
    expect(getTier(0.85)).toBe("B");
    expect(getTier(0.94)).toBe("B");
    expect(getTier(0.95)).toBe("A");
    expect(getTier(1.0)).toBe("A");
  });

  it("only triggers city response for RD_TPE_001 / RD_TPE_002", () => {
    expect(checkCityResponse("RD_TPE_003", "A")).toBeNull();
    expect(checkCityResponse("RD_TPE_001", "Normal")).toBeNull();
    const b = checkCityResponse("RD_TPE_001", "B")!;
    expect(b.actions).toHaveLength(3);
    const a = checkCityResponse("RD_TPE_002", "A")!;
    expect(a.actions).toHaveLength(4);
    expect(a.actions[3]).toContain("替代路徑引導");
  });
});

describe("§4.2 / §4.3 驗證用例 A：RD_TPE_002 光復南路封閉", () => {
  const incident: LiveIncident = {
    eventId: "TPE_2026_ACC_001",
    type: "Road_Collapse_Accident",
    location: "光復南路與忠孝東路口南側",
    affectedSegment: "RD_TPE_002",
    status: "Closed",
    severity: "Critical",
    description: "地下管線爆裂導致路面塌陷並引發三車連環追撞，光復南路南下全線封鎖",
    timestamp: "2026-05-20 22:10",
  };

  it("triggers the accident rule", () => {
    expect(isAccidentTrigger(incident)).toBe(true);
  });

  it("selects RD_TPE_004 (市民大道四段) as the main evacuation route, not RD_TPE_005", () => {
    const saturation = new Map([
      ["RD_TPE_002", 1.0],
      ["RD_TPE_004", 0.78],
      ["RD_TPE_005", 0.65],
      ["RD_TPE_006", 0.72],
      ["RD_TPE_008", 0.8],
    ]);
    const result = selectEvacuationRoute(
      "RD_TPE_002",
      incident.location,
      segments,
      saturation,
    );

    expect(result.mainRoute).toBe("RD_TPE_004");
    expect(result.secondaryRoutes).toEqual(["RD_TPE_005"]);
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ segmentId: "RD_TPE_008" }),
        expect.objectContaining({ segmentId: "RD_TPE_006" }),
      ]),
    );
    expect(result.excluded).toHaveLength(2);
    expect(result.congestionWarning).toBe(false);
  });

  it("re-evaluates and flags congestion when the main route itself saturates (22:30 snapshot)", () => {
    const saturation = new Map([
      ["RD_TPE_002", 1.0],
      ["RD_TPE_004", 0.95],
      ["RD_TPE_005", 0.85],
      ["RD_TPE_006", 0.98],
      ["RD_TPE_008", 1.0],
    ]);
    const result = selectEvacuationRoute(
      "RD_TPE_002",
      incident.location,
      segments,
      saturation,
    );
    expect(result.mainRoute).toBe("RD_TPE_004");
    expect(result.congestionWarning).toBe(true);
    expect(result.recommendPublicTransit).toBe(true);
  });

  it("computes ETE = 83 minutes from the real dataset snapshot", () => {
    const avg = (1.0 + 0.78) / 2;
    const { ete, breakdown } = calcETE("Critical", avg);
    expect(ete).toBe(83);
    expect(breakdown).toContain("83");
  });
});

describe("§4.4 驗證用例 B：BS_MRT_BL17 人潮推擠事件（邊界案例）", () => {
  it("does NOT trigger the accident rule even though affectedRoad is RD_TPE_001", () => {
    const incident: LiveIncident = {
      eventId: "TPE_2026_EVT_002",
      type: "Crowd_Surge_Injury",
      location: "捷運國父紀念館站 5 號出口",
      affectedSegment: "BS_MRT_BL17",
      affectedRoad: "RD_TPE_001",
      status: "Restricted",
      severity: "High",
      description: "散場人群推擠受傷，救護車佔用單向車道，人流進站動線中斷",
      timestamp: "2026-05-20 22:20",
    };
    expect(isAccidentTrigger(incident)).toBe(false);
  });
});

describe("§4.5 捷運與接駁分流", () => {
  function crowd(userCount: number, growthRate: number): CrowdSnapshot {
    return {
      timestamp: "2026-05-20 18:00",
      stationId: "BS_MRT_BL17",
      locationName: "捷運國父紀念館站",
      userCount,
      stayTimeAvg: 20,
      growthRate,
      roamingPct: 0.1,
    };
  }

  it("triggers at 18:00 growthRate=0.88", () => {
    expect(checkMrtDiversion(crowd(8500, 0.88))).toBe(true);
  });
  it("triggers at 21:30 (both growthRate=0.50 and userCount alone would pass)", () => {
    expect(checkMrtDiversion(crowd(18000, 0.5))).toBe(true);
  });
  it("triggers at 22:30 purely from userCount=33000", () => {
    expect(checkMrtDiversion(crowd(33000, 0.06))).toBe(true);
  });
  it("does not trigger under both thresholds", () => {
    expect(checkMrtDiversion(crowd(10000, 0.1))).toBe(false);
  });
});

describe("§4.6 大巨蛋散場啟動", () => {
  const history: CrowdSnapshot[] = [15000, 35000, 40000, 38000].map(
    (userCount) => ({
      timestamp: "t",
      stationId: "BS_TPE_DOME",
      locationName: "大巨蛋場館內",
      userCount,
      stayTimeAvg: 100,
      growthRate: 0,
      roamingPct: 0.05,
    }),
  );

  function current(growthRate: number): CrowdSnapshot {
    return {
      timestamp: "t",
      stationId: "BS_TPE_DOME",
      locationName: "大巨蛋場館內",
      userCount: 22000,
      stayTimeAvg: 180,
      growthRate,
      roamingPct: 0.05,
    };
  }

  it("does not trigger at 21:00 (-0.05) or 21:30 (-0.16)", () => {
    expect(checkDomeDispersal(history, current(-0.05))).toBe(false);
    expect(checkDomeDispersal(history, current(-0.16))).toBe(false);
  });

  it("triggers exactly at the -0.20 boundary and beyond (22:00 = -0.31)", () => {
    expect(checkDomeDispersal(history, current(-0.2))).toBe(true);
    expect(checkDomeDispersal(history, current(-0.31))).toBe(true);
  });
});

describe("§4.7 號誌故障應變", () => {
  it("triggers on Power_Failure type even at severity=Medium, independent of §4.2", () => {
    const incident: LiveIncident = {
      eventId: "TPE_2026_EVT_003",
      type: "Power_Failure",
      location: "信義威秀/ATT4FUN周邊路燈號誌故障",
      affectedSegment: "RD_TPE_007",
      status: "Caution",
      severity: "Medium",
      description: "信義區部分路段號誌失效，需改由人工交通指揮",
      timestamp: "2026-05-20 22:30",
    };
    expect(checkSignalFailure(incident)).toBe(true);
    expect(isAccidentTrigger(incident)).toBe(false);
  });
});

describe("§4.8 數位通報與多語化", () => {
  function station(roamingPct: number): CrowdSnapshot {
    return {
      timestamp: "t",
      stationId: "BS_XY_ATT",
      locationName: "ATT4FUN周邊",
      userCount: 1000,
      stayTimeAvg: 10,
      growthRate: 0,
      roamingPct,
    };
  }

  it("includes stations at exactly the 30% boundary", () => {
    const result = checkMultilingualNeeded([station(0.3)]);
    expect(result).toHaveLength(1);
  });

  it("excludes 28% (below boundary)", () => {
    const result = checkMultilingualNeeded([station(0.28)]);
    expect(result).toHaveLength(0);
  });

  it("includes 40% and 45%", () => {
    expect(checkMultilingualNeeded([station(0.4), station(0.45)])).toHaveLength(2);
  });
});

describe("§4.9 ETE 計算共用函式", () => {
  it("uses correct base clearance per severity", () => {
    expect(calcETE("Critical", 0.5).ete).toBe(60);
    expect(calcETE("High", 0.5).ete).toBe(40);
    expect(calcETE("Medium", 0.5).ete).toBe(20);
  });
  it("never applies a negative penalty", () => {
    expect(calcETE("Medium", 0.2).ete).toBe(20);
  });
});

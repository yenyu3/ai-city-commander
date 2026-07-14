import type { EvacuationRouteResult, LiveIncident, RoadSegment } from "../types";

/**
 * 觸發條件（§4.2）：三者同時成立。
 * 刻意只看 affectedSegment 是否為 RD_ 開頭 —— affectedRoad 只是關聯欄位，
 * 不可用來判斷是否進入車禍疏散規則（見驗證用例 B）。
 */
export function isAccidentTrigger(incident: LiveIncident): boolean {
  const statusOk = ["Closed", "Blocked", "Restricted"].includes(
    incident.status,
  );
  const severityOk = ["High", "Critical"].includes(incident.severity);
  const isRoad = incident.affectedSegment.startsWith("RD_");
  return statusOk && severityOk && isRoad;
}

/**
 * 依 flow_direction 文字判斷「陣列順序」是否等同於「行進方向」。
 * 明確假設（§4.2 註）：intersections 陣列本身在原始 JSON 中即為
 * 由北到南 / 由西到東排列；若敘述中出現「南下」「東行」，行進方向與陣列順序一致；
 * 若出現「北上」「西行」，則相反。未特別註明時，預設陣列順序＝行進方向。
 */
function isTravelForward(flowDirection: string): boolean {
  if (/南下|東行/.test(flowDirection)) return true;
  if (/北上|西行/.test(flowDirection)) return false;
  return true;
}

/**
 * 從事故 location/description 的方位詞，找出事故點在 intersections 陣列中的
 * 「插入位置」(可為半整數，代表落在兩個路口之間)。
 * 例："光復南路與忠孝東路口南側" -> 命中「忠孝東路四段」在陣列中的 index，
 * 又因為是「南側」(=陣列中較後面的方向，因南北向陣列由北到南排列)，
 * 插入位置 = index + 0.5。
 */
function findIncidentInsertionIndex(
  intersectionNames: string[],
  incidentLocationHint: string,
): number {
  let refIndex = -1;
  for (let i = 0; i < intersectionNames.length; i++) {
    // 路名字串可能是「忠孝東路四段」而事故描述可能只寫「忠孝東路」，用包含比對
    const shortName = intersectionNames[i].replace(/[一二三四五六七八九十]段$/, "");
    if (
      incidentLocationHint.includes(intersectionNames[i]) ||
      incidentLocationHint.includes(shortName)
    ) {
      refIndex = i;
      break;
    }
  }
  if (refIndex === -1) return (intersectionNames.length - 1) / 2;

  if (/南側|東側|以南|以東/.test(incidentLocationHint)) return refIndex + 0.5;
  if (/北側|西側|以北|以西/.test(incidentLocationHint)) return refIndex - 0.5;
  return refIndex;
}

export function isUpstream(
  candidateSegmentId: string,
  incidentSeg: RoadSegment,
  incidentLocationHint: string,
): boolean {
  const candidateIndex = incidentSeg.intersectionIds.indexOf(
    candidateSegmentId,
  );
  if (candidateIndex === -1) return false;

  const insertionIndex = findIncidentInsertionIndex(
    incidentSeg.intersections,
    incidentLocationHint,
  );
  const forward = isTravelForward(incidentSeg.flowDirection);

  return forward
    ? candidateIndex < insertionIndex
    : candidateIndex > insertionIndex;
}

export function selectEvacuationRoute(
  incidentSegmentId: string,
  incidentLocationHint: string,
  segments: Map<string, RoadSegment>,
  currentSaturation: Map<string, number>,
): EvacuationRouteResult {
  const incidentSeg = segments.get(incidentSegmentId);
  if (!incidentSeg) {
    return {
      mainRoute: null,
      secondaryRoutes: [],
      excluded: [],
      congestionWarning: false,
      recommendPublicTransit: false,
    };
  }

  const excluded: { segmentId: string; reason: string }[] = [];
  const passed: RoadSegment[] = [];

  for (const altId of incidentSeg.alternatives) {
    const alt = segments.get(altId);
    if (!alt) continue;

    if (alt.capacityVph < 1000) {
      excluded.push({
        segmentId: altId,
        reason: `容量 ${alt.capacityVph} < 1000`,
      });
      continue;
    }
    if (!incidentSeg.intersectionIds.includes(altId)) {
      excluded.push({
        segmentId: altId,
        reason: `非直接相交路段（不在 ${incidentSegmentId} 之 intersections）`,
      });
      continue;
    }
    passed.push(alt);
  }

  const upstreamCandidates = passed.filter((c) =>
    isUpstream(c.segmentId, incidentSeg, incidentLocationHint),
  );
  const downstreamCandidates = passed.filter(
    (c) => !isUpstream(c.segmentId, incidentSeg, incidentLocationHint),
  );

  const sortedUpstream = [...upstreamCandidates].sort(
    (a, b) =>
      (currentSaturation.get(a.segmentId) ?? 0) -
      (currentSaturation.get(b.segmentId) ?? 0),
  );
  const main = sortedUpstream[0] ?? null;
  const stillCongested = main
    ? (currentSaturation.get(main.segmentId) ?? 0) >= 0.85
    : false;

  return {
    mainRoute: main?.segmentId ?? null,
    secondaryRoutes: downstreamCandidates.map((c) => c.segmentId),
    excluded,
    congestionWarning: stillCongested,
    recommendPublicTransit: stillCongested,
  };
}

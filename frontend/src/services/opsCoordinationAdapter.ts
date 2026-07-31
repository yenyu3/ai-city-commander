import type { AlertRecord } from "../types";

export interface SignalTimingRow {
  intersectionName: string;
  /** 該項調整的量測名稱，依事件種類而異（綠燈延長／人工指揮涵蓋率／看板更新頻率…）。 */
  metricLabel: string;
  /** 已格式化好的數值文字（沒有原始秒數資料來源，只能提供相對增減或涵蓋率，不假設原始值）。 */
  valueText: string;
  goal: string;
}

export interface InterAgencyAction {
  agency: string;
  text: string;
  icon: "train" | "bus" | "shield";
}

export interface OpsCoordinationPlan {
  period: string;
  signalTimings: SignalTimingRow[];
  interAgencyActions: InterAgencyAction[];
}

export interface OpsCoordinationAdapter {
  getCoordinationPlan(alert: AlertRecord): Promise<OpsCoordinationPlan>;
}

const KIND_INTERSECTION_NAME: Record<AlertRecord["kind"], string> = {
  city_response: "主要路口（長綠燈時制）",
  accident: "事故周邊路口",
  mrt_diversion: "捷運站出入口周邊路口",
  dome_dispersal: "場館周邊路口",
  signal_failure: "號誌故障路口",
  multilingual: "站點周邊路口",
};

const KIND_AGENCIES: Record<AlertRecord["kind"], InterAgencyAction[]> = {
  city_response: [
    { agency: "交通警察大隊", text: "派遣員警至主要路口實施現場管制與淨空。", icon: "shield" },
    { agency: "臺北市公車聯營管理處", text: "通報行經替代道路之公車彈性改道。", icon: "bus" },
  ],
  accident: [
    { agency: "交通警察大隊", text: "派遣員警至事故路口實施現場控號與淨空。", icon: "shield" },
    { agency: "臺北市公車聯營管理處", text: "通報行經事故路段之公車彈性改道。", icon: "bus" },
  ],
  mrt_diversion: [
    { agency: "臺北捷運公司 (TRTC)", text: "加開列車班次疏導人潮，啟動月台管制。", icon: "train" },
  ],
  dome_dispersal: [
    { agency: "臺北捷運公司 (TRTC)", text: "散場時段加開空車疏導人潮。", icon: "train" },
    { agency: "臺北市公車聯營管理處", text: "場館周邊加派接駁公車。", icon: "bus" },
  ],
  signal_failure: [
    { agency: "工務局號誌維護單位", text: "派員搶修故障號誌，現場改以人工指揮通行。", icon: "shield" },
  ],
  multilingual: [
    { agency: "觀光傳播局", text: "同步於旅客服務據點發布多語提醒。", icon: "shield" },
  ],
};

function formatPeriod(timestamp: string): string {
  const start = new Date(timestamp.replace(" ", "T"));
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${fmt(start)}-${fmt(end)}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 依事件實際的飽和度/成長率/漫遊比例等即時數據，換算出有依據的調整幅度，
 *  取代單一固定 25% —— 讓同一種事件在不同嚴重程度下顯示不同的建議值。 */
function deriveSignalTiming(alert: AlertRecord): SignalTimingRow {
  const intersectionName = KIND_INTERSECTION_NAME[alert.kind];
  switch (alert.kind) {
    case "city_response":
    case "accident": {
      const saturation = alert.segmentMetrics?.saturation ?? 0.85;
      const pct = Math.round(clamp(15 + ((saturation - 0.85) / 0.15) * 25, 15, 40));
      return {
        intersectionName,
        metricLabel: "綠燈延長",
        valueText: `+${pct}%`,
        goal:
          alert.kind === "accident"
            ? "加速主疏散替代路徑車流消化速度"
            : "淨空觸發路段並加速替代道路車流消化",
      };
    }
    case "mrt_diversion": {
      const growth = alert.stationMetrics?.growthRate ?? 0.3;
      const pct = Math.round(clamp(20 + growth * 40, 20, 50));
      return {
        intersectionName,
        metricLabel: "行人號誌通行時間",
        valueText: `+${pct}%`,
        goal: "加速站體出入口人流疏散，降低月台聚積風險",
      };
    }
    case "dome_dispersal": {
      const growth = Math.abs(alert.stationMetrics?.growthRate ?? 0.2);
      const pct = Math.round(clamp(25 + growth * 30, 25, 45));
      return {
        intersectionName,
        metricLabel: "行人號誌通行時間",
        valueText: `+${pct}%`,
        goal: "加速場館周邊人流疏散，配合接駁機制錯開退場人潮",
      };
    }
    case "signal_failure": {
      return {
        intersectionName,
        metricLabel: "人工指揮涵蓋率",
        valueText: "100%",
        goal: "以現場人工指揮完全取代故障號誌，維持路口通行安全",
      };
    }
    case "multilingual":
    default: {
      const roaming = alert.stationMetrics?.roamingPct ?? 0.3;
      const pct = Math.round(clamp(30 + roaming * 40, 30, 60));
      return {
        intersectionName,
        metricLabel: "看板／簡訊更新頻率",
        valueText: `+${pct}%`,
        goal: "提高多語看板與簡訊更新頻率，確保外籍旅客即時獲悉",
      };
    }
  }
}

/**
 * MVP 實作：規則引擎目前沒有號誌秒數計算或跨機關派遣邏輯的後端來源，這裡依事件
 * 實際觸發時的飽和度/人流數據換算出有依據的調整建議。介面維持 Promise 簽章，
 * 未來要換成真後端 API 時，呼叫端（SignalCoordinationSection / ProposalDocument）
 * 完全不用改。
 */
export class TemplateOpsCoordinationAdapter implements OpsCoordinationAdapter {
  async getCoordinationPlan(alert: AlertRecord): Promise<OpsCoordinationPlan> {
    return {
      period: formatPeriod(alert.timestamp),
      signalTimings: [deriveSignalTiming(alert)],
      interAgencyActions: KIND_AGENCIES[alert.kind],
    };
  }
}

export const opsCoordinationAdapter: OpsCoordinationAdapter = new TemplateOpsCoordinationAdapter();

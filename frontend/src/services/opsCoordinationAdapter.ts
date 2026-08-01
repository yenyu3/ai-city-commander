import type { AlertRecord } from "../types";

export interface SignalTimingRow {
  intersectionName: string;
  /** 綠燈秒數的調整幅度（沒有原始秒數資料來源，只能提供相對增減，不假設原始值）。 */
  adjustPct: number;
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

/**
 * MVP 佔位資料：規則引擎目前沒有號誌秒數計算或跨機關派遣邏輯，這裡先用依事件種類
 * 模板化的假資料撐版面。介面維持 Promise 簽章，未來要換成真後端 API 時，
 * 呼叫端（SignalCoordinationSection / ProposalDocument）完全不用改。
 */
export class TemplateOpsCoordinationAdapter implements OpsCoordinationAdapter {
  async getCoordinationPlan(alert: AlertRecord): Promise<OpsCoordinationPlan> {
    return {
      period: formatPeriod(alert.timestamp),
      signalTimings: [
        {
          intersectionName: KIND_INTERSECTION_NAME[alert.kind],
          adjustPct: 25,
          goal: "加速主要疏散替代路徑車流消化速度",
        },
      ],
      interAgencyActions: KIND_AGENCIES[alert.kind],
    };
  }
}

export const opsCoordinationAdapter: OpsCoordinationAdapter = new TemplateOpsCoordinationAdapter();

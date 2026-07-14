import type { AlertRecord } from "../types";

export type MessageType =
  | "congestion"
  | "accident_detour"
  | "signal_failure"
  | "mrt_diversion";

type Lang = "zh" | "en" | "ja" | "ko";

export const MSG_TEMPLATES: Record<
  MessageType,
  Record<Lang, (v: Record<string, string>) => string>
> = {
  congestion: {
    zh: (v) =>
      `【交通壅塞提醒】${v.location}周邊交通壅塞，預計恢復時間約${v.ete}分鐘，請提前規劃行程。`,
    en: (v) =>
      `[Traffic Alert] Congestion near ${v.location}. Estimated clearance ~${v.ete} min. Please plan ahead.`,
    ja: (v) =>
      `【交通渋滞のお知らせ】${v.location}周辺で渋滞が発生しています。復旧まで約${v.ete}分の見込みです。`,
    ko: (v) =>
      `[교통 혼잡 안내] ${v.location} 부근 혼잡 발생. 예상 복구 시간 약 ${v.ete}분입니다.`,
  },
  accident_detour: {
    zh: (v) => `${v.segment}封閉，請改道${v.detour}，預計延誤${v.ete}分鐘。`,
    en: (v) =>
      `${v.segment} closed. Please detour via ${v.detour}. Estimated delay ${v.ete} min.`,
    ja: (v) =>
      `${v.segment}は閉鎖されています。${v.detour}へ迂回してください。遅延見込み${v.ete}分。`,
    ko: (v) =>
      `${v.segment} 폐쇄. ${v.detour}(으)로 우회하시기 바랍니다. 예상 지연 ${v.ete}분.`,
  },
  signal_failure: {
    zh: (v) => `${v.segment} 號誌故障，請依現場人工指揮通行，預計排除時間約${v.ete}分鐘。`,
    en: (v) =>
      `Signal failure at ${v.segment}. Please follow on-site traffic control. Estimated resolution ~${v.ete} min.`,
    ja: (v) =>
      `${v.segment} で信号故障が発生しています。現場の誘導に従ってください。復旧見込み約${v.ete}分。`,
    ko: (v) =>
      `${v.segment} 신호 고장. 현장 수신호에 따라 주행하시기 바랍니다. 예상 복구 시간 약 ${v.ete}분.`,
  },
  mrt_diversion: {
    zh: (v) =>
      `【捷運壅塞通知】${v.location}人潮眾多，列車將過站不停，請改往鄰站或改搭接駁專車。`,
    en: (v) =>
      `[MRT Alert] Heavy crowd at ${v.location}. Trains will skip this stop; please use the adjacent station or shuttle bus.`,
    ja: (v) =>
      `【MRT混雑のお知らせ】${v.location}周辺は大変混雑しています。列車は通過運転となります。隣駅または送迎バスをご利用ください。`,
    ko: (v) =>
      `[MRT 안내] ${v.location} 혼잡. 열차가 무정차 통과합니다. 인근 역 또는 셔틀버스를 이용해 주세요.`,
  },
};

export interface StructuredEvent {
  kind: AlertRecord["kind"];
  title: string;
  data: Record<string, string | number>;
  sopRef?: string;
}

export interface LLMAdapter {
  summarize(input: StructuredEvent): Promise<string>;
  answerWhatIf(
    question: string,
    ruleResult: unknown,
    sopExcerpt: string,
  ): Promise<string>;
  generateMultilingual(
    type: MessageType,
    v: Record<string, string>,
  ): Record<Lang, string>;
}

const OPENERS = ["系統偵測顯示，", "根據即時資料研判，", "指揮中心研判，"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * MVP 實作：100% 前端、零外部依賴。判定邏輯已由規則引擎完成，
 * 這裡只負責把結構化結果轉譯成自然語言，demo 不會因網路/API 失敗而中斷。
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TemplateLLMAdapter implements LLMAdapter {
  async summarize(input: StructuredEvent): Promise<string> {
    // 刻意延遲 0.5~1 秒，讓 UI 呈現「規則判定」與「LLM 生成」是分開兩步（見 Dev spec §6）
    await delay(500 + Math.random() * 500);
    const opener = pick(OPENERS);
    const { kind, data } = input;

    switch (kind) {
      case "city_response":
        return `${opener}${data.segmentName}目前飽和度達 ${data.saturation}，已升級為 ${data.tier} 級。已通報交控中心啟動長綠燈時制，替代道路綠燈配時 +25%，並調度警力淨空路口。${input.sopRef ? `（依據 ${input.sopRef}）` : ""}`;

      case "accident":
        return `${opener}${data.segmentName}因${data.incidentDesc}已${data.statusLabel}，判定為 ${data.severity} 等級事故。建議主疏散路徑改道${data.mainRoute}，預計延誤 ${data.ete} 分鐘${data.congestionWarning === "true" ? "；疏散路徑亦壅塞，建議併行大眾運輸" : ""}。${input.sopRef ? `（依據 ${input.sopRef}）` : ""}`;

      case "mrt_diversion":
        return `${opener}${data.stationName}人流已達 ${data.userCount} 人、成長率 ${data.growthRate}，建議列車「過站不停」並啟動接駁專車，引導旅客步行至鄰站。${input.sopRef ? `（依據 ${input.sopRef}）` : ""}`;

      case "dome_dispersal":
        return `${opener}大巨蛋人流歷史峰值已達 ${data.peak} 人，目前成長率 ${data.growthRate}（散場趨勢），已標記「散場啟動」並提前連動接駁機制。${input.sopRef ? `（依據 ${input.sopRef}）` : ""}`;

      case "signal_failure":
        return `${opener}${data.segmentName}發生號誌故障，已產出人工指揮派遣建議（每路口配置警力 2 人），CMS 同步加註提醒駕駛依現場指揮通行。${input.sopRef ? `（依據 ${input.sopRef}）` : ""}`;

      case "multilingual":
        return `${opener}${data.stationName}偵測到國際漫遊用戶佔比達 ${data.roamingPct}，已依規定產出中／英／日／韓多語通報內容。${input.sopRef ? `（依據 ${input.sopRef}）` : ""}`;

      default:
        return `${opener}事件已由規則引擎判定完成。`;
    }
  }

  async answerWhatIf(
    question: string,
    ruleResult: unknown,
    sopExcerpt: string,
  ): Promise<string> {
    await delay(500 + Math.random() * 500);
    const resultText =
      typeof ruleResult === "object"
        ? JSON.stringify(ruleResult)
        : String(ruleResult);
    return `針對您的問題「${question}」，規則引擎重新代入情境計算後結果如下：${resultText}。\n\n依據 SOP 原文：「${sopExcerpt.trim().slice(0, 220)}...」`;
  }

  generateMultilingual(
    type: MessageType,
    v: Record<string, string>,
  ): Record<Lang, string> {
    const t = MSG_TEMPLATES[type];
    return {
      zh: t.zh(v),
      en: t.en(v),
      ja: t.ja(v),
      ko: t.ko(v),
    };
  }
}

export const llmAdapter: LLMAdapter = new TemplateLLMAdapter();

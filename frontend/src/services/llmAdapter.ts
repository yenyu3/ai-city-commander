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

/** 市民模式問答用的即時概況（只含可公開資訊，不含門檻／SOP 條號）。 */
export interface PublicContext {
  /** 目前非 Normal 或為事故來源的路段，依飽和度由高到低 */
  affectedRoads: { name: string; tier: string }[];
  busiestStation: { name: string; userCount: number } | null;
  activeIncidentCount: number;
}

export interface LLMAdapter {
  summarize(input: StructuredEvent): Promise<string>;
  answerWhatIf(
    question: string,
    ruleResult: unknown,
    sopExcerpt: string,
  ): Promise<string>;
  /** 市民模式：同樣的規則引擎結果，改用白話、去敏感化的說法回覆。 */
  answerPublic(
    question: string,
    ruleResult: unknown,
    context: PublicContext,
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

type PublicRuleResult = {
  rule?: string;
  triggered?: boolean;
  tier?: string;
  ete?: number;
};

/** 問題裡帶了具體數字、規則引擎真的算過時，把結論轉成白話（不揭露門檻）。 */
function publicRuleAnswer(result: PublicRuleResult): string | null {
  switch (result.rule) {
    case "checkMrtDiversion":
      return result.triggered
        ? "以您提到的人潮量，捷運站會啟動人流管制，列車可能過站不停，建議改到鄰近車站搭車，或改搭接駁專車。"
        : "以您提到的人潮量，捷運仍會正常停靠，依原本路線搭乘即可。";
    case "checkDomeDispersal":
      return result.triggered
        ? "這樣的人潮變化屬於散場時段，場館周邊會湧入大量人流，建議散場後稍等 15 分鐘再離開，或改走周邊街廓。"
        : "這樣的人潮變化還沒到散場尖峰，場館周邊人流大致穩定。";
    case "checkMultilingualNeeded":
      return result.triggered
        ? "該區域外籍旅客比例偏高，官方提醒會同時以中／英／日／韓四種語言發布，可以直接轉發給同行的旅客。"
        : "該區域外籍旅客比例不高，目前以中文提醒發布即可。";
    case "getTier":
      if (result.tier === "A") {
        return "這個壅塞程度屬於最嚴重的等級，路段幾乎動彈不得，強烈建議改道或改搭大眾運輸。";
      }
      if (result.tier === "B") {
        return "這個壅塞程度屬於車多壅擠，通行會明顯延誤，建議多預留時間或改走替代道路。";
      }
      return "這個壅塞程度還在正常範圍，通行大致順暢。";
    case "calcETE":
      return `依這個情境估算，恢復順暢大約還需要 ${result.ete} 分鐘，建議這段時間先改走其他路線。`;
    default:
      return null;
  }
}

/** 沒有具體數字時，改用目前的即時路況回答常見的市民提問。 */
function publicContextAnswer(question: string, ctx: PublicContext): string {
  const roads = ctx.affectedRoads.slice(0, 3).map((r) => r.name).join("、");
  const station = ctx.busiestStation;

  if (/英文|外語|多語|旅客|外國|english|visitor|foreign/i.test(question)) {
    const location = ctx.affectedRoads[0]?.name ?? "市中心";
    return [
      "以下是可以直接轉發給旅客的雙語提醒：",
      `【交通提醒】${location}周邊車流量大，請預留額外通行時間，或改搭捷運。`,
      `[Traffic Advisory] Heavy traffic near ${location}. Please allow extra travel time or take the MRT.`,
    ].join("\n");
  }

  if (/避開|避免|哪些區|哪幾|不要去|avoid|which area/i.test(question)) {
    return roads
      ? `目前建議避開：${roads}。這幾個路段車流較滿，非必要請改走周邊道路或改搭大眾運輸。`
      : "目前沒有需要特別避開的區域，主要道路都算順暢，依原本路線移動即可。";
  }

  if (/人潮|人多|擁擠|車站|捷運站|crowd|station/i.test(question)) {
    return station
      ? `目前人潮最多的是${station.name}，約 ${station.userCount.toLocaleString()} 人。建議避開尖峰，或從鄰近站點進出。`
      : "目前各站點人潮都在正常範圍內。";
  }

  if (/適合|現在|要去|出發|前往|該不該|is it ok|good time|go to|travel/i.test(question)) {
    const head = roads
      ? `${roads}一帶目前比較壅塞，建議改走周邊道路或改搭捷運，並多預留一點時間。`
      : "目前主要道路狀況穩定，現在出發沒有問題。";
    const tail = station ? `另外${station.name}人潮較多，可考慮從鄰近站點進出。` : "";
    return [head, tail].filter(Boolean).join("\n");
  }

  return [
    roads ? `目前需要留意的路段有：${roads}。` : "目前主要道路狀況穩定。",
    ctx.activeIncidentCount > 0
      ? `市區有 ${ctx.activeIncidentCount} 件事件處理中，公開資訊會以官方可發布內容為準。`
      : "目前沒有進行中的重大公開事件。",
    "您可以問我「哪幾個區域建議避開」或「現在適合出門嗎」。",
  ].join("\n");
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

  async answerPublic(
    question: string,
    ruleResult: unknown,
    context: PublicContext,
  ): Promise<string> {
    await delay(400 + Math.random() * 400);
    const fromRule = publicRuleAnswer((ruleResult ?? {}) as PublicRuleResult);
    return fromRule ?? publicContextAnswer(question, context);
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

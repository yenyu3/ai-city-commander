import { checkMrtDiversion } from "../engine/mrtDiversion";
import { checkDomeDispersal } from "../engine/domeDispersal";
import { checkMultilingualNeeded } from "../engine/multilingualCheck";
import { getTier } from "../engine/congestionTier";
import { calcETE } from "../engine/ete";
import { retrieveRelevantSections } from "./sopRetrieval";
import type { CrowdSnapshot } from "../types";

function parseFirstNumber(text: string): number | null {
  // 先移除站點/路段代號（如 BL17、RD_TPE_002）避免誤把代號裡的數字當成情境數值
  const cleaned = text
    .replace(/[A-Za-z]{1,4}[_-]?\d{1,4}\b/g, "")
    .replace(/,/g, "");
  const match = cleaned.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function parsePercentNumber(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) / 100 : null;
}

export interface ChatAnswer {
  ruleResult: unknown;
  sopExcerpt: string;
  sopRefs: string[];
}

/**
 * 兩段式問答的第一段：先用問題中的數字/情境跑一次對應規則引擎，
 * 回傳結構化結果 + 命中的 SOP 段落原文，交給 LLM Adapter 生成最終文字。
 */
export function runWhatIf(question: string): ChatAnswer {
  const sections = retrieveRelevantSections(question, 2);
  const sopExcerpt = sections.map((s) => `[SOP §${s.id} ${s.title}]\n${s.text}`).join("\n\n");
  const sopRefs = sections.map((s) => `SOP 第${s.id}條`);

  // 情境 1：捷運 BL17 人數/成長率 what-if
  if (/BL17|國父紀念館|捷運/.test(question) && /人數|人潮|成長|growth/.test(question)) {
    const userCount = parseFirstNumber(question) ?? 0;
    const growthRate = /成長率/.test(question)
      ? (parsePercentNumber(question) ?? 0)
      : 0;
    const snapshot: CrowdSnapshot = {
      observedAt: "what-if",
      stationId: "BS_MRT_BL17",
      locationName: "捷運國父紀念館站",
      userCount,
      stayTimeAvgMinutes: 0,
      growthRate,
      roamingUserPct: 0,
    };
    const triggered = checkMrtDiversion(snapshot);
    return {
      ruleResult: {
        rule: "checkMrtDiversion",
        input: { userCount, growthRate },
        triggered,
        threshold: "growthRate > 0.30 或 userCount > 25,000",
      },
      sopExcerpt,
      sopRefs,
    };
  }

  // 情境 2：大巨蛋散場 what-if
  if (/大巨蛋|DOME/.test(question)) {
    const peak = parseFirstNumber(question) ?? 0;
    const growthMatch = question.match(/-?\d+(?:\.\d+)?\s*%/);
    const growthRate = growthMatch ? Number(growthMatch[0].replace("%", "")) / 100 : -0.25;
    const triggered = checkDomeDispersal(
      [
        {
          observedAt: "history",
          stationId: "BS_TPE_DOME",
          locationName: "大巨蛋場館內",
          userCount: peak,
          stayTimeAvgMinutes: 0,
          growthRate: 0,
          roamingUserPct: 0,
        },
      ],
      {
        observedAt: "what-if",
        stationId: "BS_TPE_DOME",
        locationName: "大巨蛋場館內",
        userCount: peak,
        stayTimeAvgMinutes: 0,
        growthRate,
        roamingUserPct: 0,
      },
    );
    return {
      ruleResult: {
        rule: "checkDomeDispersal",
        input: { historicalPeak: peak, growthRate },
        triggered,
        threshold: "歷史峰值 >= 30,000 且 growthRate <= -0.20",
      },
      sopExcerpt,
      sopRefs,
    };
  }

  // 情境 3：國際漫遊比例 what-if
  if (/漫遊|roaming/.test(question) && /%/.test(question)) {
    const pct = parsePercentNumber(question) ?? 0;
    const result = checkMultilingualNeeded([
      {
        observedAt: "what-if",
        stationId: "BS_XY",
        locationName: "假設站點",
        userCount: 0,
        stayTimeAvgMinutes: 0,
        growthRate: 0,
        roamingUserPct: pct,
      },
    ]);
    return {
      ruleResult: {
        rule: "checkMultilingualNeeded",
        input: { roamingPct: pct },
        triggered: result.length > 0,
        threshold: "roamingPct >= 30%",
      },
      sopExcerpt,
      sopRefs,
    };
  }

  // 情境 4：飽和度分級 what-if
  if (/飽和度|saturation/.test(question)) {
    const sat = (() => {
      const m = question.match(/0\.\d+/);
      if (m) return Number(m[0]);
      const pctMatch = question.match(/(\d+(?:\.\d+)?)\s*%/);
      if (pctMatch) return Number(pctMatch[1]) / 100;
      return null;
    })();
    if (sat !== null) {
      const tier = getTier(sat);
      return {
        ruleResult: {
          rule: "getTier",
          input: { saturation: sat },
          tier,
          threshold: "B: 0.85~0.95、A: >=0.95",
        },
        sopExcerpt,
        sopRefs,
      };
    }
  }

  // 情境 5：ETE what-if（給定嚴重度與平均飽和度）
  if (/ETE|恢復時間|延誤/.test(question)) {
    const severityMatch = question.match(/Critical|High|Medium|重大|嚴重|中度/);
    const severity =
      severityMatch?.[0] === "重大" || severityMatch?.[0] === "嚴重" || severityMatch?.[0] === "Critical"
        ? "Critical"
        : severityMatch?.[0] === "中度" || severityMatch?.[0] === "Medium"
          ? "Medium"
          : "High";
    const satMatch = question.match(/0\.\d+/);
    const avgSaturation = satMatch ? Number(satMatch[0]) : 0.8;
    const result = calcETE(severity, avgSaturation);
    return {
      ruleResult: { rule: "calcETE", input: { severity, avgSaturation }, ...result },
      sopExcerpt,
      sopRefs,
    };
  }

  // 預設：沒有偵測到具體數字情境，僅回傳命中的 SOP 段落供 LLM 說明
  return {
    ruleResult: { rule: "sop_lookup_only", matchedSections: sections.map((s) => s.id) },
    sopExcerpt,
    sopRefs,
  };
}

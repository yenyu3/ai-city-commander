"""Canned Chinese/English/Japanese/Korean fallback text, ported from
frontend/src/services/llmAdapter.ts (TemplateLLMAdapter). Used whenever no
LLM client is configured yet (see agent.llm_client.get_configured_llm_client)
so the API always returns something demo-able instead of erroring out --
same resilience property the frontend adapter already has.
"""
from __future__ import annotations

import json
import random
from typing import Callable, Optional

Lang = str  # "zh" | "en" | "ja" | "ko"

MSG_TEMPLATES: dict[str, dict[Lang, Callable[[dict[str, str]], str]]] = {
    "congestion": {
        "zh": lambda v: f"【交通壅塞提醒】{v['location']}周邊交通壅塞，預計恢復時間約{v['ete']}分鐘，請提前規劃行程。",
        "en": lambda v: f"[Traffic Alert] Congestion near {v['location']}. Estimated clearance ~{v['ete']} min. Please plan ahead.",
        "ja": lambda v: f"【交通渋滞のお知らせ】{v['location']}周辺で渋滞が発生しています。復旧まで約{v['ete']}分の見込みです。",
        "ko": lambda v: f"[교통 혼잡 안내] {v['location']} 부근 혼잡 발생. 예상 복구 시간 약 {v['ete']}분입니다.",
    },
    "accident_detour": {
        "zh": lambda v: f"{v['segment']}封閉，請改道{v['detour']}，預計延誤{v['ete']}分鐘。",
        "en": lambda v: f"{v['segment']} closed. Please detour via {v['detour']}. Estimated delay {v['ete']} min.",
        "ja": lambda v: f"{v['segment']}は閉鎖されています。{v['detour']}へ迂回してください。遅延見込み{v['ete']}分。",
        "ko": lambda v: f"{v['segment']} 폐쇄. {v['detour']}(으)로 우회하시기 바랍니다. 예상 지연 {v['ete']}분.",
    },
    "signal_failure": {
        "zh": lambda v: f"{v['segment']} 號誌故障，請依現場人工指揮通行，預計排除時間約{v['ete']}分鐘。",
        "en": lambda v: f"Signal failure at {v['segment']}. Please follow on-site traffic control. Estimated resolution ~{v['ete']} min.",
        "ja": lambda v: f"{v['segment']} で信号故障が発生しています。現場の誘導に従ってください。復旧見込み約{v['ete']}分。",
        "ko": lambda v: f"{v['segment']} 신호 고장. 현장 수신호에 따라 주행하시기 바랍니다. 예상 복구 시간 약 {v['ete']}분.",
    },
    "mrt_diversion": {
        "zh": lambda v: f"【捷運壅塞通知】{v['location']}人潮眾多，列車將過站不停，請改往鄰站或改搭接駁專車。",
        "en": lambda v: f"[MRT Alert] Heavy crowd at {v['location']}. Trains will skip this stop; please use the adjacent station or shuttle bus.",
        "ja": lambda v: f"【MRT混雑のお知らせ】{v['location']}周辺は大変混雑しています。列車は通過運転となります。隣駅または送迎バスをご利用ください。",
        "ko": lambda v: f"[MRT 안내] {v['location']} 혼잡. 열차가 무정차 통과합니다. 인근 역 또는 셔틀버스를 이용해 주세요.",
    },
}

_OPENERS = ["系統偵測顯示，", "根據即時資料研判，", "指揮中心研判，"]


def generate_multilingual(message_type: str, v: dict[str, str]) -> dict[Lang, str]:
    templates = MSG_TEMPLATES[message_type]
    return {lang: fn(v) for lang, fn in templates.items()}


def summarize_fallback(kind: str, data: dict[str, str], sop_ref: Optional[str] = None) -> str:
    """Canned narration used when no LLM is configured. Mirrors
    TemplateLLMAdapter.summarize's per-kind branches in llmAdapter.ts."""
    opener = random.choice(_OPENERS)
    sop_suffix = f"（依據 {sop_ref}）" if sop_ref else ""

    if kind == "city_response":
        return (
            f"{opener}{data['segmentName']}目前飽和度達 {data['saturation']}，"
            f"已升級為 {data['tier']} 級。已通報交控中心啟動長綠燈時制，"
            f"替代道路綠燈配時 +25%，並調度警力淨空路口。{sop_suffix}"
        )
    if kind == "accident":
        congestion_note = (
            "；疏散路徑亦壅塞，建議併行大眾運輸"
            if data.get("congestionWarning") == "true"
            else ""
        )
        return (
            f"{opener}{data['segmentName']}因{data['incidentDesc']}已{data['statusLabel']}，"
            f"判定為 {data['severity']} 等級事故。建議主疏散路徑改道{data['mainRoute']}，"
            f"預計延誤 {data['ete']} 分鐘{congestion_note}。{sop_suffix}"
        )
    if kind == "mrt_diversion":
        return (
            f"{opener}{data['stationName']}人流已達 {data['userCount']} 人、"
            f"成長率 {data['growthRate']}，建議列車「過站不停」並啟動接駁專車，"
            f"引導旅客步行至鄰站。{sop_suffix}"
        )
    if kind == "dome_dispersal":
        return (
            f"{opener}大巨蛋人流歷史峰值已達 {data['peak']} 人，目前成長率 {data['growthRate']}"
            f"（散場趨勢），已標記「散場啟動」並提前連動接駁機制。{sop_suffix}"
        )
    if kind == "signal_failure":
        return (
            f"{opener}{data['segmentName']}發生號誌故障，已產出人工指揮派遣建議"
            f"（每路口配置警力 2 人），CMS 同步加註提醒駕駛依現場指揮通行。{sop_suffix}"
        )
    if kind == "multilingual":
        return (
            f"{opener}{data['stationName']}偵測到國際漫遊用戶佔比達 {data['roamingPct']}，"
            f"已依規定產出中／英／日／韓多語通報內容。{sop_suffix}"
        )
    return f"{opener}事件已由規則引擎判定完成。"


def answer_what_if_fallback(question: str, rule_result: object, sop_excerpt: str) -> str:
    result_text = (
        json.dumps(rule_result, ensure_ascii=False)
        if isinstance(rule_result, (dict, list))
        else str(rule_result)
    )
    excerpt = sop_excerpt.strip()[:220]
    return (
        f"針對您的問題「{question}」，規則引擎重新代入情境計算後結果如下：{result_text}。\n\n"
        f"依據 SOP 原文：「{excerpt}...」"
    )

"""Structured SOP section data + naive keyword retrieval, ported from
frontend/src/services/sopRetrieval.ts. Matches the shape of the `sop_sections`
DB table (id, title, keywords, body, display_order).

This keyword match is a placeholder candidate-retrieval step for the
free-text What-if chat only. It is NOT how SOP-trigger decisions get made --
those stay in `rules/` as deterministic checks. See the
feedback-agent-architecture-compute-vs-generate memory: the user wants an
actual reasoning sub-agent to route structured-event -> SOP-article
selection, not embedding/keyword similarity; that sub-agent is not built yet.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SopSection:
    id: str
    title: str
    keywords: tuple[str, ...]
    text: str


SOP_SECTIONS: list[SopSection] = [
    SopSection(
        id="1",
        title="交通擁塞級別判定",
        keywords=("分級", "B級", "A級", "壅擠", "癱瘓", "長綠燈", "觸發路段", "紅燈", "黃燈"),
        text=(
            "分級 (適用全 15 路段，決定 Dashboard 紅黃燈顯示)：\n"
            "   - B 級 (壅擠 / 黃燈)：0.85 <= Saturation_Score < 0.95。\n"
            "   - A 級 (癱瘓 / 紅燈)：Saturation_Score >= 0.95。\n\n"
            "城市應變觸發路段：忠孝東路 (RD_TPE_001)、光復南路 (RD_TPE_002)。\n"
            "   - 任一觸發路段達 B 級：通報交控中心啟動「長綠燈時制」，\n"
            "     將其替代道路 (見該路段 alternatives) 綠燈配時 +25%，並調度警力淨空路口。\n"
            "   - 達 A 級：除上述外，同步觸發替代路徑引導 (見第 2 條)。"
        ),
    ),
    SopSection(
        id="2",
        title="車禍與路障應變",
        keywords=(
            "車禍", "路障", "封閉", "疏散", "CMS", "capacity", "容量", "替代道路", "改道", "上游", "下游",
        ),
        text=(
            "觸發條件：事件同時符合三項：\n"
            "   (1) status 屬於 {Closed, Blocked, Restricted}\n"
            "   (2) severity 屬於 {High, Critical}\n"
            "   (3) affected_segment 以 RD_ 開頭 (BS_ 人流類事件改由第 3 條處理)\n\n"
            "處置步驟：\n"
            "   a. 主疏散路徑：從事故路段的 alternatives 中，篩選同時滿足者：\n"
            "        (1) capacity_vph >= 1000；\n"
            "        (2) 與事故路段直接相交 (出現在其 intersections 中)；\n"
            "        (3) 相交路口位於事故點上游 (依 flow_direction 與 intersections\n"
            "            之上游至下游排序判定)。\n"
            "      取通過篩選且 Saturation_Score 最低者為主疏散；位於下游之相交幹道僅列次要疏散。\n"
            "      若主疏散路段已壅塞 (Saturation_Score >= 0.85)，仍維持該路徑並啟動「長綠燈時制」，\n"
            "      於報告註明壅塞並建議併行大眾運輸。\n"
            "   b. 產出 CMS 文字：「<事故路段>封閉，請改道 <主疏散路段>，預計延誤 <ETE> 分鐘」\n"
            "      (ETE 依第 7 條公式計算。)"
        ),
    ),
    SopSection(
        id="3",
        title="捷運與接駁分流",
        keywords=("捷運", "過站不停", "接駁", "BL17", "人數", "growth", "成長率"),
        text=(
            "觸發 (任一成立)：BS_MRT_BL17 Growth_Rate > 0.30，或 User_Count > 25,000。\n"
            "處置：建議北捷「過站不停」、通知公車處調度接駁專車、引導群眾步行至 BS_MRT_BL18。"
        ),
    ),
    SopSection(
        id="4",
        title="大巨蛋散場啟動",
        keywords=("大巨蛋", "散場", "DOME", "峰值"),
        text=(
            "觸發：BS_TPE_DOME User_Count 歷史峰值曾達 >= 30,000，且當前 Growth_Rate <= -0.20。\n"
            "處置：標記「散場啟動」，並提前連動第 3 條接駁機制。"
        ),
    ),
    SopSection(
        id="5",
        title="號誌故障應變",
        keywords=("號誌", "故障", "power", "人工指揮", "失效"),
        text=(
            "觸發：事件 type = \"Power_Failure\"，或描述含「號誌失效 / 故障」。\n"
            "處置：產出人工指揮派遣建議 (受影響路段、警力人數每路口 2 人、估計持續時間)；\n"
            "      CMS 加註「<路段> 號誌故障，請依現場指揮通行」。"
        ),
    ),
    SopSection(
        id="6",
        title="數位通報與多語化",
        keywords=("漫遊", "多語", "roaming", "簡訊", "語言"),
        text=(
            "觸發：任一基地台 Roaming_User_Pct >= 30%。\n"
            "處置：該區域之簡訊與看板訊息須同時含多國語言，並於同一回應產出。\n"
            "時間格式統一為 YYYY-MM-DD HH:MM。"
        ),
    ),
    SopSection(
        id="7",
        title="預計恢復時間ETE",
        keywords=("ETE", "恢復時間", "base_clearance", "penalty", "延誤"),
        text=(
            "ETE_minutes = base_clearance + congestion_penalty\n"
            "   - base_clearance：Critical = 60、High = 40、Medium = 20 (分鐘)。\n"
            "   - congestion_penalty = (受影響路段平均 Saturation_Score - 0.5) * 60，小於 0 以 0 計。\n"
            "報告須註明 ETE 數值與計算依據。"
        ),
    ),
]


def retrieve_relevant_sections(question: str, top_n: int = 2) -> list[SopSection]:
    scored: list[tuple[int, SopSection]] = []
    for section in SOP_SECTIONS:
        score = sum(1 for kw in section.keywords if kw in question)
        if section.title in question:
            score += 2
        scored.append((score, section))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    hits = [section for score, section in scored if score > 0][:top_n]
    return hits if hits else [SOP_SECTIONS[0]]

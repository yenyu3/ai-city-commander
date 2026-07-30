"""SOP Article 1: congestion tier classification."""
from __future__ import annotations

from typing import Optional

from .types import CityResponseResult, Tier

CITY_TRIGGER_SEGMENTS = ["RD_TPE_001", "RD_TPE_002"]


def get_tier(saturation: float) -> Tier:
    if saturation >= 0.95:
        return "A"
    if saturation >= 0.85:
        return "B"
    return "Normal"


def check_city_response(segment_id: str, tier: Tier) -> Optional[CityResponseResult]:
    if segment_id not in CITY_TRIGGER_SEGMENTS:
        return None
    if tier == "Normal":
        return None

    actions = [
        "通報交控中心啟動「長綠燈時制」",
        "替代道路綠燈配時 +25%",
        "調度警力淨空路口",
    ]
    if tier == "A":
        actions.append("同步觸發替代路徑引導（見事故應變規則）")
    return CityResponseResult(segment_id=segment_id, tier=tier, actions=actions)

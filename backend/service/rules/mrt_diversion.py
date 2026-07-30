"""SOP Article 3: MRT / shuttle diversion trigger."""
from __future__ import annotations

from .types import CrowdSnapshot


def check_mrt_diversion(bl17: CrowdSnapshot) -> bool:
    return bl17.growth_rate > 0.3 or bl17.user_count > 25000

"""SOP Article 4: dome (大巨蛋) dispersal trigger."""
from __future__ import annotations

from .types import CrowdSnapshot


def check_dome_dispersal(
    dome_history: list[CrowdSnapshot], current: CrowdSnapshot
) -> bool:
    historical_peak = max([0] + [d.user_count for d in dome_history])
    return historical_peak >= 30000 and current.growth_rate <= -0.2

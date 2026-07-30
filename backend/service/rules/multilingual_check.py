"""SOP Article 6: multilingual notification trigger."""
from __future__ import annotations

from .types import CrowdSnapshot


def check_multilingual_needed(
    stations: list[CrowdSnapshot],
) -> list[CrowdSnapshot]:
    return [s for s in stations if s.roaming_pct >= 0.3]

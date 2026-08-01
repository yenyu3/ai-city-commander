"""SOP Article 7: estimated time to (traffic) equilibrium / recovery."""
from __future__ import annotations

from .types import EteResult

BASE_CLEARANCE = {"Critical": 60, "High": 40, "Medium": 20}


def calc_ete(severity: str, avg_saturation: float) -> EteResult:
    base = BASE_CLEARANCE.get(severity, 20)
    penalty = round(max(0.0, (avg_saturation - 0.5) * 60), 1)
    ete = round(base + penalty)
    breakdown = (
        f"base_clearance({severity})={base} + "
        f"congestion_penalty=({avg_saturation:.2f}-0.5)×60={penalty:.1f} "
        f"→ ETE={ete}分鐘"
    )
    return EteResult(ete=ete, base=base, penalty=penalty, breakdown=breakdown)

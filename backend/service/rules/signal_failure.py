"""SOP Article 5: signal failure trigger."""
from __future__ import annotations

import re

from .types import LiveIncident

_FAILURE_PATTERN = re.compile("號誌失效|故障")


def check_signal_failure(incident: LiveIncident) -> bool:
    return incident.type == "Power_Failure" or bool(
        _FAILURE_PATTERN.search(incident.description)
    )

"""SOP Article 5: signal failure trigger."""
from __future__ import annotations

import re

from .types import LiveIncident

# 2026-08-02: was `號誌失效|故障` -- required "號誌失效" as one contiguous
# substring, which missed natural phrasing like "號誌同時失效" (a real
# incident description used this session), where "同時" sits between the
# two halves. `decide_signal_failure()`'s LLM path correctly read that as
# a signal failure (matching the SOP text's actual intent -- "描述含「號誌
# 失效／故障」" isn't meant as a strict four-character substring test);
# this regex was the one that was wrong, caught via eval/
# llm_vs_rules_consistency.py's §5 false positives. `.{0,6}` allows a
# short gap between "號誌" and "失效" without turning into a match on
# unrelated text.
_FAILURE_PATTERN = re.compile("號誌.{0,6}失效|故障")


def check_signal_failure(incident: LiveIncident) -> bool:
    return incident.type == "Power_Failure" or bool(
        _FAILURE_PATTERN.search(incident.description)
    )

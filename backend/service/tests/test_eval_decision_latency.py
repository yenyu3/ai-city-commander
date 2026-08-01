"""Tests for eval/decision_latency.py's percentile math and summary
reporting -- pure logic, no DB/LLM/S3 needed."""
from __future__ import annotations

import io
from contextlib import redirect_stdout

from eval.decision_latency import _percentile, summarize


def test_percentile_p50_of_odd_length_is_the_middle_value():
    assert _percentile([1.0, 2.0, 3.0], 0.5) == 2.0


def test_percentile_p0_is_the_minimum():
    assert _percentile([1.0, 2.0, 3.0], 0.0) == 1.0


def test_percentile_p100_is_the_maximum():
    assert _percentile([1.0, 2.0, 3.0], 1.0) == 3.0


def test_percentile_empty_list_is_nan_not_a_crash():
    result = _percentile([], 0.5)
    assert result != result  # nan != nan


def test_summarize_reports_over_budget_count():
    out = io.StringIO()
    with redirect_stdout(out):
        summarize([10.0, 20.0, 70.0, 90.0], budget_seconds=60.0)
    text = out.getvalue()
    assert "Over 60s budget  : 2/4" in text


def test_summarize_empty_does_not_crash():
    out = io.StringIO()
    with redirect_stdout(out):
        summarize([])
    assert "No measurements collected." in out.getvalue()

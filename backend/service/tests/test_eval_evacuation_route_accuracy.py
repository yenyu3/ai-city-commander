"""Tests for eval/evacuation_route_accuracy.py's scoring/reporting -- pure
logic, no DB/LLM needed."""
from __future__ import annotations

import io
from contextlib import redirect_stdout

from eval.evacuation_route_accuracy import _RouteResult, summarize


def test_all_match_reports_100_percent():
    results = [
        _RouteResult("RD_A", True, True, True, "RD_B", "RD_B", ["RD_C"], ["RD_C"]),
    ]
    out = io.StringIO()
    with redirect_stdout(out):
        summarize(results)
    text = out.getvalue()
    assert "Main route exact match   : 1/1 (100.0%)" in text


def test_mismatch_is_reported_with_both_choices():
    results = [
        _RouteResult("RD_A", True, False, False, "RD_X", "RD_Y", [], []),
    ]
    out = io.StringIO()
    with redirect_stdout(out):
        summarize(results)
    text = out.getvalue()
    assert "Main route exact match   : 0/1 (0.0%)" in text
    assert "RD_A: LLM chose 'RD_X', rules/ chose 'RD_Y'" in text


def test_no_mismatch_section_when_everything_matches():
    results = [_RouteResult("RD_A", True, True, True, "RD_B", "RD_B", [], [])]
    out = io.StringIO()
    with redirect_stdout(out):
        summarize(results)
    assert "Main route mismatches" not in out.getvalue()


def test_empty_results_does_not_crash():
    out = io.StringIO()
    with redirect_stdout(out):
        summarize([])  # must not raise (no segments had alternatives, edge case)
    assert "Segments evaluated       : 0" in out.getvalue()

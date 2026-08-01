"""Tests for eval/router_precision_recall.py's scoring math -- pure logic,
no DB/LLM/S3 needed. Verifies precision/recall/F1 are computed correctly
against hand-constructed router vs. authoritative sets, independent of
whether the real evaluation run (which does need a live LLM + DB) has ever
been executed.
"""
from __future__ import annotations

import io
from contextlib import redirect_stdout

from eval.router_precision_recall import _TickResult, summarize


def test_perfect_match_is_precision_and_recall_1():
    results = [_TickResult("t1", {("congestion", "RD_A")}, {("congestion", "RD_A")})]
    out = io.StringIO()
    with redirect_stdout(out):
        summarize(results)
    text = out.getvalue()
    assert "Precision              : 1.000" in text
    assert "Recall                 : 1.000" in text


def test_false_positive_lowers_precision_not_recall():
    """Router over-flags one extra thing Phase B denies -- precision drops,
    recall stays perfect since everything Phase B confirmed WAS caught."""
    results = [_TickResult(
        "t1",
        router_set={("congestion", "RD_A"), ("congestion", "RD_B")},
        authoritative_set={("congestion", "RD_A")},
    )]
    out = io.StringIO()
    with redirect_stdout(out):
        summarize(results)
    text = out.getvalue()
    assert "Precision              : 0.500" in text
    assert "Recall                 : 1.000" in text


def test_false_negative_lowers_recall_not_precision():
    """Router misses something Phase B confirmed -- recall drops, precision
    stays perfect since everything the router DID flag was correct."""
    results = [_TickResult(
        "t1",
        router_set={("congestion", "RD_A")},
        authoritative_set={("congestion", "RD_A"), ("multilingual", "BS_X")},
    )]
    out = io.StringIO()
    with redirect_stdout(out):
        summarize(results)
    text = out.getvalue()
    assert "Precision              : 1.000" in text
    assert "Recall                 : 0.500" in text
    assert "multilingual @ BS_X" in text  # missed trigger is called out


def test_both_empty_is_nan_not_a_crash():
    """No triggers anywhere (a quiet timestamp) is a valid, common case --
    must not divide by zero."""
    results = [_TickResult("t1", set(), set())]
    out = io.StringIO()
    with redirect_stdout(out):
        summarize(results)  # must not raise
    assert "nan" in out.getvalue()


def test_aggregates_across_multiple_timestamps():
    results = [
        _TickResult("t1", {("congestion", "RD_A")}, {("congestion", "RD_A")}),
        _TickResult("t2", {("congestion", "RD_B")}, {("congestion", "RD_C")}),  # total miss + false positive
    ]
    out = io.StringIO()
    with redirect_stdout(out):
        summarize(results)
    text = out.getvalue()
    assert "True positives        : 1" in text
    assert "False positives        : 1" in text
    assert "False negatives        : 1" in text

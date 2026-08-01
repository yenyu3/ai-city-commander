"""Tests for eval/llm_vs_rules_consistency.py's _ArticleScore confusion-matrix
math -- pure logic, no DB/LLM needed."""
from __future__ import annotations

from eval.llm_vs_rules_consistency import _ArticleScore


def test_both_triggered_is_true_positive():
    score = _ArticleScore()
    score.record(llm_triggered=True, rules_triggered=True)
    assert score.true_positive == 1
    assert score.agreement_rate == 1.0


def test_both_not_triggered_is_true_negative():
    score = _ArticleScore()
    score.record(llm_triggered=False, rules_triggered=False)
    assert score.true_negative == 1
    assert score.agreement_rate == 1.0


def test_llm_over_triggers_is_false_positive():
    score = _ArticleScore()
    score.record(llm_triggered=True, rules_triggered=False)
    assert score.false_positive == 1
    assert score.agreement_rate == 0.0


def test_llm_under_triggers_is_false_negative():
    score = _ArticleScore()
    score.record(llm_triggered=False, rules_triggered=True)
    assert score.false_negative == 1
    assert score.agreement_rate == 0.0


def test_agreement_rate_aggregates_across_records():
    score = _ArticleScore()
    score.record(True, True)     # TP
    score.record(False, False)   # TN
    score.record(True, False)    # FP
    score.record(False, True)    # FN
    assert score.total == 4
    assert score.agreement_rate == 0.5


def test_empty_score_agreement_rate_is_nan_not_a_crash():
    score = _ArticleScore()
    assert score.total == 0
    rate = score.agreement_rate
    assert rate != rate  # nan != nan

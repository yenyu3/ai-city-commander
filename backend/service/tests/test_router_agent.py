"""Tests for agent/router_agent.py (Phase A route_triggers + Phase C
narrate_for_focus). Mirrors tests/test_decision_agent.py's conventions:
FakeLLMClient for the LLM path, no-LLM env for the fallback path -- never a
real network call.
"""
from __future__ import annotations

import json

import pytest

from agent.llm_client import LLMClient
from agent.router_agent import Narrative, Trigger, narrate_for_focus, route_triggers


class FakeLLMClient(LLMClient):
    def __init__(self, response: str):
        self.response = response
        self.calls: list[dict[str, str]] = []

    def complete(self, system: str, prompt: str, *, max_tokens: int = 1024) -> str:
        self.calls.append({"system": system, "prompt": prompt})
        return self.response


class RaisingLLMClient(LLMClient):
    def complete(self, system: str, prompt: str, *, max_tokens: int = 1024) -> str:
        raise RuntimeError("Maximum combo retry limit reached")


@pytest.fixture(autouse=True)
def no_llm_credentials(monkeypatch):
    monkeypatch.delenv("BEDROCK_AGENTCORE_RUNTIME_ARN", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OMNIROUTE_BASE_URL", raising=False)


class TestTriggerKind:
    def test_kind_is_derived_from_sop_section_id_not_trusted_from_the_model(self):
        assert Trigger(sop_section_id="1", location_id="RD_TPE_001").kind == "congestion"
        assert Trigger(sop_section_id="2", location_id="RD_TPE_002").kind == "accident"
        assert Trigger(sop_section_id="3", location_id="BS_MRT_BL17").kind == "mrt_diversion"
        assert Trigger(sop_section_id="4", location_id="BS_TPE_DOME").kind == "dome_dispersal"
        assert Trigger(sop_section_id="5", location_id="RD_TPE_007").kind == "signal_failure"
        assert Trigger(sop_section_id="6", location_id="BS_XY_ATT").kind == "multilingual"


class TestRouteTriggers:
    def test_no_client_uses_fallback(self):
        sentinel = [Trigger(sop_section_id="1", location_id="RD_TPE_001")]
        result = route_triggers({}, fallback=lambda: sentinel, llm_client=None)
        assert result is sentinel

    def test_valid_json_response_is_parsed_and_sop_section_id_normalized(self):
        fake = FakeLLMClient(
            json.dumps({"triggers": [{"sopSectionId": "第1條", "locationId": "RD_TPE_001"}]})
        )
        result = route_triggers({}, fallback=lambda: [], llm_client=fake)
        assert result == [Trigger(sop_section_id="1", location_id="RD_TPE_001")]
        assert len(fake.calls) == 1

    def test_items_missing_location_id_are_dropped(self):
        fake = FakeLLMClient(json.dumps({"triggers": [{"sopSectionId": "1"}]}))
        assert route_triggers({}, fallback=lambda: [], llm_client=fake) == []

    def test_invalid_json_falls_back(self):
        fake = FakeLLMClient("這不是 JSON")
        sentinel = [Trigger(sop_section_id="6", location_id="BS_XY_ATT")]
        result = route_triggers({}, fallback=lambda: sentinel, llm_client=fake)
        assert result is sentinel

    def test_client_exception_falls_back(self):
        sentinel: list[Trigger] = []
        result = route_triggers({}, fallback=lambda: sentinel, llm_client=RaisingLLMClient())
        assert result is sentinel


class TestNarrateForFocus:
    """narrate_for_focus returns a Narrative -- TWO independent texts
    (citizen_text/government_text), not one summary with an audience switch
    (2026-08-01: government_text used to simply not exist)."""

    def test_no_client_no_triggers_global(self):
        result = narrate_for_focus([], None, None, llm_client=None)
        assert isinstance(result, Narrative)
        assert result.citizen_text == "現在很順，免驚。"
        assert result.government_text == "目前無需處置事項。"

    def test_no_client_no_triggers_with_focus(self):
        result = narrate_for_focus([], "BS_MRT_BL18", "捷運市政府站", llm_client=None)
        assert result.citizen_text == "捷運市政府站現在很順。"
        assert result.government_text == "捷運市政府站目前無需處置事項。"

    def test_no_client_focus_own_message_used(self):
        items = [{
            "locationId": "BS_MRT_BL17", "publicMessage": "國父紀念館站人潮較多",
            "aiText": "BS_MRT_BL17 Growth_Rate 超過 SOP §3 門檻",
        }]
        result = narrate_for_focus(items, "BS_MRT_BL17", "捷運國父紀念館站", llm_client=None)
        assert "國父紀念館站人潮較多" in result.citizen_text
        assert "SOP §3" in result.government_text

    def test_no_client_focus_mentions_other_locations_while_staying_fine_itself(self):
        """This is the exact behavior the user asked for: focused on a fine
        location, but still told about trouble elsewhere -- in BOTH texts."""
        items = [{
            "locationId": "BS_MRT_BL17", "publicMessage": "國父紀念館站人潮較多，建議改往鄰近站點",
            "aiText": "BS_MRT_BL17 觸發 SOP §3",
        }]
        result = narrate_for_focus(items, "BS_MRT_BL18", "捷運市政府站", llm_client=None)
        assert "捷運市政府站現在很順" in result.citizen_text
        assert "國父紀念館站人潮較多" in result.citizen_text
        assert "捷運市政府站目前無需處置事項" in result.government_text
        assert "SOP §3" in result.government_text

    def test_no_client_global_joins_every_triggered_item_in_both_texts(self):
        items = [
            {"locationId": "RD_TPE_001", "publicMessage": "忠孝東路壅塞", "aiText": "RD_TPE_001 達 SOP §1 A級"},
            {"locationId": "BS_MRT_BL17", "publicMessage": "國父紀念館站人潮較多", "aiText": "BS_MRT_BL17 觸發 SOP §3"},
        ]
        result = narrate_for_focus(items, None, None, llm_client=None)
        assert "忠孝東路壅塞" in result.citizen_text
        assert "國父紀念館站人潮較多" in result.citizen_text
        assert "SOP §1" in result.government_text
        assert "SOP §3" in result.government_text

    def test_valid_json_response_is_parsed(self):
        fake = FakeLLMClient(json.dumps({"citizenText": "假的市民版", "governmentText": "假的政府版"}))
        result = narrate_for_focus([], None, None, llm_client=fake)
        assert result.citizen_text == "假的市民版"
        assert result.government_text == "假的政府版"

    def test_client_exception_falls_back(self):
        result = narrate_for_focus([], None, None, llm_client=RaisingLLMClient())
        assert result.citizen_text == "現在很順，免驚。"
        assert result.government_text == "目前無需處置事項。"

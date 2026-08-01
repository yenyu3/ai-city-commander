"""Tests for agent/router_agent.py (Phase A route_triggers + Phase C
narrate_for_focus). Mirrors tests/test_decision_agent.py's conventions:
FakeLLMClient for the LLM path, no-LLM env for the fallback path -- never a
real network call.
"""
from __future__ import annotations

import json

import pytest

from agent.llm_client import LLMClient
from agent.router_agent import Trigger, narrate_for_focus, route_triggers


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
    def test_no_client_no_triggers_global(self):
        assert narrate_for_focus([], None, None, llm_client=None) == "目前一切正常，無異常事件。"

    def test_no_client_no_triggers_with_focus(self):
        text = narrate_for_focus([], "BS_MRT_BL18", "捷運市政府站", llm_client=None)
        assert text == "捷運市政府站目前狀況正常。"

    def test_no_client_focus_own_message_used(self):
        items = [{"locationId": "BS_MRT_BL17", "publicMessage": "國父紀念館站人潮較多"}]
        text = narrate_for_focus(items, "BS_MRT_BL17", "捷運國父紀念館站", llm_client=None)
        assert "國父紀念館站人潮較多" in text

    def test_no_client_focus_mentions_other_locations_while_staying_fine_itself(self):
        """This is the exact behavior the user asked for: focused on a fine
        location, but still told about trouble elsewhere."""
        items = [{"locationId": "BS_MRT_BL17", "publicMessage": "國父紀念館站人潮較多，建議改往鄰近站點"}]
        text = narrate_for_focus(items, "BS_MRT_BL18", "捷運市政府站", llm_client=None)
        assert "捷運市政府站目前狀況正常" in text
        assert "國父紀念館站人潮較多" in text

    def test_no_client_global_summary_joins_every_triggered_item(self):
        items = [
            {"locationId": "RD_TPE_001", "publicMessage": "忠孝東路壅塞"},
            {"locationId": "BS_MRT_BL17", "publicMessage": "國父紀念館站人潮較多"},
        ]
        text = narrate_for_focus(items, None, None, llm_client=None)
        assert "忠孝東路壅塞" in text
        assert "國父紀念館站人潮較多" in text

    def test_valid_json_response_is_parsed(self):
        fake = FakeLLMClient(json.dumps({"text": "假的整合回覆"}))
        result = narrate_for_focus([], None, None, llm_client=fake)
        assert result == "假的整合回覆"

    def test_client_exception_falls_back(self):
        text = narrate_for_focus([], None, None, llm_client=RaisingLLMClient())
        assert text == "目前一切正常，無異常事件。"

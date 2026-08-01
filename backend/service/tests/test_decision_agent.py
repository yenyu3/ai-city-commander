"""Tests for the decision layer (agent/decision_agent.py + agent/facts.py).

Three things get verified per scenario:
  1. The facts assembled contain raw/unclassified data only -- no tier,
     no trigger boolean, no picked route -- proving the code doesn't sneak
     the judgment back in before handing off to the LLM.
  2. The LLM-calling path is wired correctly (prompt built, JSON response
     parsed) via a FakeLLMClient, never a real network call.
  3. The deterministic fallback (used when no LLM is configured, the call
     fails, or the response isn't valid JSON) still produces the same
     answers as the old rules/*.py-only architecture -- re-proving the
     ruleEngine.test.ts-derived cases via the fallback path, since that
     path is what's actually exercised whenever no provider is configured.
"""
from __future__ import annotations

import json

import pytest

from agent.decision_agent import Decision, decide
from agent.facts import (
    decide_accident,
    decide_congestion,
    decide_dome_dispersal,
    decide_mrt_diversion,
    decide_multilingual,
    decide_signal_failure,
)
from agent.llm_client import LLMClient
from rules.types import CrowdSnapshot, LiveIncident, RoadSegment


def seg(segment_id, name, flow_direction, intersections, intersection_ids, capacity_vph, alternatives):
    return RoadSegment(
        segment_id=segment_id,
        name=name,
        flow_direction=flow_direction,
        intersections=intersections,
        intersection_ids=intersection_ids,
        capacity_vph=capacity_vph,
        alternatives=alternatives,
        nearby_stations=[],
    )


SEGMENTS = {
    "RD_TPE_001": seg(
        "RD_TPE_001", "忠孝東路四段", "東西向",
        ["延吉街", "光復南路", "基隆路一段"],
        ["RD_TPE_008", "RD_TPE_002", "RD_TPE_003"],
        3000, ["RD_TPE_004", "RD_TPE_005", "RD_TPE_007"],
    ),
    "RD_TPE_002": seg(
        "RD_TPE_002", "光復南路", "南北向 (事故影響南下車流)",
        ["市民大道四段", "忠孝東路四段", "仁愛路四段"],
        ["RD_TPE_004", "RD_TPE_001", "RD_TPE_005"],
        1800, ["RD_TPE_004", "RD_TPE_005", "RD_TPE_006", "RD_TPE_008"],
    ),
    "RD_TPE_004": seg(
        "RD_TPE_004", "市民大道四段", "東西向",
        ["復興南路一段", "敦化南路一段", "光復南路"],
        ["RD_TPE_015", "RD_TPE_006", "RD_TPE_002"],
        2500, ["RD_TPE_001", "RD_TPE_006"],
    ),
    "RD_TPE_005": seg(
        "RD_TPE_005", "仁愛路四段", "東西向",
        ["敦化南路一段", "光復南路", "市府路"],
        ["RD_TPE_006", "RD_TPE_002", "RD_TPE_010"],
        4000, ["RD_TPE_001", "RD_TPE_010"],
    ),
    "RD_TPE_006": seg(
        "RD_TPE_006", "敦化南路一段", "南北向",
        ["市民大道四段", "忠孝東路四段", "仁愛路四段"],
        ["RD_TPE_004", "RD_TPE_001", "RD_TPE_005"],
        3200, ["RD_TPE_002", "RD_TPE_004", "RD_TPE_008"],
    ),
    "RD_TPE_008": seg(
        "RD_TPE_008", "延吉街", "南北向",
        ["忠孝東路四段", "仁愛路四段"],
        ["RD_TPE_001", "RD_TPE_005"],
        600, ["RD_TPE_002"],
    ),
}

INCIDENT_A = LiveIncident(
    event_id="TPE_2026_ACC_001",
    type="Road_Collapse_Accident",
    location="光復南路與忠孝東路口南側",
    affected_segment="RD_TPE_002",
    status="Closed",
    severity="Critical",
    description="地下管線爆裂導致路面塌陷並引發三車連環追撞，光復南路南下全線封鎖",
    timestamp="2026-05-20 22:10",
)


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


class TestDecisionAgentPrimitive:
    def test_no_client_uses_fallback(self):
        fallback = Decision(triggered=False, sop_section_id=None, source="fallback")
        result = decide({}, instructions="x", fallback=lambda: fallback, llm_client=None)
        assert result is fallback

    def test_valid_json_response_is_parsed(self):
        fake = FakeLLMClient(
            json.dumps(
                {
                    "triggered": True,
                    "sop_section_id": "1",
                    "result": {"tier": "A"},
                    "reasoning": "飽和度超過0.95",
                }
            )
        )
        result = decide({"x": 1}, instructions="判斷", fallback=lambda: Decision(False, None), llm_client=fake)
        assert result.triggered is True
        assert result.sop_section_id == "1"
        assert result.result == {"tier": "A"}
        assert result.source == "llm"
        assert len(fake.calls) == 1

    def test_markdown_fenced_json_is_parsed(self):
        fake = FakeLLMClient('```json\n{"triggered": false, "sop_section_id": null, "result": {}, "reasoning": "無"}\n```')
        result = decide({}, instructions="x", fallback=lambda: Decision(False, None), llm_client=fake)
        assert result.triggered is False
        assert result.source == "llm"

    def test_invalid_json_falls_back(self):
        fake = FakeLLMClient("這不是 JSON，是一段散文")
        fallback = Decision(triggered=True, sop_section_id="9", source="fallback")
        result = decide({}, instructions="x", fallback=lambda: fallback, llm_client=fake)
        assert result is fallback

    def test_client_exception_falls_back(self):
        fallback = Decision(triggered=False, sop_section_id=None, source="fallback")
        result = decide({}, instructions="x", fallback=lambda: fallback, llm_client=RaisingLLMClient())
        assert result is fallback


class TestDecideCongestionFacts:
    def test_facts_contain_no_precomputed_tier(self):
        fake = FakeLLMClient(
            json.dumps({"triggered": True, "sop_section_id": "1", "result": {"tier": "A"}, "reasoning": "x"})
        )
        decide_congestion("RD_TPE_001", "忠孝東路四段", 0.96, llm_client=fake)
        facts = json.loads(fake.calls[0]["prompt"].split("=== 本次情境的原始事實數據 ===\n")[1].split("\n\n=== ")[0])
        assert facts["saturation_score"] == 0.96
        assert "tier" not in facts  # the classification itself must not be pre-decided

    def test_fallback_matches_known_tier_and_action_counts(self):
        # same boundary values as ruleEngine.test.ts / test_rules.py
        result = decide_congestion("RD_TPE_001", "忠孝東路四段", 0.96, llm_client=None)
        assert result.source == "fallback"
        assert result.result["tier"] == "A"
        assert len(result.result["actions"]) == 4

        below_threshold = decide_congestion("RD_TPE_003", "基隆路一段", 0.99, llm_client=None)
        assert below_threshold.triggered is False  # not a city-trigger segment


class TestDecideAccidentFacts:
    def test_candidates_include_structural_facts_but_no_final_pick(self):
        fake = FakeLLMClient(
            json.dumps(
                {
                    "triggered": True,
                    "sop_section_id": "2",
                    "result": {"main_route": "RD_TPE_004"},
                    "reasoning": "x",
                }
            )
        )
        saturation = {"RD_TPE_002": 1.0, "RD_TPE_004": 0.78, "RD_TPE_005": 0.65}
        decide_accident(INCIDENT_A, SEGMENTS, saturation, llm_client=fake)
        prompt = fake.calls[0]["prompt"]
        facts = json.loads(prompt.split("=== 本次情境的原始事實數據 ===\n")[1].split("\n\n=== ")[0])

        candidate_ids = {c["segment_id"] for c in facts["candidate_alternative_routes"]}
        assert "RD_TPE_004" in candidate_ids
        rd_004 = next(c for c in facts["candidate_alternative_routes"] if c["segment_id"] == "RD_TPE_004")
        assert rd_004["capacity_vph"] == 2500
        assert rd_004["is_direct_intersection"] is True
        assert rd_004["current_saturation"] == 0.78
        # the code must not have already decided who wins -- no such key exists
        assert "main_route" not in facts
        assert "selected" not in facts

    def test_fallback_matches_known_evacuation_case(self):
        saturation = {
            "RD_TPE_002": 1.0, "RD_TPE_004": 0.78, "RD_TPE_005": 0.65,
            "RD_TPE_006": 0.72, "RD_TPE_008": 0.8,
        }
        result = decide_accident(INCIDENT_A, SEGMENTS, saturation, llm_client=None)
        assert result.source == "fallback"
        assert result.triggered is True
        assert result.result["main_route"] == "RD_TPE_004"
        assert result.result["secondary_routes"] == ["RD_TPE_005"]
        assert result.result["congestion_warning"] is False
        # SOP §7 ETE is merged in regardless of LLM/fallback source (pure
        # arithmetic, not a judgment) -- same golden value as test_rules.py's
        # avg=(1.0+0.78)/2 case.
        assert result.result["ete"] == 83

    def test_fallback_flags_congestion_when_main_route_saturates(self):
        saturation = {
            "RD_TPE_002": 1.0, "RD_TPE_004": 0.95, "RD_TPE_005": 0.85,
            "RD_TPE_006": 0.98, "RD_TPE_008": 1.0,
        }
        result = decide_accident(INCIDENT_A, SEGMENTS, saturation, llm_client=None)
        assert result.result["main_route"] == "RD_TPE_004"
        assert result.result["congestion_warning"] is True


class TestDecideMrtDiversionFallback:
    def test_matches_known_boundary_cases(self):
        def crowd(user_count, growth_rate):
            return CrowdSnapshot(
                timestamp="t", station_id="BS_MRT_BL17", location_name="捷運國父紀念館站",
                user_count=user_count, stay_time_avg=20, growth_rate=growth_rate, roaming_pct=0.1,
            )

        assert decide_mrt_diversion(crowd(8500, 0.88), llm_client=None).triggered is True
        assert decide_mrt_diversion(crowd(33000, 0.06), llm_client=None).triggered is True
        assert decide_mrt_diversion(crowd(10000, 0.1), llm_client=None).triggered is False


class TestDecideDomeDispersalFallback:
    def test_matches_known_boundary(self):
        history = [
            CrowdSnapshot(timestamp="t", station_id="BS_TPE_DOME", location_name="大巨蛋場館內",
                          user_count=uc, stay_time_avg=100, growth_rate=0, roaming_pct=0.05)
            for uc in (15000, 35000, 40000, 38000)
        ]

        def current(growth_rate):
            return CrowdSnapshot(timestamp="t", station_id="BS_TPE_DOME", location_name="大巨蛋場館內",
                                  user_count=22000, stay_time_avg=180, growth_rate=growth_rate, roaming_pct=0.05)

        assert decide_dome_dispersal(history, current(-0.16), llm_client=None).triggered is False
        assert decide_dome_dispersal(history, current(-0.2), llm_client=None).triggered is True


class TestDecideSignalFailureFallback:
    def test_matches_known_case(self):
        incident = LiveIncident(
            event_id="TPE_2026_EVT_003", type="Power_Failure",
            location="信義威秀/ATT4FUN周邊路燈號誌故障", affected_segment="RD_TPE_007",
            status="Caution", severity="Medium",
            description="信義區部分路段號誌失效，需改由人工交通指揮",
            timestamp="2026-05-20 22:30",
        )
        result = decide_signal_failure(incident, llm_client=None)
        assert result.triggered is True
        assert result.sop_section_id == "5"


class TestDecideMultilingualFallback:
    def test_matches_known_boundary(self):
        def station(roaming_pct):
            return CrowdSnapshot(timestamp="t", station_id="BS_XY_ATT", location_name="ATT4FUN周邊",
                                  user_count=1000, stay_time_avg=10, growth_rate=0, roaming_pct=roaming_pct)

        at_boundary = decide_multilingual([station(0.3)], llm_client=None)
        assert at_boundary.triggered is True
        below_boundary = decide_multilingual([station(0.28)], llm_client=None)
        assert below_boundary.triggered is False

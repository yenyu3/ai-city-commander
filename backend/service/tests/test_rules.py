"""Ported 1:1 from frontend/src/engine/ruleEngine.test.ts (same fixtures, same
expected numbers) so the Python and TypeScript rule engines can be checked
against each other, plus additional tests exercising the real competition
dataset and the unmatched-intersection-name fix (see accident_response.py).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from rules.accident_response import is_accident_trigger, is_upstream, select_evacuation_route
from rules.congestion_tier import check_city_response, get_tier
from rules.dome_dispersal import check_dome_dispersal
from rules.ete import calc_ete
from rules.mrt_diversion import check_mrt_diversion
from rules.multilingual_check import check_multilingual_needed
from rules.network_loader import load_segments_from_geometry
from rules.signal_failure import check_signal_failure
from rules.types import CrowdSnapshot, LiveIncident, RoadSegment

DATA_DIR = Path(__file__).resolve().parents[3] / "data"


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


# --- mirrors the minimal segment graph in ruleEngine.test.ts ---
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


class TestCongestionTier:
    def test_classifies_tiers_by_saturation_thresholds(self):
        assert get_tier(0.84) == "Normal"
        assert get_tier(0.85) == "B"
        assert get_tier(0.94) == "B"
        assert get_tier(0.95) == "A"
        assert get_tier(1.0) == "A"

    def test_only_triggers_city_response_for_trigger_segments(self):
        assert check_city_response("RD_TPE_003", "A") is None
        assert check_city_response("RD_TPE_001", "Normal") is None
        b = check_city_response("RD_TPE_001", "B")
        assert len(b.actions) == 3
        a = check_city_response("RD_TPE_002", "A")
        assert len(a.actions) == 4
        assert "替代路徑引導" in a.actions[3]


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


class TestAccidentEvacuationCaseA:
    """§4.2 / §4.3 驗證用例 A：RD_TPE_002 光復南路封閉"""

    def test_triggers_the_accident_rule(self):
        assert is_accident_trigger(INCIDENT_A) is True

    def test_selects_rd_tpe_004_as_main_route_not_005(self):
        saturation = {
            "RD_TPE_002": 1.0,
            "RD_TPE_004": 0.78,
            "RD_TPE_005": 0.65,
            "RD_TPE_006": 0.72,
            "RD_TPE_008": 0.8,
        }
        result = select_evacuation_route(
            "RD_TPE_002", INCIDENT_A.location, SEGMENTS, saturation
        )
        assert result.main_route == "RD_TPE_004"
        assert result.secondary_routes == ["RD_TPE_005"]
        assert {c.segment_id for c in result.excluded} == {"RD_TPE_008", "RD_TPE_006"}
        assert len(result.excluded) == 2
        assert result.congestion_warning is False

    def test_flags_congestion_when_main_route_itself_saturates(self):
        saturation = {
            "RD_TPE_002": 1.0,
            "RD_TPE_004": 0.95,
            "RD_TPE_005": 0.85,
            "RD_TPE_006": 0.98,
            "RD_TPE_008": 1.0,
        }
        result = select_evacuation_route(
            "RD_TPE_002", INCIDENT_A.location, SEGMENTS, saturation
        )
        assert result.main_route == "RD_TPE_004"
        assert result.congestion_warning is True
        assert result.recommend_public_transit is True

    def test_computes_ete_83_minutes_from_the_real_snapshot(self):
        avg = (1.0 + 0.78) / 2
        result = calc_ete("Critical", avg)
        assert result.ete == 83
        assert "83" in result.breakdown


class TestAccidentEvacuationCaseB:
    """§4.4 驗證用例 B：BS_MRT_BL17 人潮推擠事件（邊界案例）"""

    def test_does_not_trigger_even_though_affected_road_is_rd_tpe_001(self):
        incident = LiveIncident(
            event_id="TPE_2026_EVT_002",
            type="Crowd_Surge_Injury",
            location="捷運國父紀念館站 5 號出口",
            affected_segment="BS_MRT_BL17",
            affected_road="RD_TPE_001",
            status="Restricted",
            severity="High",
            description="散場人群推擠受傷，救護車佔用單向車道，人流進站動線中斷",
            timestamp="2026-05-20 22:20",
        )
        assert is_accident_trigger(incident) is False


class TestMrtDiversion:
    """§4.5 捷運與接駁分流"""

    @staticmethod
    def crowd(user_count: int, growth_rate: float) -> CrowdSnapshot:
        return CrowdSnapshot(
            timestamp="2026-05-20 18:00",
            station_id="BS_MRT_BL17",
            location_name="捷運國父紀念館站",
            user_count=user_count,
            stay_time_avg=20,
            growth_rate=growth_rate,
            roaming_pct=0.1,
        )

    def test_triggers_at_1800_growth_rate_088(self):
        assert check_mrt_diversion(self.crowd(8500, 0.88)) is True

    def test_triggers_at_2130_both_thresholds_pass(self):
        assert check_mrt_diversion(self.crowd(18000, 0.5)) is True

    def test_triggers_at_2230_purely_from_user_count(self):
        assert check_mrt_diversion(self.crowd(33000, 0.06)) is True

    def test_does_not_trigger_under_both_thresholds(self):
        assert check_mrt_diversion(self.crowd(10000, 0.1)) is False


class TestDomeDispersal:
    """§4.6 大巨蛋散場啟動"""

    HISTORY = [
        CrowdSnapshot(
            timestamp="t",
            station_id="BS_TPE_DOME",
            location_name="大巨蛋場館內",
            user_count=uc,
            stay_time_avg=100,
            growth_rate=0,
            roaming_pct=0.05,
        )
        for uc in (15000, 35000, 40000, 38000)
    ]

    @staticmethod
    def current(growth_rate: float) -> CrowdSnapshot:
        return CrowdSnapshot(
            timestamp="t",
            station_id="BS_TPE_DOME",
            location_name="大巨蛋場館內",
            user_count=22000,
            stay_time_avg=180,
            growth_rate=growth_rate,
            roaming_pct=0.05,
        )

    def test_does_not_trigger_at_2100_or_2130(self):
        assert check_dome_dispersal(self.HISTORY, self.current(-0.05)) is False
        assert check_dome_dispersal(self.HISTORY, self.current(-0.16)) is False

    def test_triggers_exactly_at_boundary_and_beyond(self):
        assert check_dome_dispersal(self.HISTORY, self.current(-0.2)) is True
        assert check_dome_dispersal(self.HISTORY, self.current(-0.31)) is True


class TestSignalFailure:
    """§4.7 號誌故障應變"""

    def test_triggers_on_power_failure_independent_of_accident_rule(self):
        incident = LiveIncident(
            event_id="TPE_2026_EVT_003",
            type="Power_Failure",
            location="信義威秀/ATT4FUN周邊路燈號誌故障",
            affected_segment="RD_TPE_007",
            status="Caution",
            severity="Medium",
            description="信義區部分路段號誌失效，需改由人工交通指揮",
            timestamp="2026-05-20 22:30",
        )
        assert check_signal_failure(incident) is True
        assert is_accident_trigger(incident) is False


class TestMultilingual:
    """§4.8 數位通報與多語化"""

    @staticmethod
    def station(roaming_pct: float) -> CrowdSnapshot:
        return CrowdSnapshot(
            timestamp="t",
            station_id="BS_XY_ATT",
            location_name="ATT4FUN周邊",
            user_count=1000,
            stay_time_avg=10,
            growth_rate=0,
            roaming_pct=roaming_pct,
        )

    def test_includes_stations_at_exactly_30pct_boundary(self):
        assert len(check_multilingual_needed([self.station(0.3)])) == 1

    def test_excludes_28pct(self):
        assert len(check_multilingual_needed([self.station(0.28)])) == 0

    def test_includes_40pct_and_45pct(self):
        assert len(check_multilingual_needed([self.station(0.4), self.station(0.45)])) == 2


class TestEte:
    """§4.9 ETE 計算共用函式"""

    def test_uses_correct_base_clearance_per_severity(self):
        assert calc_ete("Critical", 0.5).ete == 60
        assert calc_ete("High", 0.5).ete == 40
        assert calc_ete("Medium", 0.5).ete == 20

    def test_never_applies_a_negative_penalty(self):
        assert calc_ete("Medium", 0.2).ete == 20


class TestUnmatchedIntersectionHandling:
    """The frontend reference implementation builds intersectionIds by
    filtering out unresolved names entirely, which silently shifts every
    later index relative to the unfiltered `intersections` name array that
    the insertion-point lookup reads from. That mismatch can flip an
    upstream/downstream classification whenever an unresolved name (e.g.
    正氣橋, data/unmatched_intersection_names.json) sits before the
    incident's anchor point. This port keeps the arrays parallel instead.
    """

    def test_unresolved_entry_does_not_shift_later_indices(self):
        # raw order: [正氣橋(unresolved), A路, B路]; anchor at "A路" with a
        # south-side modifier -> insertion_index = 1.5
        segment = seg(
            "RD_X", "測試橋段", "南北向",
            ["正氣橋", "A路", "B路"],
            [None, "RD_A", "RD_B"],
            2000, ["RD_A", "RD_B"],
        )
        assert is_upstream("RD_A", segment, "A路以南") is True   # raw index 1 < 1.5
        assert is_upstream("RD_B", segment, "A路以南") is False  # raw index 2 > 1.5

        # proves the parallel-array (unshifted) index is what's actually used:
        # a naive filter that dropped the unresolved 正氣橋 entry would put
        # B路 at index 1, which is < 1.5 and would misclassify it as upstream.
        filtered_ids = [i for i in segment.intersection_ids if i is not None]
        assert filtered_ids.index("RD_B") == 1  # the wrong, shifted index
        assert segment.intersection_ids.index("RD_B") == 2  # the correct index used above

    def test_unresolved_candidate_id_is_never_matched(self):
        segment = seg(
            "RD_TPE_009", "基隆路地下道", "南北向",
            ["忠孝東路四段", "正氣橋"],
            ["RD_TPE_001", None],
            2000, ["RD_TPE_001"],
        )
        result = select_evacuation_route(
            "RD_TPE_009", "忠孝東路四段附近", SEGMENTS | {"RD_TPE_009": segment}, {"RD_TPE_001": 0.5}
        )
        # 正氣橋 has no segment_id at all, so it can never appear in
        # `alternatives` in the first place -- this just proves the lookup
        # doesn't crash when a None sits in intersection_ids.
        assert result.main_route in (None, "RD_TPE_001")


class TestRealDataIntegration:
    """Exercises the ported algorithm against the actual competition
    dataset in data/, not just the synthetic fixture mirrored from the
    frontend's vitest suite.
    """

    @staticmethod
    @pytest.fixture(scope="class")
    def segments():
        if not DATA_DIR.exists():
            pytest.skip(f"competition data/ not present at {DATA_DIR}")
        return load_segments_from_geometry(DATA_DIR / "road_network_geometry.json")

    def test_loads_all_15_segments(self, segments):
        assert len(segments) == 15

    def test_zhengqi_bridge_is_left_unresolved(self, segments):
        rd_009 = segments["RD_TPE_009"]
        assert "正氣橋" in rd_009.intersections
        idx = rd_009.intersections.index("正氣橋")
        assert rd_009.intersection_ids[idx] is None
        # and the arrays must stay the same length (no silent drop)
        assert len(rd_009.intersection_ids) == len(rd_009.intersections)

    def test_rd_tpe_002_evacuation_matches_the_reference_case(self, segments):
        saturation = {
            "RD_TPE_002": 1.0,
            "RD_TPE_004": 0.78,
            "RD_TPE_005": 0.65,
            "RD_TPE_006": 0.72,
            "RD_TPE_008": 0.8,
        }
        result = select_evacuation_route(
            "RD_TPE_002", INCIDENT_A.location, segments, saturation
        )
        assert result.main_route == "RD_TPE_004"

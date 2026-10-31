"""A9's sources where no camera looks: only for the evacuation, flagged, and never in flow.report."""
import numpy as np
import pytest

from clarion_vision import contract
from clarion_vision.chain import Chain
from clarion_vision.evac import blocked_nodes, plan_evacuation
from clarion_vision.forecast import Curve, Flight
from clarion_vision.queues import load_queues
from clarion_vision.sources.base import load_camera_specs
from clarion_vision.sources.synthetic import SyntheticAirport
from clarion_vision.state import LaneBook
from clarion_vision.terminal import Zone, Terminal, load_terminal
from clarion_vision.unseen import estimate_unseen

CURVE = Curve(100.0, 0.3, 25.0)


def zones():
    square = [(np.array([[0, 0], [10, 0], [10, 10], [0, 10]], float), [])]
    rows = [("U_GATE_1", "airside", "gate"), ("U_GATE_2", "airside", "gate"), ("U_CAFE", "airside", "shops"), ("G_HALL", "landside", "circulation"),
            ("G_WC", "landside", "wc"), ("U_QUEUE", "landside", "queue")]
    return Terminal({z: Zone(z, "U" if z.startswith("U") else "G", kind, side, 100.0, square) for z, side, kind in rows}, {}, [], {}, [])


def flight(minutes_left, pax=200, gate="gate_2", **kw):
    return Flight("W6 1", std_s=36000.0 + minutes_left * 60.0, pax=pax, gate=gate, **kw)


def test_presented_share_is_a_proper_curve():
    assert CURVE.presented_by(600) < 0.01 and CURVE.presented_by(100) > 0.45 and CURVE.presented_by(10) == 1.0
    assert CURVE.presented_by(60) > CURVE.presented_by(120)


def test_airside_comes_from_the_schedule_less_what_is_accounted_for():
    t = zones()
    all_three = estimate_unseen(t, {}, ["U_GATE_1", "U_GATE_2", "U_CAFE"], [flight(40)], 36000.0, CURVE)
    expected = 200 * CURVE.presented_by(40)
    assert sum(all_three.values()) == pytest.approx(expected)
    assert all_three["U_GATE_2"] > all_three["U_GATE_1"]                       # near departure, most are at their own gate
    fewer = estimate_unseen(t, {"U_GATE_1": 30.0}, ["U_GATE_2", "U_CAFE"], [flight(40)], 36000.0, CURVE, still_before_security=20.0)
    assert sum(fewer.values()) == pytest.approx(expected - 50.0)               # seen airside and still in the queue are not counted twice


def test_gone_and_cancelled_flights_leave_nobody_and_nothing_is_negative():
    t = zones()
    assert estimate_unseen(t, {}, ["U_CAFE"], [flight(-5), flight(40, status="cancelled"), flight(40, status="departed")], 36000.0, CURVE) == {}
    assert estimate_unseen(t, {"U_GATE_1": 500.0}, ["U_CAFE"], [flight(40)], 36000.0, CURVE) == {}


def test_landside_takes_the_density_of_the_halls_seen_not_of_the_queues():
    t = zones()
    out = estimate_unseen(t, {"G_HALL": 50.0, "U_QUEUE": 400.0}, ["G_WC"], [], 36000.0, CURVE)
    assert out == {"G_WC": pytest.approx(50.0)}


def test_camera_scale_moves_the_estimate():
    t = zones()
    base = sum(estimate_unseen(t, {}, ["U_CAFE"], [flight(40)], 36000.0, CURVE).values())
    assert sum(estimate_unseen(t, {}, ["U_CAFE"], [flight(40)], 36000.0, CURVE, scale=1.5).values()) == pytest.approx(1.5 * base)


@pytest.fixture(scope="module")
def real():
    terminal = load_terminal()
    return terminal, load_camera_specs(), load_queues(lane_limits=terminal.lane_limits)


def test_a_plan_with_estimates_is_flagged_and_lasts_longer(real):
    terminal, cameras, queues = real
    crowd = {"G_CHECKIN_QUEUE": 150.0, "G_CENTER": 60.0}
    plain = plan_evacuation(terminal, crowd, [], reaction_s=0.0)
    mixed = plan_evacuation(terminal, crowd, [], reaction_s=0.0, estimated={"U_GATE_2": 200.0, "U_CORRIDOR_EAST": 80.0, "G_CENTER": 999.0})
    assert mixed.people_estimated == pytest.approx(280.0)                       # a zone the cameras saw keeps their number
    assert mixed.people == pytest.approx(490.0) and mixed.clear_s >= plain.clear_s
    message = mixed.to_contract("c")
    assert message["partlyEstimated"] is True and message["peopleSeen"] == 210 and message["peopleEstimated"] == 280
    contract.check_evac(message)
    assert plain.to_contract("c")["partlyEstimated"] is False


def test_blocking_zones_evacuates_those_zones_a_whole_terminal_id_everybody(real):
    terminal, cameras, queues = real
    chain = Chain(terminal, cameras, queues, LaneBook(terminal.initial_lanes))
    air = SyntheticAirport(queues, cameras, terminal, seed=5, start_s=8.5 * 3600)
    for _ in range(60):
        chain.ingest(air.step(10.0), air.flights)
    everybody = chain.evacuation_sources(air.flights, ["T2"])
    assert len(everybody[0]) > 5 and everybody[2]
    people, density, estimated = chain.evacuation_sources(air.flights, ["U_SECURITY_QUEUE"])
    assert set(people) == {"U_SECURITY_QUEUE"} and not estimated
    assert density == everybody[1]                                               # the others stay, and slow the walk
    people, _, _ = chain.evacuation_sources(air.flights, ["security"])            # an alias blocks the same zone
    assert set(people) == {"U_SECURITY_QUEUE"}
    people, _, _ = chain.evacuation_sources(air.flights, ["check_in:1"])          # a desk group: its own queue
    assert set(people) == {"check_in:1"}
    people, _, _ = chain.evacuation_sources(air.flights, ["check_in:1", "G_CHECKIN_QUEUE"])
    assert set(people) == {"G_CHECKIN_QUEUE"}                                     # the hall holds its groups: not counted twice
    unseen_zone = next(iter(everybody[2]))
    people, _, estimated = chain.evacuation_sources(air.flights, [unseen_zone])   # no camera there: the plan's guess, flagged
    assert not people and set(estimated) == {unseen_zone}


def test_whole_terminal_blocks_no_door(real):
    terminal, _, _ = real
    assert blocked_nodes(terminal, ["T2"]) == set()
    plan = plan_evacuation(terminal, {"G_CENTER": 100.0}, ["T2"])
    assert plan.people == pytest.approx(100.0) and "door_exit_mid" in {r["exit"] for r in plan.routes} and plan.blocked == ["T2"]
    contract.check_evac(plan.to_contract("c"))


def test_unseen_zones_stay_out_of_the_report_but_reach_the_evacuation(real):
    terminal, cameras, queues = real
    book = LaneBook(terminal.initial_lanes)
    chain = Chain(terminal, cameras, queues, book)
    air = SyntheticAirport(queues, cameras, terminal, seed=5, start_s=8.5 * 3600)
    for _ in range(60):
        chain.ingest(air.step(10.0), air.flights)
    people, density, estimated = chain.evacuation_sources(air.flights)
    reported = {r["zone"] for r in chain.report(air.flights).rows}
    assert estimated and not set(estimated) & set(people) and not set(estimated) & reported
    assert all(terminal.zones[z].level in ("G", "U") for z in estimated)
    assert sum(estimated.values()) < 1500

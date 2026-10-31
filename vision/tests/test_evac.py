"""A9 + A10, on a small graph with known answers and on the real terminal."""
import time

import numpy as np
import pytest

from clarion_vision import contract
from clarion_vision.evac import DOOR_FLOW, blocked_nodes, plan_evacuation
from clarion_vision.terminal import Edge, Node, Terminal, Zone, load_terminal


def square(area):
    s = area ** 0.5
    return [(np.array([[0, 0], [s, 0], [s, s], [0, s]], float), [])]


def small(width_a=2.0, width_b=2.0):
    """hall --(10 s)-- door_a ; hall --(40 s)-- door_b ; room --(5 s)-- hall"""
    zones = {z: Zone(z, "G", "circulation", "landside", 400.0, square(400)) for z in ("hall", "room")}
    nodes = {"hall": Node("hall", "circulation", 0, 0, "G", "hall"), "room": Node("room", "circulation", 0, 10, "G", "room"),
             "door_a": Node("door_a", "exit", 10, 0, "G", "hall"), "door_b": Node("door_b", "exit", 40, 0, "G", "hall")}
    edges = [Edge("hall", "door_a", 10.0), Edge("hall", "door_b", 40.0), Edge("room", "hall", 5.0)]
    return Terminal(zones, nodes, edges, {"door_a": width_a, "door_b": width_b}, ["door_a", "door_b"], {})


def test_one_person_walks_to_the_nearest_door():
    r = plan_evacuation(small(), {"hall": 1}, [], reaction_s=0.0)
    assert r.clear_s == pytest.approx(10.0, abs=5.0)
    assert [e["exit"] for e in r.exits] == ["door_a"]


def test_door_capacity_sets_the_time():
    t = small()
    t.exits = ["door_a"]                          # 260 people through 2 m at 1.3 p/m/s = 100 s
    r = plan_evacuation(t, {"hall": 260}, [], reaction_s=0.0)
    assert r.clear_s == pytest.approx(10 + 260 / (DOOR_FLOW * 2.0), abs=10.0)


def test_the_flow_splits_over_doors_so_none_is_overloaded():
    r = plan_evacuation(small(), {"hall": 800}, [], reaction_s=0.0)
    by_door = {e["exit"]: e["people"] for e in r.exits}
    assert by_door["door_a"] > 0 and by_door["door_b"] > 0
    assert sum(by_door.values()) == pytest.approx(800, abs=1)
    # Both doors work at 2.6/s; door_b starts 30 s later: T = (800 + 2.6*10 + 2.6*40) / 5.2
    assert r.clear_s == pytest.approx((800 + 26 + 104) / 5.2, abs=10.0)


def test_reaction_time_is_added():
    a, b = plan_evacuation(small(), {"hall": 50}, []), plan_evacuation(small(), {"hall": 50}, [], reaction_s=0.0)
    assert a.clear_s == pytest.approx(b.clear_s + 30.0)


def test_t90_before_the_last_one_out():
    r = plan_evacuation(small(), {"hall": 500}, [], reaction_s=0.0)
    assert r.t90_s < r.clear_s


def test_blocked_zone_people_leave_nobody_enters():
    t = small()
    t.nodes["door_a"].zone = "room"               # door_a now sits inside the blocked room
    r = plan_evacuation(t, {"hall": 20, "room": 5}, ["room"], reaction_s=0.0)
    routes = {x["from"]: x for x in r.routes}
    assert routes["hall"]["exit"] == "door_b"     # hall may not walk into the blocked room
    assert "room" in routes and routes["room"]["exit"] == "door_b"
    assert "door_a" not in {e["exit"] for e in r.exits}


@pytest.fixture(scope="module")
def terminal():
    return load_terminal()


CROWD = {"G_CHECKIN_QUEUE": 180, "G_DEPARTURES": 90, "G_CENTER": 70, "U_SECURITY_QUEUE": 140, "U_SECURITY": 40, "U_CONCOURSE": 60,
         "U_GATE_2": 150, "U_GATE_6": 120, "U_CORRIDOR_EAST": 50, "U_DUTY_FREE": 40, "G_MEETING": 60, "G_RECLAIM_1": 80}


def test_real_terminal_in_time_and_valid(terminal):
    started = time.perf_counter()
    r = plan_evacuation(terminal, CROWD, ["G_CHECKIN_QUEUE"])
    elapsed = time.perf_counter() - started
    assert elapsed < 2.0, f"{elapsed:.2f} s"
    assert r.allocator == "flow"
    assert sum(e["people"] for e in r.exits) == pytest.approx(sum(CROWD.values()), abs=2)
    assert not r.unreachable and not r.no_route, (r.unreachable, r.no_route)
    plan = r.to_contract("cmd-1")
    contract.check_evac(plan)
    assert len(contract.evac_plan(plan)) < 1_048_576
    assert 30 < plan["clearSec"] < 1500 and r.t90_s <= r.clear_s
    routes = {x["from"]: x for x in r.routes}
    # The nodes the backend looks for (routeFor in worker/src/wa/messaging.ts)
    for node in ("gate_2", "U_CORRIDOR_EAST", "U_SECURITY_QUEUE", "check_in:RO", "G_CHECKIN_QUEUE", "G_DEPARTURES"):
        assert node in routes, node
    closed = blocked_nodes(terminal, ["G_CHECKIN_QUEUE"])
    for route in r.routes:
        if route["from"] in closed:
            continue
        assert not (set(route["nodes"]) & closed), route     # from outside it, no route crosses the blocked zone
        assert route["nodes"][-1] == route["exit"] and route["exit"] in terminal.exits


def test_block_more_recompute_routes_move(terminal):
    open_plan = plan_evacuation(terminal, CROWD, [])
    door = {x["from"]: x["exit"] for x in open_plan.routes}["G_CENTER"]
    door_zone = terminal.nodes[door].zone
    second = plan_evacuation(terminal, CROWD, [door_zone])
    assert {x["from"]: x["exit"] for x in second.routes}["G_CENTER"] != door or door_zone == "G_CENTER"
    assert door not in {e["exit"] for e in second.exits}


def test_nobody_inside_still_gives_routes(terminal):
    r = plan_evacuation(terminal, {}, ["U_SECURITY_QUEUE"])
    assert r.clear_s == 0 and r.exits == [] and len(r.routes) > 50
    contract.check_evac(r.to_contract("x"))


def test_alias_ids_block_the_physical_zone(terminal):
    assert "U_SECURITY_QUEUE" in blocked_nodes(terminal, ["security"])
    nodes = blocked_nodes(terminal, ["check_in:2"])
    assert "check_in:RO" in nodes and "checkin_7" in nodes and "G_CHECKIN_QUEUE" not in nodes

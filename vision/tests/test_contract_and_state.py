"""Messages the backend accepts, and D0: what the service keeps of GET /api/sim."""
import json

import pytest

from clarion_vision import contract
from clarion_vision.config import Config
from clarion_vision.mapids import lanes_key, map_node_id
from clarion_vision.state import LaneBook, SimView


def test_flow_report_shape():
    row = contract.flow_row("U_SECURITY_QUEUE", 41.6, 3.2, 0.2699, 8.123, 10.5, 0.79, [{"inMin": 30, "waitMin": 9.0}], {"lanes": 3, "by": 1000, "waitMinIfNot": 18.0})
    event = json.loads(contract.flow_report([row]))
    assert event["type"] == "flow.report" and event["ts"].endswith("Z")
    z = event["data"]["zones"][0]
    assert z["waiting"] == 42 and isinstance(z["waiting"], int) and z["coverage"] == 0.79


@pytest.mark.parametrize("bad", [[], [{"zone": "U_SECURITY_QUEUE", "waiting": 1.5}], [{"zone": "bad id", "waiting": 1}],
                                  [{"zone": "A", "waiting": 1}, {"zone": "A", "waiting": 2}], [{"zone": "A", "waiting": 1, "waitMin": float("nan")}]])
def test_flow_rejects_what_the_backend_would(bad):
    with pytest.raises(ValueError):
        contract.flow_report(bad)


def test_unknown_fields_are_left_out_not_guessed():
    assert contract.flow_row("G_CENTER", 10) == {"zone": "G_CENTER", "waiting": 10}


def test_density_is_clamped_and_positions_capped():
    assert contract.flow_row("A", 1, density=99.0)["density"] == 20.0
    people = [{"x": 1.0, "z": 2.0, "level": "G"}] * 3000
    assert len(json.loads(contract.crowd_positions(people))["data"]["people"]) == 2000
    with pytest.raises(ValueError):
        contract.crowd_positions([{"x": 1.0, "y": 2.0}])


def test_evac_plan_validated():
    good = {"id": "c1", "blocked": ["G_CHECKIN_QUEUE"], "clearSec": 120.0, "exits": [{"exit": "door_exit_west", "people": 10, "clearSec": 60.0}],
            "routes": [{"from": "check_in:2", "exit": "door_exit_west", "nodes": ["check_in:2", "door_exit_west"]}]}
    assert json.loads(contract.evac_plan(good))["type"] == "evac.plan"
    with pytest.raises(ValueError):
        contract.evac_plan({**good, "routes": []})
    with pytest.raises(ValueError):
        contract.evac_plan({**good, "exits": [{"exit": "door_exit_west", "people": 1.5, "clearSec": 1.0}]})


def test_d0_truth_never_enters_the_service():
    raw = {"simTime": 25200, "speed": 10, "connected": True, "blocked": [], "lanes": {"security": 2},
           "truth": {"zones": {"U_SECURITY_QUEUE": {"waiting": 99, "waitMin": 42}}}, "flow": {"x": 1}, "positions": {"people": []},
           "counts": {"pax": 1}, "actions": {}, "metrics": {"evacT90": 1},
           "flights": [{"flight": "W6 1", "std": "09:40", "pax": 180, "status": "delayed", "delayMin": 20, "checkIn": "check_in:2", "gate": "gate_2"}],
           "ops": [{"id": "a", "type": "staff", "zone": "security", "delta": 1}, {"id": "b", "type": "evacuate", "zones": ["X"]}]}
    view = SimView.parse(raw)
    text = repr(view)
    assert "99" not in text and "truth" not in text and "waitMin" not in text
    assert view.sim_time == 25200 and view.flights[0].check_in == "check_in:2" and view.flights[0].delay_min == 20
    assert view.staff_ops == [{"id": "a", "zone": "security", "delta": 1}]


def test_lane_book_merges_aliases_and_follows_the_longest_group():
    book = LaneBook({"security": 2, "check_in:1": 3, "check_in:2": 3})
    book.apply("a", "U_SECURITY_QUEUE", 1)
    book.apply("b", "security", 1)
    book.apply("b", "security", 1)            # same command again, from the socket and from the poll
    assert book.lanes("security") == 4
    book.apply("c", "bag_drop:2", -1)
    book.apply("d", "G_CHECKIN_QUEUE", 1, longest_group=lambda: "check_in:1")
    assert book.lanes("check_in:2") == 2 and book.lanes("check_in:1") == 4
    book.apply("e", "security", -9)
    assert book.lanes("security") == 0
    book.reset()
    assert book.lanes("security") == 2


def test_ids():
    assert map_node_id("security") == "U_SECURITY_QUEUE"
    assert map_node_id("check_in:2") == "check_in:2" and map_node_id("bag_drop:FR") == "check_in:3" and map_node_id("check_in:RO") == "check_in:2"
    assert map_node_id("G2") == "U_GATE_2" and map_node_id("gate_10") == "U_GATE_10"
    assert lanes_key("check_in:W6") == "check_in:1" and lanes_key("checkin_group_3") == "check_in:3"
    assert lanes_key("U_GATE_1") is None and lanes_key("check_in:OTHER") is None


def test_the_token_never_reaches_a_log_line():
    c = Config(url="https://clarion.example", token="s3cret")
    assert c.ws_url == "wss://clarion.example/ws?client=vision&token=s3cret"
    assert "s3cret" not in c.redact(f"failed: {c.ws_url}") and "s3cret" not in repr(c)

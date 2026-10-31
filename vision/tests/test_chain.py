"""The chain on the synthetic airport. Error numbers here describe the plumbing on made-up people, nothing about the airport."""
import numpy as np
import pytest

from clarion_vision import contract
from clarion_vision.chain import Chain, TrackLedger, merge_cameras
from clarion_vision.geometry import ring_samples
from clarion_vision.queues import load_queues
from clarion_vision.sources.base import FloorPoint, load_camera_specs
from clarion_vision.sources.synthetic import SyntheticAirport
from clarion_vision.state import LaneBook
from clarion_vision.terminal import load_terminal


@pytest.fixture(scope="module")
def parts():
    terminal = load_terminal()
    return terminal, load_camera_specs(), load_queues()


def world(parts, seed=3, **kw):
    terminal, specs, queues = parts
    queues = [q for q in queues if q.queue in ("security", "checkin_group_1")]     # fewer queues: a quicker test, same code
    book = LaneBook(terminal.initial_lanes)
    chain = Chain(terminal, specs, queues, book)
    lanes = lambda q: book.lanes(q.lanes_key, q.default_lanes) if q.lanes_key else q.default_lanes
    return SyntheticAirport(queues, specs, terminal, seed=seed, lanes_fn=lanes, **kw), chain, book


def run(air, chain, seconds, dt=3.0):
    for _ in range(int(seconds / dt)):
        chain.ingest(air.step(dt), air.flights)


def test_merge_two_cameras_keeps_one_never_merges_within_a_camera():
    a = FloorPoint(0, 0, "G", 1, 0.9, 80, "a")
    b = FloorPoint(0.3, 0, "G", 2, 0.5, 80, "b")
    c = FloorPoint(0.3, 0, "G", 3, 0.5, 80, "a")
    d = FloorPoint(0.0, 0.1, "U", 4, 0.5, 80, "b")
    assert merge_cameras([a, b]) == [a]
    assert set(map(id, merge_cameras([a, c]))) == {id(a), id(c)}
    assert len(merge_cameras([a, d])) == 2


def test_ledger_counts_a_crossing_and_a_head_exit_not_a_lost_track(parts):
    q = next(x for x in parts[2] if x.queue == "security")
    ledger = TrackLedger(q, lost_after_s=4.0)
    inside = q.ring.mean(axis=0)
    p = lambda x, z, track=1: FloorPoint(float(x), float(z), "U", track, 0.8, 80, "c")
    far = q.ring.min(axis=0) - 30
    xs, zs = ring_samples(q.ring)
    distance = np.hypot(xs - q.head[0], zs - q.head[1])
    at_head, away = (xs[distance.argmin()], zs[distance.argmin()]), (xs[distance.argmax()], zs[distance.argmax()])
    assert ledger.step(0.0, [p(*far)], 1.0) == (0, 0)
    assert ledger.step(1.0, [p(*away)], 1.0) == (0, 0)
    assert ledger.step(2.0, [p(*away)], 1.0) == (1, 0)                # in for two ticks: one arrival
    ledger.step(3.0, [p(*at_head)], 1.0)
    assert ledger.step(4.0, [p(*far)], 1.0) == (0, 0)                 # one tick outside: could be jitter
    assert ledger.step(5.0, [p(*far)], 1.0) == (0, 1)                 # two: left at the head, one served
    ledger.step(5.0, [p(*away, track=2)], 1.0)
    ledger.step(6.0, [p(*away, track=2)], 1.0)
    assert ledger.step(20.0, [], 1.0) == (0, 0)                       # lost far from the head: occlusion, not service


def test_reports_are_valid_and_only_what_cameras_see(parts):
    air, chain, _ = world(parts)
    run(air, chain, 600)
    report = chain.report(air.flights)
    contract.check_flow({"zones": report.rows})
    contract.check_positions({"people": report.people})
    ids = {r["zone"] for r in report.rows}
    assert "U_SECURITY_QUEUE" in ids and "check_in:1" in ids
    cover = chain.coverage(chain.active)
    assert all(cover.get(z, 0.0) >= 0.1 or z.startswith("check_in:") or z == "U_SECURITY_QUEUE" for z in ids)   # nothing invented
    unseen = [z for z in parts[0].zones if cover.get(z, 0.0) < 0.1]
    assert unseen and not set(unseen) & ids
    sec = next(r for r in report.rows if r["zone"] == "U_SECURITY_QUEUE")
    assert {"waiting", "waitingSd", "density", "waitMin", "waitMinP90", "coverage", "forecast"} <= set(sec)
    assert [f["inMin"] for f in sec["forecast"]] == [30, 60, 90, 120]
    assert sec["waitMinP90"] >= sec["waitMin"]
    assert next(r for r in report.rows if r["zone"] == "U_SECURITY")["waitMin"] == sec["waitMin"]


def test_tracks_the_queue_and_measures_mu(parts):
    air, chain, _ = world(parts, start_s=8.0 * 3600, load=1.3)
    errors, truths = [], []
    for i in range(1200):                                             # an hour at 3 s
        chain.ingest(air.step(3.0), air.flights)
        if i > 200 and i % 20 == 0:
            truths.append(air.true_queue("security"))
            errors.append(chain.tracks["security"].filter.n - truths[-1])
    assert max(truths) > 15, "the scenario must build a queue"
    assert abs(np.mean(errors)) < 0.25 * np.mean(truths) + 3 and np.std(errors) < 0.4 * np.mean(truths) + 5, (np.mean(errors), np.std(errors), np.mean(truths))
    mu = chain.tracks["security"].head.mu
    assert mu == pytest.approx(3.2, rel=0.35)                          # the world's rate is 3.2, the prior 2.5


def test_opening_a_lane_changes_the_wait_at_once(parts):
    air, chain, book = world(parts, start_s=8.0 * 3600, load=1.3)
    run(air, chain, 2400, dt=4.0)
    before = next(r for r in chain.report(air.flights).rows if r["zone"] == "U_SECURITY_QUEUE")
    book.apply("c1", "security", 1)
    after = next(r for r in chain.report(air.flights).rows if r["zone"] == "U_SECURITY_QUEUE")
    assert before["waitMin"] > 0 and after["waitMin"] == pytest.approx(before["waitMin"] * 2 / 3, rel=0.02)
    assert after["waiting"] == before["waiting"]


def test_camera_down_coverage_falls_sd_grows_then_unknown(parts):
    air, chain, _ = world(parts, start_s=8.0 * 3600)
    run(air, chain, 600)
    q = chain.tracks["security"]
    cov0, sd0 = q.coverage, q.filter.sd
    air.down |= {c for c, targets in chain.masks.items() if "q:security" in targets or "U_SECURITY_QUEUE" in targets}
    run(air, chain, 60)
    assert cov0 > 0.5 and q.coverage == 0.0 and q.filter.sd > sd0
    row = next((r for r in chain.report(air.flights).rows if r["zone"] == "U_SECURITY_QUEUE"), None)
    assert row is not None and row["coverage"] == 0.0                  # still from flows for a while, and says so
    run(air, chain, 1200, dt=10.0)
    assert not any(r["zone"] == "U_SECURITY_QUEUE" for r in chain.report(air.flights).rows)


def test_clock_restart_resets_the_filters(parts):
    air, chain, _ = world(parts)
    run(air, chain, 300)
    tick = air.observe()
    tick.t_s = 100.0
    chain.ingest(tick, air.flights)
    assert chain.last_t == 100.0


def test_tracks_invalid_means_no_flows_but_counts_still_work(parts):
    air, chain, _ = world(parts, start_s=8.0 * 3600, load=1.3)
    for _ in range(300):
        tick = air.step(4.0)
        tick.tracks_valid = False
        chain.ingest(tick, air.flights)
    assert chain.tracks["security"].head.exits == 0
    assert chain.tracks["security"].head.mu == pytest.approx(2.5)
    assert abs(chain.tracks["security"].filter.n - air.true_queue("security")) < 15


def test_zone_people_for_evacuation_only_what_is_seen(parts):
    air, chain, _ = world(parts)
    run(air, chain, 120)
    people, density, unseen = chain.zone_people()
    assert people and density and all(z in parts[0].zones for z in people)
    assert not set(people) & set(unseen)

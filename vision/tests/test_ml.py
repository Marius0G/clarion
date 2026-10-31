"""A2, A4, A5 corrections on synthetic days: the plumbing of A11 and whether the corrections go the right way. Numbers here are
about made-up people and never go on a slide."""
import json

import numpy as np
import pytest

from clarion_vision.chain import Chain
from clarion_vision.forecast import CURVES
from clarion_vision.ml.calibrate import calibrate, fit_curve, fit_detector, lane_rate, load_calibration, recall_sigmoids
from clarion_vision.ml.dataset import Timeline, read_jsonl, replay, start_lanes
from clarion_vision.ml.runtime import Corrections
from clarion_vision.ml.train import evaluate, split_seeds, train_from_rows
from clarion_vision.queues import load_queues
from clarion_vision.sources.base import load_camera_specs
from clarion_vision.sources.synthetic import SyntheticAirport
from clarion_vision.state import LaneBook
from clarion_vision.terminal import load_terminal


@pytest.fixture(scope="module")
def parts():
    terminal = load_terminal()
    queues = [q for q in load_queues(lane_limits=terminal.lane_limits) if q.queue == "security"]
    return terminal, load_camera_specs(), queues


def simulated_day(parts, seed, recall=0.7, hours=1.5, dt=15.0):
    """Ticks and truth lines from the synthetic airport, in the shape of a run folder. The low recall gives A2 a bias to find."""
    terminal, cameras, queues = parts
    air = SyntheticAirport(queues, cameras, terminal=None, seed=seed, start_s=7.5 * 3600, recall=recall, load=1.0 + 0.1 * (seed % 3))
    ticks, truth = [], []
    for k in range(int(hours * 3600 / dt)):
        ticks.append(air.step(dt))
        truth.append({"t_s": air.t, "zones": [{"zone": "U_SECURITY_QUEUE", "waiting": air.true_queue("security"), "waitMin": air.true_wait_min("security")}],
                      "lanes": {"U_SECURITY_QUEUE": 2}})
    timeline = lambda: Timeline(flights=[(0.0, air.flights)])
    return ticks, truth, timeline


def rows_for(parts, seeds, corrections=None, days={}):
    terminal, cameras, queues = parts
    out = []
    for seed in seeds:
        days.setdefault(seed, simulated_day(parts, seed))
        ticks, truth, timeline = days[seed]
        out += replay(ticks, truth, timeline(), terminal, cameras, queues, seed, corrections)
    return out


def test_held_out_seeds_are_kept_apart():
    train, test = split_seeds([5, 1, 3, 2, 4, 5], 0.25)
    assert train == [1, 2, 3, 4] and test == [5] and not set(train) & set(test)


def test_rows_pair_the_chain_with_truth_and_future_labels(parts):
    rows = rows_for(parts, [1])
    assert rows and rows[0]["zone"] == "U_SECURITY_QUEUE"
    assert {"true_n", "true_wait", "raw_count", "count_features", "wait_features", "forecast_raw", "true_future"} <= set(rows[0])
    assert any(30 in r["true_future"] for r in rows)
    last = rows[-1]["t"]
    assert all(r["t"] + 30 * 60 <= last + 30 for r in rows if 30 in r["true_future"])   # a label from within the same run


def test_start_lanes_come_from_the_runs_plan(parts):
    terminal = parts[0]
    truth = [{"t_s": 5.0, "zones": [], "lanes": {"U_SECURITY_QUEUE": 1, "check_in:1": 4, "U_PASSPORT_DEP": 0}}, {"t_s": 10.0, "zones": [], "lanes": {"U_SECURITY_QUEUE": 3}}]
    lanes = start_lanes(truth, terminal)
    assert lanes["security"] == 1 and lanes["check_in:1"] == 4 and lanes["check_in:2"] == terminal.initial_lanes["check_in:2"]


def test_a2_removes_a_detector_bias_on_a_held_out_seed(parts, tmp_path):
    train_seeds, test_seed = [1, 2, 3, 4], [5]
    raw_train = rows_for(parts, train_seeds)
    models = tmp_path / "models"
    meta = train_from_rows(raw_train, models, lambda d: rows_for(parts, train_seeds, Corrections.maybe(d)))
    assert meta["count_rows"] == len(raw_train) and (models / "count.txt").exists()
    test_raw = rows_for(parts, test_seed)
    corrections = Corrections.maybe(models)
    test_fixed = rows_for(parts, test_seed, corrections)
    report = evaluate(test_raw, test_fixed)["U_SECURITY_QUEUE"]
    assert report["count_mae_kalman_a2"] < report["count_mae_kalman"], report
    json.dumps(report)                                                          # plain numbers, ready for accuracy.json
    if (models / "wait.txt").exists():
        assert report["wait_mae_with_ml_min"] is not None


def test_detector_fit_recovers_its_parameters():
    rng = np.random.default_rng(4)
    h = rng.uniform(5, 150, 6000)
    vis = rng.uniform(0, 1, 6000)
    truth = np.array([0.93, 30.0, 6.0, 0.4, 0.08])
    detected = rng.random(6000) < recall_sigmoids(h, vis, truth)
    fit = fit_detector(h, vis, detected)
    assert fit["recall_max"] == pytest.approx(0.93, abs=0.03) and fit["h0"] == pytest.approx(30, abs=4) and fit["vis0"] == pytest.approx(0.4, abs=0.04)


def test_curve_fit_needs_enough_people():
    assert fit_curve([100.0] * 10, 25.0, 1.0) is None
    rng = np.random.default_rng(1)
    curve = fit_curve(list(rng.lognormal(np.log(110), 0.3, 500)), 25.0, 1.0)
    assert curve.median_min == pytest.approx(110, rel=0.05) and curve.sigma == pytest.approx(0.3, abs=0.03)


def test_lane_rate_counts_only_lanes_that_had_someone(tmp_path):
    # 2 lanes. Five waiting for 10 minutes; then one waiting, one lane idle: that stretch says nothing about a lane's speed.
    lines = [{"t_s": 60.0 * i, "zones": [{"zone": "U_SECURITY_QUEUE", "waiting": 5 if i < 10 else 1, "waitMin": 1}], "lanes": {"U_SECURITY_QUEUE": 2}, "queue_exits": {"security": 3}} for i in range(20)]
    (tmp_path / "truth.jsonl").write_text("\n".join(json.dumps(line) for line in lines))
    exits, lane_min = lane_rate(tmp_path)["security"]
    assert lane_min == pytest.approx(9 * 2) and exits == pytest.approx(27)


def test_a_thin_run_leaves_the_prior_in_place(tmp_path):
    lines = [{"t_s": 60.0 * i, "zones": [{"zone": "U_SECURITY_QUEUE", "waiting": 5, "waitMin": 1}], "lanes": {"U_SECURITY_QUEUE": 2}, "queue_exits": {"security": 1}} for i in range(5)]
    (tmp_path / "truth.jsonl").write_text("\n".join(json.dumps(line) for line in lines))
    assert calibrate([tmp_path])["mu0"] == {}


def test_a_calibration_only_replaces_the_priors_when_loaded(tmp_path):
    before = CURVES["security"]
    try:
        (tmp_path / "calibration.json").write_text(json.dumps({"curves": {"security": {"median_min": 90.0, "sigma": 0.2, "cutoff_min": 25.0, "share": 1.0}}}))
        assert load_calibration(tmp_path)["curves"]["security"]["median_min"] == 90.0
        assert CURVES["security"].median_min == 90.0
    finally:
        CURVES["security"] = before
    assert load_calibration(tmp_path / "none") is None


def test_no_models_means_no_corrections(tmp_path):
    assert Corrections.maybe(tmp_path) is None


def test_read_jsonl_missing_is_empty(tmp_path):
    assert read_jsonl(tmp_path / "nope.jsonl") == []
    (tmp_path / "a.jsonl").write_text('{"t_s": 1}\n\n{"t_s": 2}\n')
    assert [r["t_s"] for r in read_jsonl(tmp_path / "a.jsonl")] == [1, 2]


def test_timeline_applies_lanes_when_they_happened(parts):
    terminal, cameras, queues = parts
    book = LaneBook(terminal.initial_lanes)
    chain = Chain(terminal, cameras, queues, book)
    timeline = Timeline(flights=[], ops=[{"t_s": 100.0, "type": "staff", "zone": "security", "delta": 1}, {"t_s": 200.0, "type": "evacuate", "zones": ["X"]}])
    timeline.advance(50.0, book, chain)
    assert book.lanes("security") == 2 and timeline.evacuation_t is None
    timeline.advance(150.0, book, chain)
    assert book.lanes("security") == 3
    timeline.advance(250.0, book, chain)
    assert timeline.evacuation_t == 200.0
    fresh = LaneBook(terminal.initial_lanes)
    absolute = Timeline(flights=[], ops=[{"t_s": 10.0, "type": "lanes", "zone": "U_SECURITY_QUEUE", "open": 1}])     # Unity's form
    absolute.advance(20.0, fresh, chain)
    assert fresh.lanes("security") == 1

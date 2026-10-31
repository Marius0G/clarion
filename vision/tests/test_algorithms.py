"""Quick checks on synthetic numbers: A3, A4, A5, A7."""
import math

import numpy as np
import pytest

from clarion_vision.advice import advise
from clarion_vision.forecast import CURVES, ArrivalScale, Curve, Flight, arrival_rates, fluid_queue, forecast_points, sim_seconds, wait_curve
from clarion_vision.kalman import CountFilter, count_variance
from clarion_vision.wait import HeadRate, wait_minutes, wait_p90


# ---- A3
def test_filter_converges_on_counts():
    f = CountFilter(sd0=30.0)
    rng = np.random.default_rng(1)
    for _ in range(120):
        f.predict(1.0)
        f.update_count(40 + rng.normal(0, 2), 4.0)
    assert abs(f.n - 40) < 2 and f.sd < 2


def test_low_coverage_is_believed_less():
    assert count_variance(10, 0.2) > count_variance(30, 0.6) > count_variance(50, 1.0)
    seen, blind = CountFilter(n0=0, sd0=10), CountFilter(n0=0, sd0=10)
    seen.update_count(50, count_variance(50, 1.0))
    blind.update_count(50, count_variance(5, 0.1))
    assert seen.n > blind.n and seen.sd < blind.sd


def test_flows_carry_the_count_when_the_camera_drops_and_sd_grows():
    f = CountFilter(n0=40, sd0=1)
    for _ in range(60):                       # a minute of seen arrivals at 0.5/s
        f.predict(1.0, left=0.0)
        f.update_in_rate(0.5, 0.04)
    n0, sd0 = f.n, f.sd
    for _ in range(120):                      # camera down: 0.5/s in, 0.25/s out
        f.predict(1.0, left=0.25)
    assert f.n == pytest.approx(n0 + 120 * (f.lam - 0.25), abs=2) and f.sd > sd0 * 2


def test_lane_change_visible_through_exits_never_negative():
    f = CountFilter(n0=2, sd0=1)
    f.predict(1.0, left=5.0)
    assert f.n == 0.0


# ---- A4
def test_wait_formula_and_lane_response():
    assert wait_minutes(30, 2.0, 3) == pytest.approx(5.0)
    assert wait_minutes(30, 2.0, 2) > wait_minutes(30, 2.0, 3)
    assert wait_minutes(0, 2.0, 0) == 0.0
    assert math.isfinite(wait_minutes(30, 2.0, 0))


def test_head_rate_measures_and_forgets():
    h = HeadRate(mu0=2.5, window_s=300, prior_lane_min=3)
    assert h.mu == 2.5
    for t in range(600):                       # 4/min per lane on 2 lanes
        h.add(float(t), (8 / 60.0), 1.0, 2, True)
    assert h.mu == pytest.approx(4.0, abs=0.3)
    for t in range(600, 1000):                 # empty queue: says nothing, the last measurement stands
        h.add(float(t), 0.0, 1.0, 2, False)
    assert h.mu == pytest.approx(4.0, abs=0.1)
    assert h.lane_min == pytest.approx(0.0, abs=1e-9)


def test_head_rate_is_per_lane():
    a, b = HeadRate(2.0), HeadRate(2.0)
    for t in range(300):
        a.add(float(t), 6 / 60, 1.0, 2, True)
        b.add(float(t), 12 / 60, 1.0, 4, True)
    assert a.mu == pytest.approx(b.mu, abs=0.05)


def test_p90_from_the_sd():
    w = wait_minutes(30, 2.0, 2)
    assert wait_p90(30, 0.0, 2.0, 0.0, 2) == pytest.approx(w)
    assert wait_p90(30, 5.0, 2.0, 0.0, 2) == pytest.approx(w + 1.2816 * 5 / 4, abs=1e-3)
    assert wait_p90(30, 5.0, 2.0, 0.5, 2) > wait_p90(30, 5.0, 2.0, 0.0, 2)


# ---- A5
def flight(std_h=10.0, pax=180, **kw):
    return Flight(flight="W6 1", std_s=std_h * 3600, pax=pax, **kw)


def test_times_parse():
    assert sim_seconds("09:40") == 9 * 3600 + 40 * 60
    assert sim_seconds(3600) == 3600
    assert sim_seconds("nope") is None


def test_curve_integrates_to_the_flight():
    c = Curve(85.0, 0.35, 25.0)
    lam = arrival_rates([flight(pax=180)], 6 * 3600, c, 300)
    assert lam.sum() == pytest.approx(180, abs=3)
    assert lam.argmax() == pytest.approx(240 - 85, abs=15)
    assert lam[240 - 20] == 0.0                # past the cutoff nobody arrives


def test_delayed_moves_the_curve_cancelled_leaves_it():
    c = CURVES["security"]
    base = arrival_rates([flight()], 8 * 3600, c, 120)
    late = arrival_rates([flight(delay_min=60)], 8 * 3600, c, 120)
    assert late[60:121] == pytest.approx(base[0:61], abs=1e-9)
    assert arrival_rates([flight(status="cancelled")], 8 * 3600, c, 120).sum() == 0.0
    assert arrival_rates([flight(status="departed")], 8 * 3600, c, 120).sum() == 0.0


def test_fluid_queue():
    lam = np.array([5.0, 5.0, 5.0, 0.0, 0.0])
    assert fluid_queue(0.0, lam, 1.0, 2) == pytest.approx([0, 3, 6, 9, 7])
    assert fluid_queue(4.0, np.zeros(4), 1.0, 2).tolist() == [4, 2, 0, 0]


def test_a_new_lane_changes_the_forecast_at_once():
    lam = arrival_rates([flight(pax=500)], 8 * 3600, CURVES["security"], 120)
    two = forecast_points(wait_curve(20, lam, 1.5, 2))
    three = forecast_points(wait_curve(20, lam, 1.5, 3))
    assert [p["inMin"] for p in two] == [30, 60, 90, 120]
    assert all(b["waitMin"] <= a["waitMin"] for a, b in zip(two, three)) and three[1]["waitMin"] < two[1]["waitMin"]


def test_live_scale_grows_with_what_the_cameras_saw():
    s = ArrivalScale(pseudo=30)
    assert s.factor == 1.0
    s.add(expected=100, seen=200)
    assert s.factor == pytest.approx(230 / 130)
    s.add(expected=0, seen=1000)
    assert s.factor == 2.0


# ---- A7
def test_no_advice_under_target():
    assert advise(5, np.zeros(61), 2.0, 2, 10, 4, 3600.0) is None


def test_advice_fewest_lanes_and_by_when():
    lam = np.concatenate((np.zeros(31), np.full(30, 8.0)))    # nothing for 30 min, then 8/min
    a = advise(0, lam, 2.0, 2, 10, 6, 36000.0, lead_min=5)
    # 8/min against 2 lanes x 2/min: the queue grows 4/min from minute 30, wait = L/4 > 10 at L > 40
    assert a["lanes"] == 3
    over = int(np.nonzero(wait_curve(0, lam, 2.0, 2) > 10)[0][0])
    assert a["by"] == 36000 + (over - 5) * 60
    assert a["waitMinIfNot"] == pytest.approx(wait_curve(0, lam, 2.0, 2).max(), abs=0.1)


def test_advice_now_when_over_already():
    a = advise(60, np.zeros(61), 2.0, 2, 10, 4, 1000.0)
    assert a["by"] == 1000 and a["lanes"] == 3 and a["waitMinIfNot"] == 15.0


def test_no_advice_when_no_lane_left():
    assert advise(100, np.zeros(61), 2.0, 4, 10, 4, 0.0) is None

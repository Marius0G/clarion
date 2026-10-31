"""A11's physics calibration, from training seeds only: when passengers present themselves (A5's curves), how fast a lane works
(A4's starting mu), and how far the evacuation flow is from what Unity's crowd did (A9). Offline; reads truth, like dataset.py.
The live service only reads the numbers this leaves in models/calibration.json."""
from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np

from ..forecast import CURVES, Curve, Flight
from ..queues import _PARAMS as QUEUE_PARAMS
from .dataset import read_jsonl

QUEUE_STAGES = {"security": ("SecurityQueue",), "check_in": ("BagDropQueue", "CheckInQueue")}
MIN_SAMPLES = 50
MIN_LANE_MIN, MIN_EXITS = 20.0, 30.0
CUTOFF_MIN = {"security": 25.0, "check_in": 40.0}


def _flights(run_dir: Path) -> list[Flight]:
    lines = read_jsonl(run_dir / "flights.jsonl")
    if not lines:
        return []
    rows = {r["flight"]: r for line in lines for r in line["flights"]}      # the last word on each flight: delays included
    return [f for f in (Flight.parse(r) for r in rows.values()) if f is not None and f.status != "cancelled"]


def minutes_before(run_dir: Path) -> dict[str, list[float]]:
    """For each queue kind, how long before the next departure each passenger joined it. There is no identity to tell which
    flight someone is on, so this takes the next departure with time left to reach it: a fair reading while flights are hours apart."""
    flights = sorted(f.etd_s for f in _flights(run_dir))
    out: dict[str, list[float]] = {kind: [] for kind in QUEUE_STAGES}
    path = run_dir / "stages.csv"
    if not flights or not path.exists():
        return out
    with open(path, encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            for kind, stages in QUEUE_STAGES.items():
                if row["stage"] in stages:
                    t = float(row["begin_s"])
                    later = [etd for etd in flights if etd > t + CUTOFF_MIN[kind] * 60.0]
                    if later:
                        out[kind].append((later[0] - t) / 60.0)
    return out


def fit_curve(minutes: list[float], cutoff_min: float, share: float) -> Curve | None:
    """Lognormal by the moments of the log. Too few passengers: no fit, the prior stays."""
    if len(minutes) < MIN_SAMPLES:
        return None
    logs = np.log(np.asarray(minutes, dtype=float))
    return Curve(float(np.exp(np.median(logs))), float(max(np.std(logs), 0.05)), cutoff_min, share)


def lane_rate(run_dir: Path) -> dict[str, tuple[float, float]]:
    """Exits per busy lane-minute, per kind of queue: (exits, lane-minutes). Only with every open lane fed (waiting >= lanes): with
    fewer people some lanes stand idle, and a thin queue is one that happened to get served slowly, so the rate would read low."""
    lines = read_jsonl(run_dir / "truth.jsonl")
    out: dict[str, list[float]] = {}
    names = {"security": ("security", "U_SECURITY_QUEUE"), "checkin_group_1": ("check_in", "check_in:1"), "checkin_group_2": ("check_in", "check_in:2"),
             "checkin_group_3": ("check_in", "check_in:3")}
    for a, b in zip(lines, lines[1:]):
        zones = {z["zone"]: z for z in b.get("zones") or []}
        for queue, (kind, zone) in names.items():
            row = zones.get(zone)
            lanes = (b.get("lanes") or {}).get(zone) or 0
            if row is None or lanes <= 0 or row["waiting"] < lanes:
                continue
            slot = out.setdefault(kind, [0.0, 0.0])
            slot[0] += float((b.get("queue_exits") or {}).get(queue, 0))
            slot[1] += (b["t_s"] - a["t_s"]) / 60.0 * lanes
    return {q: (v[0], v[1]) for q, v in out.items()}


def calibrate(run_dirs: list[Path], evac_records: list[dict] | None = None) -> dict:
    minutes: dict[str, list[float]] = {kind: [] for kind in QUEUE_STAGES}
    rates: dict[str, list[float]] = {}
    for run_dir in run_dirs:
        for kind, values in minutes_before(run_dir).items():
            minutes[kind].extend(values)
        for queue, (exits, lane_min) in lane_rate(run_dir).items():
            slot = rates.setdefault(queue, [0.0, 0.0])
            slot[0] += exits
            slot[1] += lane_min
    out: dict = {"seeds_used": len(run_dirs), "curves": {}, "mu0": {}, "samples": {k: len(v) for k, v in minutes.items()}}
    # Share of those going through security who stopped at a desk first.
    share = min(1.0, len(minutes["check_in"]) / len(minutes["security"])) if minutes["security"] else CURVES["check_in"].share
    for kind, values in minutes.items():
        curve = fit_curve(values, CUTOFF_MIN[kind], share if kind == "check_in" else 1.0)
        if curve:
            out["curves"][kind] = {"median_min": curve.median_min, "sigma": curve.sigma, "cutoff_min": curve.cutoff_min, "share": curve.share}
    for kind, (exits, lane_min) in rates.items():
        if lane_min >= MIN_LANE_MIN and exits >= MIN_EXITS:
            out["mu0"][kind] = exits / lane_min
    if evac_records:
        pairs = [r for r in evac_records if r.get("true_last_out") and r.get("flow_clear_s")]
        if pairs:
            ratios = [r["true_last_out"] / r["flow_clear_s"] for r in pairs]
            out["evac"] = {"runs": len(pairs), "last_out_over_flow_median": float(np.median(ratios)), "min": float(np.min(ratios)), "max": float(np.max(ratios))}
    return out


def apply_calibration(data: dict) -> None:
    """Replaces the priors in forecast.CURVES and queues._PARAMS. Called once at start, before the queues are loaded."""
    for kind, c in (data.get("curves") or {}).items():
        CURVES[kind] = Curve(c["median_min"], c["sigma"], c["cutoff_min"], c.get("share", 1.0))
    for kind, mu in (data.get("mu0") or {}).items():
        for params in QUEUE_PARAMS.values():
            if params["curve"] == kind:
                params["mu0"] = float(mu)


def load_calibration(model_dir: Path) -> dict | None:
    path = Path(model_dir) / "calibration.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    apply_calibration(data)
    return data


def recall_sigmoids(h: np.ndarray, vis: np.ndarray, p: np.ndarray) -> np.ndarray:
    """recall = recall_max x sigmoid((h - h0) / hs) x sigmoid((vis - vis0) / viss), the simulated detector's model (CctvLive.cs)."""
    recall_max, h0, hs, vis0, viss = p
    with np.errstate(over="ignore"):
        return recall_max / (1.0 + np.exp(-(h - h0) / hs)) / (1.0 + np.exp(-(vis - vis0) / viss))


def fit_detector(box_h: np.ndarray, visibility: np.ndarray, detected: np.ndarray) -> dict:
    """Its parameters from labelled boxes and what YOLO found among them, by maximum likelihood."""
    from scipy.optimize import minimize
    box_h, visibility, detected = map(lambda a: np.asarray(a, dtype=float), (box_h, visibility, detected))

    def loss(p):
        r = np.clip(recall_sigmoids(box_h, visibility, p), 1e-4, 1 - 1e-4)
        return -float(np.sum(detected * np.log(r) + (1 - detected) * np.log(1 - r)))

    fit = minimize(loss, x0=[0.95, 25.0, 6.0, 0.35, 0.1], method="L-BFGS-B", bounds=[(0.3, 0.995), (1.0, 300.0), (0.5, 80.0), (0.0, 1.0), (0.01, 0.5)])
    recall_max, h0, hs, vis0, viss = (float(v) for v in fit.x)
    return {"recall_max": recall_max, "h0": h0, "hs": hs, "vis0": vis0, "viss": viss, "boxes": int(box_h.size), "detected_share": float(detected.mean())}


__all__ = ["calibrate", "apply_calibration", "load_calibration", "fit_curve", "fit_detector", "lane_rate", "minutes_before", "recall_sigmoids"]

"""A11: train the corrections on simulated days, keep some seeds apart, and report the error on those seeds only (D19).
Two passes: A2 on the raw replay; then A4 and A5 on a replay that already has A2, because that is what they see live.

    python -m clarion_vision.ml.train <runs dir> [--test-share 0.25] [--workers 4] [--out models]

Writes models/{count,wait,forecast_30..120}.txt, meta.json and accuracy.json. Every figure in accuracy.json is measured on the
held-out seeds; when a run set is too small to say something, it says so instead of a number."""
from __future__ import annotations

import argparse
import json
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from ..forecast import HORIZONS_MIN
from ..terminal import load_terminal
from .calibrate import calibrate, load_calibration
from .dataset import read_run
from .runtime import COUNT_FEATURES, COUNT_SD_EDGES, FORECAST_FEATURES, MODEL_DIR, WAIT_FEATURES, Corrections

PARAMS = {"objective": "l1", "learning_rate": 0.05, "num_leaves": 15, "min_data_in_leaf": 40, "feature_fraction": 0.9, "bagging_fraction": 0.8,
          "bagging_freq": 1, "lambda_l2": 1.0, "verbosity": -1, "num_threads": 4, "seed": 7}
ROUNDS = 300
MIN_ROWS = 200
OVERFLOW_ROWS = 12


def fit(x: np.ndarray, y: np.ndarray, names: list[str]):
    import lightgbm as lgb
    return lgb.train(PARAMS, lgb.Dataset(x, label=y, feature_name=names, free_raw_data=False), num_boost_round=ROUNDS)


def matrix(rows: list[dict], key: str, names: list[str]) -> np.ndarray:
    return np.array([[float(r[key].get(n, 0.0)) for n in names] for r in rows], dtype=float)


def forecast_matrix(rows: list[dict], horizon: int) -> np.ndarray:
    extended = [{"f": {**r["wait_features"], "raw_at_horizon": r["forecast_raw"][horizon], "lam_at_horizon": r["lam_at"][horizon]}} for r in rows]
    return matrix(extended, "f", FORECAST_FEATURES)


def mae(a, b) -> float | None:
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    return float(np.mean(np.abs(a - b))) if a.size else None


def split_seeds(seeds: list[int], share: float) -> tuple[list[int], list[int]]:
    """Held-out seeds: the last ones. Deterministic, and never mixed with training."""
    seeds = sorted(set(seeds))
    n_test = max(1, int(round(len(seeds) * share)))
    return seeds[:-n_test], seeds[-n_test:]


def train_count(rows: list[dict], out: Path) -> dict:
    """A2, and how far to believe it. The spread is by size of the estimate: a queue that has outgrown its cameras misses by
    hundreds, and one overall figure would make the filter distrust the small queues too."""
    y = np.array([r["true_n"] - r["raw_count"] for r in rows])
    x = matrix(rows, "count_features", COUNT_FEATURES)
    model = fit(x, y, COUNT_FEATURES)
    model.save_model(str(out / "count.txt"))
    residual = y - model.predict(x)
    estimate = np.array([r["raw_count"] for r in rows]) + model.predict(x)
    sd = [float(np.std(residual[(estimate >= a) & (estimate < b)])) if ((estimate >= a) & (estimate < b)).sum() >= 30 else None for a, b in zip(COUNT_SD_EDGES, COUNT_SD_EDGES[1:])]
    return {"count_residual_sd": float(np.std(residual)), "count_sd_by_size": sd, "count_rows": len(rows)}


def train_waits(rows: list[dict], out: Path) -> dict:
    meta: dict = {}
    usable = [r for r in rows if r["true_wait"] is not None]
    if len(usable) >= MIN_ROWS:
        x = matrix(usable, "wait_features", WAIT_FEATURES)
        y = np.array([r["true_wait"] - r["wait_features"]["wait"] for r in usable])
        fit(x, y, WAIT_FEATURES).save_model(str(out / "wait.txt"))
        meta["wait_rows"] = len(usable)
    for h in HORIZONS_MIN:
        subset = [r for r in rows if h in r["true_future"]]
        if len(subset) < MIN_ROWS:
            meta[f"forecast_{h}_rows"] = len(subset)
            continue
        y = np.array([r["true_future"][h] - r["forecast_raw"][h] for r in subset])
        fit(forecast_matrix(subset, h), y, FORECAST_FEATURES).save_model(str(out / f"forecast_{h}.txt"))
        meta[f"forecast_{h}_rows"] = len(subset)
    return meta


def evaluate(raw_rows: list[dict], corrected_rows: list[dict]) -> dict:
    """Error on held-out seeds, per queue: the physics alone against the physics with the corrections. Each queue also has the
    same figures for the times the sim's bodies could be counted at all (see countable)."""
    report: dict = {}
    for zone in sorted({r["zone"] for r in raw_rows}):
        raw = [r for r in raw_rows if r["zone"] == zone]
        fixed = [r for r in corrected_rows if r["zone"] == zone]
        report[zone] = _errors(raw, fixed)
        within = [r for r in raw if countable(r)], [r for r in fixed if countable(r)]
        if len(within[0]) < len(raw) and within[0]:
            report[zone]["countable"] = {"up_to_people": raw[0]["capacity"] + OVERFLOW_ROWS, **_errors(*within)}
    return report


def countable(row: dict) -> bool:
    """Past its last slot a queue stands behind the tail, but Unity caps that at OVERFLOW_ROWS (PeopleNav.Overflow) and piles everyone
    further back on the same points, so no camera could count them. That is a limit of the sim, so training skips those moments."""
    return row["capacity"] <= 0 or row["true_n"] <= row["capacity"] + OVERFLOW_ROWS


def _errors(raw: list[dict], fixed: list[dict]) -> dict:
    block = {"rows": len(raw), "true_queue_mean": float(np.mean([r["true_n"] for r in raw])),
             "count_mae_raw_detections": mae([r["raw_count"] for r in raw], [r["true_n"] for r in raw]),
             "count_mae_kalman": mae([r["n"] for r in raw], [r["true_n"] for r in raw]),
             "count_mae_kalman_a2": mae([r["n"] for r in fixed], [r["true_n"] for r in fixed])}
    waits_raw = [r for r in raw if r["true_wait"] is not None]
    waits_fixed = [r for r in fixed if r["true_wait"] is not None]
    block["wait_mae_physics_min"] = mae([r["shown_wait"] for r in waits_raw], [r["true_wait"] for r in waits_raw])
    block["wait_mae_with_ml_min"] = mae([r["shown_wait"] for r in waits_fixed], [r["true_wait"] for r in waits_fixed])
    finishers = [r for r in fixed if r.get("finishers_wait") is not None]        # what the live panel compares against: it lags, see JoinWaits
    block["wait_mae_with_ml_vs_recent_finishers_min"] = mae([r["shown_wait"] for r in finishers], [r["finishers_wait"] for r in finishers])
    for h in HORIZONS_MIN:
        a = [r for r in raw if h in r["true_future"]]
        b = [r for r in fixed if h in r["true_future"] and h in r["forecast_shown"]]
        block[f"forecast_{h}_mae_physics_min"] = mae([r["forecast_raw"][h] for r in a], [r["true_future"][h] for r in a])
        block[f"forecast_{h}_mae_with_ml_min"] = mae([r["forecast_shown"][h] for r in b], [r["true_future"][h] for r in b])
    return block


def _detector_of(run_dir: Path) -> str:
    with open(run_dir / "detlog.jsonl", encoding="utf-8") as handle:
        return str(json.loads(handle.readline()).get("detector") or "simulated")


def _run_one(args) -> tuple[list[dict], dict | None]:
    run_dir, model_dir = args
    corrections = Corrections.maybe(Path(model_dir)) if model_dir else None
    if model_dir:
        load_calibration(Path(model_dir))
    return read_run(Path(run_dir), load_terminal(), corrections)


def evac_report(records: list[dict]) -> dict:
    """A9 against Unity's crowd on held-out evacuations. Its sources are the cameras' estimate plus the low-confidence estimate
    of the zones no camera sees; the last figure shows how each compares with the real number of people."""
    pairs = [r for r in records if r and r.get("true_last_out")]
    if not pairs:
        return {"runs": 0, "note": "no held-out run with an evacuation: nothing measured"}
    return {"runs": len(pairs), "last_out_mae_s": mae([r["flow_clear_s"] for r in pairs], [r["true_last_out"] for r in pairs]),
            "t90_mae_s": mae([r["flow_t90_s"] for r in pairs if r.get("true_t90")], [r["true_t90"] for r in pairs if r.get("true_t90")]),
            "people_total_of_which_estimated_vs_true": [[r["flow_people"], r.get("flow_people_estimated"), r.get("true_people")] for r in pairs]}


def train_from_rows(train_raw: list[dict], out: Path, second_pass) -> dict:
    """The two passes. second_pass(model_dir) returns the training rows replayed with A2 in place."""
    out.mkdir(parents=True, exist_ok=True)
    meta = {"count_rows": 0}
    usable = [r for r in train_raw if countable(r)]
    if len(usable) >= MIN_ROWS:
        meta.update(train_count(usable, out))
    (out / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    meta.update(train_waits([r for r in second_pass(out) if countable(r)], out))
    (out / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return meta


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("runs")
    ap.add_argument("--test-share", type=float, default=0.25)
    ap.add_argument("--workers", type=int, default=4, help="each replay holds under 1 GB; keep the total under 8 GB")
    ap.add_argument("--out", default=str(MODEL_DIR))
    ap.add_argument("--final", action="store_true", help="train on every run, for the demo's models: no seed held out, so no accuracy figures come from this")
    a = ap.parse_args()
    runs = sorted(p for p in Path(a.runs).iterdir() if not p.name.endswith(".tmp") and all((p / f).exists() for f in ("run.json", "detlog.jsonl", "truth.jsonl")))
    if not runs or (len(runs) < 2 and not a.final):
        raise SystemExit(f"{a.runs}: {len(runs)} complete run(s). Held-out figures need at least two seeds.")
    seed_of = {r: int(json.loads((r / "run.json").read_text(encoding="utf-8"))["seed"]) for r in runs}
    train_seeds, test_seeds = (sorted(set(seed_of.values())), []) if a.final else split_seeds(list(seed_of.values()), a.test_share)
    train_runs = [r for r in runs if seed_of[r] in train_seeds]
    test_runs = [r for r in runs if seed_of[r] in test_seeds]
    print(f"{len(train_runs)} training runs, seeds {train_seeds}; {len(test_runs)} held out, seeds {test_seeds}", flush=True)

    def pool_rows(run_list, model_dir=None) -> tuple[list[dict], list[dict]]:
        with ProcessPoolExecutor(max_workers=a.workers) as pool:
            results = list(pool.map(_run_one, [(str(r), model_dir) for r in run_list]))
        return [row for rows, _ in results for row in rows], [record for _, record in results if record]

    out = Path(a.out)
    with tempfile.TemporaryDirectory() as tmp:
        working = Path(tmp) / "models"
        working.mkdir(parents=True)
        # The physics first, from the training seeds. Everything after this, on every seed, runs on these numbers.
        calibration = calibrate(train_runs)
        (working / "calibration.json").write_text(json.dumps(calibration, indent=1), encoding="utf-8")
        print("calibration:", json.dumps(calibration), flush=True)
        train_calibrated, train_evac = pool_rows(train_runs, str(working))
        calibration = calibrate(train_runs, train_evac)
        (working / "calibration.json").write_text(json.dumps(calibration, indent=1), encoding="utf-8")
        meta = train_from_rows(train_calibrated, working, lambda d: pool_rows(train_runs, str(d))[0])
        del train_calibrated
        meta.update(detector=_detector_of(train_runs[0]), train_seeds=train_seeds, test_seeds=test_seeds)
        (working / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
        test_raw, test_fixed, test_evac = [], [], []
        if test_runs:
            test_raw, _ = pool_rows(test_runs)                     # the priors alone, no calibration, no models
            test_fixed, test_evac = pool_rows(test_runs, str(working))
        out.mkdir(parents=True, exist_ok=True)
        for f in working.iterdir():
            (out / f.name).write_bytes(f.read_bytes())
    if a.final:
        print(f"models written to {out}, trained on all {len(train_runs)} runs. No seed held out: use the held-out accuracy.json, not this run, for any figure.")
        return
    accuracy = {"test_seeds": test_seeds, "train_seeds": train_seeds, "note": "held-out seeds only; 'physics' = before calibration and ML, 'with_ml' = both",
                "detector": meta["detector"], "queues": evaluate(test_raw, test_fixed), "evacuation": evac_report(test_evac), "calibration": calibration, "meta": meta}
    (out / "accuracy.json").write_text(json.dumps(accuracy, indent=1), encoding="utf-8")
    print(json.dumps({k: accuracy[k] for k in ("queues", "evacuation")}, indent=1))


if __name__ == "__main__":
    main()

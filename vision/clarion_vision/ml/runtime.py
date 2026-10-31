"""The ML corrections at run time (A2, A4, A5): LightGBM models learn the physics' systematic error, they do not replace it.
No models on disk means no corrections, and the chain runs on the physics alone. Each model predicts a residual, so a feature
outside what it has seen moves the estimate little."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from ..config import VISION_DIR
from ..forecast import HORIZONS_MIN

MODEL_DIR = VISION_DIR / "models"
COUNT_FEATURES = ["kind", "count", "coverage", "density_seen", "mean_box_h", "mean_conf", "n_cameras"]
WAIT_FEATURES = ["kind", "wait", "queue", "sd", "mu", "lanes", "lam_now", "lam_filter", "trend", "scale", "departures_next_hour"]
FORECAST_FEATURES = WAIT_FEATURES + ["raw_at_horizon", "lam_at_horizon"]
WAIT_MAX_MIN = 240.0


def _vector(features: dict, names: list[str]) -> np.ndarray:
    return np.array([[float(features.get(n, 0.0)) for n in names]], dtype=float)


class Corrections:
    def __init__(self, model_dir: Path = MODEL_DIR):
        import lightgbm as lgb
        self.dir = Path(model_dir)
        self.meta = json.loads((self.dir / "meta.json").read_text(encoding="utf-8"))
        load = lambda name: lgb.Booster(model_file=str(self.dir / f"{name}.txt")) if (self.dir / f"{name}.txt").exists() else None
        self.count_model = load("count")
        self.wait_model = load("wait")
        self.forecast_models = {h: load(f"forecast_{h}") for h in HORIZONS_MIN}
        self.count_sd = float(self.meta.get("count_residual_sd", 3.0))

    @staticmethod
    def maybe(model_dir: Path = MODEL_DIR) -> "Corrections | None":
        return Corrections(model_dir) if (Path(model_dir) / "meta.json").exists() else None

    def count(self, features: dict) -> tuple[float, float] | None:
        """A2: (the zone's corrected count, its variance), or None for the plain count / coverage."""
        if self.count_model is None:
            return None
        raw = features["count"] / max(features["coverage"], 1e-3)
        value = raw + float(self.count_model.predict(_vector(features, COUNT_FEATURES))[0])
        spread = self.count_sd * (1.0 + (1.0 - min(features["coverage"], 1.0)))
        return max(float(features["count"]), value), spread ** 2

    def wait(self, features: dict) -> float:
        if self.wait_model is None:
            return features["wait"]
        return float(np.clip(features["wait"] + self.wait_model.predict(_vector(features, WAIT_FEATURES))[0], 0.0, WAIT_MAX_MIN))

    def forecast(self, features: dict, lam: np.ndarray):
        def correct(horizon: int, wait: float) -> float:
            model = self.forecast_models.get(horizon)
            if model is None:
                return wait
            row = {**features, "raw_at_horizon": wait, "lam_at_horizon": float(lam[min(horizon, len(lam) - 1)])}
            return float(np.clip(wait + model.predict(_vector(row, FORECAST_FEATURES))[0], 0.0, WAIT_MAX_MIN))
        return correct

"""A7. Lane advice: the fewest lanes that keep the forecast wait under target for the next hour, and by when to open them."""
from __future__ import annotations

import numpy as np

from .forecast import wait_curve

TARGET_MIN = {"security": 10.0, "check_in": 15.0, "bag_drop": 15.0}


def advise(queue0: float, lam: np.ndarray, mu: float, lanes_now: int, target_min: float, max_lanes: int, now_s: float,
           horizon_min: int = 60, lead_min: float = 5.0) -> dict | None:
    """{lanes (total required), by (sim seconds), waitMinIfNot (the hour's peak with today's lanes)}, or None when the
    forecast stays under target or no more lanes exist."""
    lam = lam[: horizon_min + 1]
    current = wait_curve(queue0, lam, mu, lanes_now)
    over = np.nonzero(current > target_min)[0]
    if over.size == 0 or lanes_now >= max_lanes:
        return None
    needed = max_lanes
    for lanes in range(lanes_now + 1, max_lanes + 1):
        if wait_curve(queue0, lam, mu, lanes).max() <= target_min:
            needed = lanes
            break
    by = now_s + max(0.0, float(over[0]) - lead_min) * 60.0
    return {"lanes": int(needed), "by": round(by), "waitMinIfNot": round(float(current.max()), 1)}

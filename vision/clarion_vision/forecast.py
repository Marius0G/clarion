"""A5. Forecast at +30/60/90/120 min: presentation curves x schedule, then a fluid queue. Times in sim seconds, rates in
people/min. A delayed flight moves its curve, a cancelled one leaves it, a lane opened by the admin changes capacity at once."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

import numpy as np

from .mapids import lanes_key
from .wait import WAIT_CAP_MIN, wait_minutes

HORIZONS_MIN = (30, 60, 90, 120)
GATE_CLOSE_BEFORE_MIN = 30.0


def sim_seconds(value) -> float | None:
    """A sim time as Unity sends it: seconds, or "HH:MM" / "HH:MM:SS"."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if math.isfinite(value) and value >= 0 else None
    m = re.match(r"^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$", value) if isinstance(value, str) else None
    return int(m[1]) * 3600.0 + int(m[2]) * 60.0 + int(m[3] or 0) if m else None


@dataclass(frozen=True)
class Flight:
    flight: str
    std_s: float
    pax: int
    status: str = "scheduled"
    delay_min: float = 0.0
    check_in: str | None = None          # lanes key of the desk group, check_in:N
    gate: str | None = None

    @property
    def etd_s(self) -> float:
        return self.std_s + self.delay_min * 60.0

    @staticmethod
    def parse(row: dict) -> "Flight | None":
        std = sim_seconds(row.get("std"))
        if std is None:
            return None
        checkin = row.get("checkIn")
        return Flight(flight=str(row.get("flight")), std_s=std, pax=int(row.get("pax") or 0), status=str(row.get("status") or "scheduled"),
                      delay_min=float(row.get("delayMin") or 0.0), check_in=lanes_key(checkin) if checkin else None, gate=row.get("gate"))


@dataclass(frozen=True)
class Curve:
    """When passengers reach a point, in minutes before departure: lognormal, cut off when that point stops accepting."""
    median_min: float
    sigma: float
    cutoff_min: float
    share: float = 1.0      # share of the flight's passengers who pass here

    def rate(self, minutes_before: np.ndarray) -> np.ndarray:
        """Probability density per minute for one passenger; 0 past the cutoff, normalised to integrate to `share`."""
        x = np.asarray(minutes_before, dtype=float)
        out = np.zeros_like(x)
        ok = x > self.cutoff_min
        mu = math.log(self.median_min)
        out[ok] = np.exp(-((np.log(x[ok]) - mu) ** 2) / (2 * self.sigma ** 2)) / (x[ok] * self.sigma * math.sqrt(2 * math.pi))
        z = (math.log(self.cutoff_min) - mu) / self.sigma
        return out * self.share / max(0.5 * math.erfc(z / math.sqrt(2)), 1e-6)


# Priors, not measurements. Re-fit on simulated days (A11) when batch runs exist.
CURVES = {"security": Curve(85.0, 0.35, 25.0), "check_in": Curve(125.0, 0.30, 40.0, share=0.45),
          "passport": Curve(70.0, 0.35, 25.0)}


def arrival_rates(flights: list[Flight], now_s: float, curve: Curve, horizon_min: int = 120,
                  select=lambda f: True) -> np.ndarray:
    """lambda(t) in people/min at t = now, now + 1 min, ... Sum over flights of pax x s(t - STD)."""
    minutes = now_s / 60.0 + np.arange(horizon_min + 1, dtype=float)
    lam = np.zeros(horizon_min + 1)
    for f in flights:
        if f.status in ("cancelled", "departed") or f.pax <= 0 or not select(f):
            continue
        lam += f.pax * curve.rate(f.etd_s / 60.0 - minutes)
    return lam


def fluid_queue(queue0: float, lam: np.ndarray, mu: float, lanes: float) -> np.ndarray:
    """L(t + 1 min) = max(0, L(t) + (lambda - mu x lanes) x 1 min)."""
    out = np.empty(len(lam))
    out[0] = q = max(queue0, 0.0)
    service = mu * lanes
    for i in range(1, len(lam)):
        q = max(0.0, q + lam[i - 1] - service)
        out[i] = q
    return out


def wait_curve(queue0: float, lam: np.ndarray, mu: float, lanes: float) -> np.ndarray:
    """W(t) = L(t) / (mu x lanes), minutes, one value per minute of the horizon."""
    if mu <= 0 or lanes <= 0:
        return np.where(fluid_queue(queue0, lam, mu, lanes) > 0, WAIT_CAP_MIN, 0.0)
    return np.minimum(fluid_queue(queue0, lam, mu, lanes) / (mu * lanes), WAIT_CAP_MIN)


def forecast_points(curve: np.ndarray, correction=None) -> list[dict]:
    """The contract's list. `correction(in_min, wait)` is the ML correction of A5, when a model is loaded."""
    out = []
    for h in HORIZONS_MIN:
        w = float(curve[min(h, len(curve) - 1)])
        if correction is not None:
            w = max(0.0, correction(h, w))
        out.append({"inMin": h, "waitMin": round(w, 2)})
    return out


class ArrivalScale:
    """Live adjustment: when the cameras have seen more arrivals than the curves expected, the rest grows in proportion.
    There is no identity, so this is one factor per queue, not per flight. Arrivals seen = queue growth + exits."""

    def __init__(self, pseudo: float = 30.0, lo: float = 0.5, hi: float = 2.0):
        self.pseudo, self.lo, self.hi = pseudo, lo, hi
        self.expected = 0.0
        self.seen = 0.0

    def add(self, expected: float, seen: float) -> None:
        self.expected += max(expected, 0.0)
        self.seen += seen

    @property
    def factor(self) -> float:
        return min(self.hi, max(self.lo, (max(self.seen, 0.0) + self.pseudo) / (self.expected + self.pseudo)))


__all__ = ["Curve", "CURVES", "Flight", "HORIZONS_MIN", "ArrivalScale", "arrival_rates", "fluid_queue", "forecast_points",
           "wait_curve", "wait_minutes", "sim_seconds"]

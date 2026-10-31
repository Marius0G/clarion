"""A3. Number of people in a zone, from counts and flows.

State [n, lam]: people now, arrival rate (people/s). Prediction adds those who enter and subtracts those who leave; the update
uses the corrected count, believed less the lower the coverage. Pure: no I/O, times in sim seconds. Written out in floats
because it runs per zone per tick: this is the standard filter with F = [[1, dt], [0, 1]] and H = [1, 0] or [0, 1]."""
from __future__ import annotations

import math


def count_variance(count: float, coverage: float, sigma0: float = 1.0, sigma_rel: float = 0.1) -> float:
    """Variance of (count / coverage) as an estimate of the whole zone: the detector's own error, scaled up, plus the
    people in the unseen part (binomial). Grows without bound as coverage falls to 0."""
    cov = max(coverage, 1e-3)
    z = count / cov
    return (sigma0 ** 2 + (sigma_rel * count) ** 2) / cov ** 2 + z * (1.0 - cov) / cov


class CountFilter:
    __slots__ = ("n", "lam", "p00", "p01", "p11", "flows", "q_n", "q_lam")

    def __init__(self, n0: float = 0.0, sd0: float = 20.0, flows: bool = True, q_n: float = 0.05, q_lam: float = 2e-6):
        self.n, self.lam = float(n0), 0.0
        self.p00, self.p01, self.p11 = sd0 ** 2, 0.0, 0.1 ** 2 if flows else 0.0
        self.flows, self.q_n, self.q_lam = flows, q_n, q_lam if flows else 0.0

    @property
    def sd(self) -> float:
        return math.sqrt(max(self.p00, 0.0))

    def predict(self, dt: float, left: float = 0.0, left_var: float | None = None) -> None:
        """Advance dt seconds; `left` people went out in that time (seen at the queue head, or lanes x mu when the camera
        is down). left_var defaults to Poisson, the case of an estimated outflow; pass less when the exits were seen."""
        if dt <= 0:
            return
        self.n = max(0.0, self.n + self.lam * dt - left)
        self.p00 += 2 * dt * self.p01 + dt * dt * self.p11 + self.q_n * dt + (left if left_var is None else left_var)
        self.p01 += dt * self.p11
        self.p11 += self.q_lam * dt

    def update_count(self, z: float, var: float) -> None:
        s = self.p00 + var
        if s <= 0:
            return
        k0, k1 = self.p00 / s, self.p01 / s
        innovation = z - self.n
        self.n = max(0.0, self.n + k0 * innovation)
        self.lam = max(0.0, self.lam + k1 * innovation)
        self.p11 -= k1 * self.p01
        self.p01 *= 1.0 - k0
        self.p00 *= 1.0 - k0

    def update_in_rate(self, rate: float, var: float) -> None:
        if not self.flows:
            return
        s = self.p11 + var
        if s <= 0:
            return
        k0, k1 = self.p01 / s, self.p11 / s
        innovation = rate - self.lam
        self.n = max(0.0, self.n + k0 * innovation)
        self.lam = max(0.0, self.lam + k1 * innovation)
        self.p00 -= k0 * self.p01
        self.p01 *= 1.0 - k1
        self.p11 *= 1.0 - k1

"""A4. The wait now: W = people in the queue / (mu per lane x open lanes), with mu measured at the queue head over 5 min."""
from __future__ import annotations

import math
from collections import deque

WAIT_CAP_MIN = 240.0
Z90 = 1.2816


class HeadRate:
    """Service rate per lane (people/min), from the exits seen at the queue head in the last `window_s` sim seconds.
    Only busy time counts: an empty queue says nothing about how fast a lane works, so the last measurement stands until
    the queue is back. Starts from the prior `mu0` with `prior_lane_min` lane-minutes of weight; once the window holds
    enough, the anchor moves to the measurement itself, so the prior leaves no lasting bias. Never below a quarter of the prior:
    no exits seen usually means the camera missed them, not that the lanes stopped, and mu near 0 would show absurd waits."""

    def __init__(self, mu0: float, window_s: float = 300.0, prior_lane_min: float = 3.0, enough_lane_min: float = 5.0, enough_exits: float = 5.0):
        self.mu0, self.window_s, self.enough, self.enough_exits = mu0, window_s, enough_lane_min, enough_exits
        self.anchor, self.a = mu0, prior_lane_min
        self.events: deque[tuple[float, float, float]] = deque()    # t, exits, lane-minutes
        self.exits = 0.0
        self.lane_min = 0.0

    def add(self, t: float, exits: float, dt: float, lanes: float, busy: bool) -> None:
        lane_min = lanes * dt / 60.0 if busy else 0.0
        if exits or lane_min:
            self.events.append((t, exits, lane_min))
            self.exits += exits
            self.lane_min += lane_min
        while self.events and self.events[0][0] < t - self.window_s:
            _, e, m = self.events.popleft()
            self.exits -= e
            self.lane_min -= m
        if self.lane_min >= self.enough and self.exits >= self.enough_exits:
            self.anchor, self.a = self.exits / self.lane_min, 1.0

    @property
    def mu(self) -> float:
        return max(self.mu0 / 4.0, (max(self.exits, 0.0) + self.a * self.anchor) / (max(self.lane_min, 0.0) + self.a))

    @property
    def sd(self) -> float:
        return math.sqrt(max(self.exits, 0.0) + self.a * self.anchor) / (max(self.lane_min, 0.0) + self.a)


def wait_minutes(queue: float, mu: float, lanes: float) -> float:
    if queue <= 0:
        return 0.0
    if mu <= 0 or lanes <= 0:
        return WAIT_CAP_MIN
    return min(WAIT_CAP_MIN, queue / (mu * lanes))


def wait_p90(queue: float, sd_queue: float, mu: float, sd_mu: float, lanes: float) -> float:
    """p90 of W from the filter's sd on the queue and the measurement's sd on mu (delta method, normal)."""
    if mu <= 0 or lanes <= 0:
        return WAIT_CAP_MIN
    w = wait_minutes(queue, mu, lanes)
    var = (sd_queue / (mu * lanes)) ** 2 + (max(queue, 0.0) * sd_mu / (mu ** 2 * lanes)) ** 2
    return min(WAIT_CAP_MIN, w + Z90 * math.sqrt(var))

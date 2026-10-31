"""A stand-in for Unity, for tests and for running the chain with nothing else on: discrete people in the real queue rings,
watched by the real cameras' view regions with a crude detector. Its `detector` label is "synthetic" and its numbers mean
nothing about the airport: they only show the chain's plumbing works and which way its errors go."""
from __future__ import annotations

import time

import numpy as np

from ..forecast import Curve, Flight, arrival_rates
from ..geometry import in_ring
from ..queues import QueueSpec, read_nav_queues
from ..state import SimView
from .base import SYNTHETIC, CameraSpec, FloorPoint, Tick

# Deliberately not the service's priors: a forecast that shares its world's parameters would look better than it is.
TRUE_CURVES = {"security": Curve(95.0, 0.30, 25.0), "check_in": Curve(115.0, 0.35, 40.0, share=0.40)}
TRUE_MU = {"security": 3.2, "check_in": 0.75}
HALLS = {"G_DEPARTURES": 25, "G_CENTER": 30, "U_CONCOURSE": 25, "U_GATE_2": 35, "U_GATE_6": 20}
DEMO_FLIGHTS = [
    {"flight": "W6 3751", "std": "09:40", "pax": 180, "checkIn": "check_in:1", "gate": "gate_2"},
    {"flight": "W6 3401", "std": "10:05", "pax": 186, "checkIn": "check_in:1", "gate": "gate_4"},
    {"flight": "RO 7653", "std": "10:20", "pax": 68, "checkIn": "check_in:2", "gate": "gate_5"},
    {"flight": "FR 2214", "std": "10:45", "pax": 189, "checkIn": "check_in:3", "gate": "gate_3"},
    {"flight": "W6 4307", "std": "11:30", "pax": 180, "checkIn": "check_in:1", "gate": "gate_6"},
]


class _Line:
    """A queue's path from its head, with positions by distance along it. Past its end the line continues straight."""

    def __init__(self, polyline: list, head: int):
        pts = np.asarray(polyline, dtype=float)
        self.pts = pts if head == 0 else pts[::-1]
        d = np.linalg.norm(np.diff(self.pts, axis=0), axis=1)
        self.cum = np.concatenate(([0.0], np.cumsum(d)))
        back = self.pts[-1] - self.pts[-2]
        self.tail_dir = back / max(np.linalg.norm(back), 1e-6)
        front = self.pts[0] - self.pts[1]
        self.head_dir = front / max(np.linalg.norm(front), 1e-6)

    def at(self, s: float) -> tuple[float, float]:
        if s >= self.cum[-1]:
            p = self.pts[-1] + self.tail_dir * (s - self.cum[-1])
            return float(p[0]), float(p[1])
        return float(np.interp(s, self.cum, self.pts[:, 0])), float(np.interp(s, self.cum, self.pts[:, 1]))


class SyntheticAirport:
    detector = SYNTHETIC

    def __init__(self, queues: list[QueueSpec], cameras: list[CameraSpec], terminal=None, seed: int = 1, start_s: float = 7.5 * 3600,
                 speed: float = 10.0, flights: list[dict] | None = None, lanes_fn=None, recall: float = 0.9, load: float = 1.0):
        self.rng = np.random.default_rng(seed)
        self.queues, self.cameras, self.speed, self.lanes_fn, self.recall, self.load = queues, cameras, speed, lanes_fn, recall, load
        self.t = start_s
        self.flights = [Flight.parse({"status": "scheduled", **f}) for f in (flights or DEMO_FLIGHTS)]
        nav = read_nav_queues()
        self.lines = {q.queue: _Line(nav[q.queue]["polyline"], int(nav[q.queue]["head"])) for q in queues if q.queue in nav}
        self.spacing = {q.queue: float(nav[q.queue]["spacing"]) for q in queues if q.queue in nav}
        self.waiting: dict[str, list[dict]] = {q.queue: [] for q in queues}
        self.arriving: dict[str, list[dict]] = {q.queue: [] for q in queues}
        self.leaving: dict[str, list[dict]] = {q.queue: [] for q in queues}
        self.served: dict[str, list[tuple[float, float]]] = {q.queue: [] for q in queues}
        self.next_id = 1
        self.frac = {q.queue: 0.0 for q in queues}
        self.down: set[str] = set()
        self.hall_people: list[dict] = []
        self.wall = None
        self.switches = 0
        if terminal is not None:
            from ..geometry import ZoneIndex
            index = ZoneIndex.of(terminal)
            for zone, n in HALLS.items():
                if zone in index.cells:
                    xs, zs = index.cells[zone]
                    picks = self.rng.integers(0, xs.size, n)
                    for i in picks:
                        self.hall_people.append({"id": self._new_id(), "x": float(xs[i]), "z": float(zs[i]), "level": terminal.zones[zone].level})

    def _new_id(self) -> int:
        i = self.next_id
        self.next_id += 1
        return i

    def _kind(self, q: QueueSpec) -> str | None:
        return "security" if q.queue == "security" else "check_in" if q.queue.startswith("checkin") else None

    def _lanes(self, q: QueueSpec) -> int:
        return self.lanes_fn(q) if self.lanes_fn else q.default_lanes

    def advance(self, dt: float) -> None:
        """People arrive by the schedule, queue, get served, leave."""
        self.t += dt
        for q in self.queues:
            kind = self._kind(q)
            for p in self.leaving[q.queue]:
                p["ticks"] -= 1
            self.leaving[q.queue] = [p for p in self.leaving[q.queue] if p["ticks"] > 0]
            for p in self.arriving[q.queue]:
                p["enter_t"] = self.t
                self.waiting[q.queue].append(p)
            self.arriving[q.queue] = []
            if kind is None:
                continue
            select = (lambda f: True) if kind == "security" else (lambda f, key=q.lanes_key: f.check_in == key)
            lam = float(arrival_rates(self.flights, self.t, TRUE_CURVES[kind], 0, select)[0]) * self.load
            for _ in range(self.rng.poisson(lam * dt / 60.0)):
                self.arriving[q.queue].append({"id": self._new_id()})
            rate = TRUE_MU[kind] * self._lanes(q)
            for _ in range(min(self.rng.poisson(rate * dt / 60.0), len(self.waiting[q.queue]))):
                p = self.waiting[q.queue].pop(0)
                self.served[q.queue].append((self.t, self.t - p["enter_t"]))
                p["ticks"] = 2
                self.leaving[q.queue].append(p)

    def _positions(self):
        for q in self.queues:
            line = self.lines.get(q.queue)
            if line is None:
                continue
            spacing = self.spacing[q.queue]
            for i, p in enumerate(self.waiting[q.queue]):
                x, z = line.at((i + 0.5) * spacing)
                yield p["id"], x, z, q.level
            for p in self.arriving[q.queue]:
                x, z = line.at(line.cum[-1] + 3.0 + spacing * len(self.waiting[q.queue]))
                yield p["id"], x, z, q.level
            for p in self.leaving[q.queue]:
                ahead = line.pts[0] + line.head_dir * 3.0
                yield p["id"], float(ahead[0]), float(ahead[1]), q.level
        for p in self.hall_people:
            yield p["id"], p["x"], p["z"], p["level"]

    def observe(self, t: float | None = None) -> Tick:
        people = list(self._positions())
        cameras: dict[str, list[FloorPoint]] = {}
        for cam_index, cam in enumerate(self.cameras):
            if cam.id in self.down:
                continue
            points: list[FloorPoint] = []
            mine = [p for p in people if p[3] == cam.level]
            if mine:
                inside = in_ring(np.array([p[1] for p in mine]), np.array([p[2] for p in mine]), cam.view_region)
                for (pid, x, z, level), ok in zip(mine, inside):
                    if ok and self.rng.random() < self.recall:
                        points.append(FloorPoint(x + float(self.rng.normal(0, 0.15)), z + float(self.rng.normal(0, 0.15)), level,
                                                 pid * 41 + cam_index, float(self.rng.uniform(0.4, 0.95)), 80.0, cam.id))
            cameras[cam.id] = points
        return Tick(self.t, SYNTHETIC, cameras, self.speed, True)

    def step(self, dt: float) -> Tick:
        self.advance(dt)
        return self.observe()

    # CameraSource: the service's clock drives it at `speed`.
    def camera_specs(self) -> list[CameraSpec]:
        return self.cameras

    def read(self, sim: SimView) -> Tick | None:
        now = time.monotonic()
        if self.wall is None:
            self.wall = now
            return self.observe()
        if now - self.wall < 1.0:
            return None
        dt = (now - self.wall) * self.speed
        self.wall = now
        if sim.flights:
            self.flights = sim.flights
        return self.step(dt)

    def close(self) -> None:
        pass

    # Only tests and the local evaluation read these. The chain never does.
    def true_queue(self, queue: str) -> int:
        return len(self.waiting[queue])

    def true_wait_min(self, queue: str, window_s: float = 300.0) -> float | None:
        recent = [w for t, w in self.served[queue] if t > self.t - window_s]
        return float(np.mean(recent)) / 60.0 if recent else None

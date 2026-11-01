"""The chain, without I/O: floor points per camera -> count and flows per zone (A3) -> the wait now (A4) -> forecast (A5) ->
advice (A7). `ingest` runs on every camera tick, `report` builds the contract rows once a second. Times in sim seconds."""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

import numpy as np

from .advice import advise
from .forecast import CURVES, ArrivalScale, Flight, arrival_rates, forecast_points, wait_curve
from .contract import flow_row
from .geometry import ZoneIndex, in_ring, ring_samples
from .kalman import CountFilter, count_variance
from .mapids import is_whole_terminal, map_node_id
from .queues import QueueSpec
from .sources.base import CameraSpec, FloorPoint, Tick
from .state import LaneBook
from .terminal import Terminal
from .unseen import estimate_unseen
from .wait import HeadRate, wait_minutes, wait_p90

COVERAGE_MIN = 0.10       # a zone seen less than this is treated as not seen
BLIND_MAX_S = 600.0       # after a camera drops: keep reporting from flows at most this long...
SD_UNKNOWN = 12.0         # ...and while the filter's sd stays under this, then the zone is unknown
MERGE_RADIUS_M = 0.7      # two cameras' points this close are one person
SAMPLES_MAX = 1500
TREND_SAMPLE_S, TREND_WINDOW_S = 30.0, 300.0
KIND_CODE = {"security": 0, "check_in": 1, "passport": 2}
# Rows whose wait is the queue's in front of them. Without a wait the dashboard shows them as unknown (D20).
SERVICE_WAIT_FROM = {"U_SECURITY": "U_SECURITY_QUEUE", "G_CHECKIN_DESKS": "G_CHECKIN_QUEUE"}


def merge_cameras(points: list[FloorPoint], radius: float = MERGE_RADIUS_M) -> list[FloorPoint]:
    """One point per person across overlapping cameras, surest first. Points of the same camera are never merged."""
    kept: list[FloorPoint] = []
    grid: dict[tuple, list[FloorPoint]] = {}
    for p in sorted(points, key=lambda p: -p.conf):
        cx, cz = int(math.floor(p.x / radius)), int(math.floor(p.z / radius))
        dup = False
        for ix in range(cx - 1, cx + 2):
            for iz in range(cz - 1, cz + 2):
                for q in grid.get((p.level, ix, iz), ()):
                    if q.camera != p.camera and (q.x - p.x) ** 2 + (q.z - p.z) ** 2 <= radius * radius:
                        dup = True
                        break
                if dup:
                    break
            if dup:
                break
        if not dup:
            kept.append(p)
            grid.setdefault((p.level, cx, cz), []).append(p)
    return kept


class TrackLedger:
    """One camera, one queue: tracks that cross into its ring and tracks seen leaving at its head. A track that merely vanishes is
    an occlusion or an id switch, not somebody served: in a dense queue that is most of them, and on Unity's first run counting
    them read 5 times too many exits. Leaving needs two ticks outside and a metre from where it was, because feet jitter across
    the ring's edge at the queue's head too. Live at x10 a tick is 5 sim-s apart, and two ticks later the person is past the
    camera: there one tick outside is enough (sparse_dt_s), or mu reads several times too low and the wait twice too high."""

    def __init__(self, spec: QueueSpec, head_radius_m: float = 4.0, min_ticks: int = 2, lost_after_s: float = 60.0, leave_m: float = 1.0,
                 sparse_dt_s: float = 2.0):
        self.ring, self.head, self.radius, self.min_ticks, self.lost_after, self.leave_m = spec.ring, spec.head, head_radius_m, min_ticks, lost_after_s, leave_m
        self.sparse_dt = sparse_dt_s
        self.tracks: dict[int, dict] = {}
        self.exits_total = 0

    def reset(self) -> None:
        self.tracks.clear()

    def _at_head(self, s: dict) -> bool:
        return math.hypot(s["x"] - self.head[0], s["z"] - self.head[1]) <= self.radius

    def step(self, t: float, points: list[FloorPoint], dt: float) -> tuple[int, int]:
        entries = exits = 0
        out_ticks = 1 if dt >= self.sparse_dt else 2
        if points:
            inside = in_ring(np.array([p.x for p in points]), np.array([p.z for p in points]), self.ring)
        else:
            inside = []
        seen = set()
        for p, is_in in zip(points, inside):
            seen.add(p.track)
            s = self.tracks.get(p.track)
            if s is None:
                s = self.tracks[p.track] = {"in": False, "x": p.x, "z": p.z, "t": t, "n": 0, "from_out": not is_in, "counted": False, "out": 0}
            if is_in:
                s.update(x=p.x, z=p.z, n=s["n"] + 1, out=0, **{"in": True})
                if s["from_out"] and not s["counted"] and s["n"] >= self.min_ticks:
                    entries += 1
                    s["counted"] = True
            elif s["in"]:
                s["out"] += 1
                if s["out"] >= out_ticks and math.hypot(p.x - s["x"], p.z - s["z"]) >= self.leave_m:
                    if s["n"] >= self.min_ticks and self._at_head(s):
                        exits += 1
                    s.update({"in": False, "n": 0, "from_out": True, "counted": False, "out": 0})
            s["t"] = t
        for track in [k for k, s in self.tracks.items() if k not in seen and t - s["t"] > max(self.lost_after, 2.5 * dt)]:
            self.tracks.pop(track)
        self.exits_total += exits
        return entries, exits


class PeopleSmoother:
    """crowd.positions for the map: a stable id per tracked person and a smoothed position, so dots glide instead of jumping.

    Per camera track (`camera:track`), an exponential moving average of the floor point. A track must be seen on `min_seen`
    ticks before it is drawn (drops one-tick ghosts), and a track missed for up to `hold` ticks keeps its last place, so a
    missed detection does not blink. A new track next to one that just vanished takes over its id (the merge between
    cameras can swap which camera's track stands for a person). Without valid track ids the points pass through unchanged.
    """
    JUMP_M = 3.0
    ADOPT_M = 1.5

    def __init__(self, alpha: float = 0.5, min_seen: int = 2, hold: int = 2, inside=None):
        self.alpha, self.min_seen, self.hold = alpha, min_seen, hold
        # inside(level, x, z) -> bool: the walkable zones. A smoothed point that falls off them (between two rooms) goes back
        # to the measured one, which is on the floor, so the map never shows a dot inside a wall.
        self.inside = inside
        self.tracks: dict[str, dict] = {}

    def reset(self) -> None:
        self.tracks.clear()

    def update(self, people: list[FloorPoint], tracks_valid: bool) -> list[dict]:
        if not tracks_valid:
            self.tracks.clear()
            return [{"x": round(p.x, 2), "z": round(p.z, 2), "level": p.level} for p in people]
        seen: set[str] = set()
        for p in people:
            key = f"{p.camera}:{p.track}"
            if key in seen:
                continue
            seen.add(key)
            s = self.tracks.get(key)
            if s is None:
                lost = [(math.hypot(o["x"] - p.x, o["z"] - p.z), k) for k, o in self.tracks.items()
                        if o["miss"] > 0 and o["level"] == p.level and k not in seen]
                near = min(lost, default=None)
                if near is not None and near[0] <= self.ADOPT_M:
                    s = self.tracks.pop(near[1])
                    s["miss"] = 0
                else:
                    s = {"x": p.x, "z": p.z, "level": p.level, "n": 0, "miss": 0, "id": key}
                self.tracks[key] = s
            elif s["level"] != p.level or math.hypot(p.x - s["x"], p.z - s["z"]) > self.JUMP_M:
                s.update(x=p.x, z=p.z, level=p.level)
            else:
                s["x"] += self.alpha * (p.x - s["x"])
                s["z"] += self.alpha * (p.z - s["z"])
                if self.inside is not None and not self.inside(p.level, s["x"], s["z"]):
                    s.update(x=p.x, z=p.z)
            s["n"] += 1
            s["miss"] = 0
        for key in list(self.tracks):
            if key not in seen:
                self.tracks[key]["miss"] += 1
                if self.tracks[key]["miss"] > self.hold:
                    del self.tracks[key]
        return [{"x": round(s["x"], 2), "z": round(s["z"], 2), "level": s["level"], "id": s["id"]}
                for s in self.tracks.values() if s["n"] >= self.min_seen]


@dataclass
class ZoneTrack:
    filter: CountFilter
    seen_t: float | None = None
    coverage: float = 0.0


@dataclass
class QueueTrack:
    spec: QueueSpec
    filter: CountFilter
    head: HeadRate
    scale: ArrivalScale
    ledgers: dict[str, TrackLedger] = field(default_factory=dict)
    seen_t: float | None = None
    coverage: float = 0.0
    last_n: float | None = None
    features: dict = field(default_factory=dict)
    history: deque = field(default_factory=deque)
    shown: tuple | None = None        # (t, lanes, wait, forecast values): what was reported, for Smoothing


class Smoothing:
    """What the panel shows, eased over sim time: the wait over WAIT_TAU_S, the forecast over FORECAST_TAU_S. The physics and its ML
    move by a few minutes from one report to the next (mu over 5 min, the trend, the arrival scale), and the forecast's fluid queue
    turns that into +60 jumping between 7 and 17 min every 10 sim-s on the live screen. A lane change resets it: a new lane shows at once."""
    WAIT_TAU_S = 60.0
    FORECAST_TAU_S = 60.0         # 180 s cost the held-out forecast a minute of lag

    @staticmethod
    def apply(track: "QueueTrack", t: float, lanes: int, wait: float, forecast: list[dict] | None) -> tuple[float, list[dict] | None]:
        values = [p["waitMin"] for p in forecast] if forecast else None
        last = track.shown
        if last is None or last[1] != lanes or t < last[0] or (values is None) != (last[3] is None) or (values and len(values) != len(last[3])):
            track.shown = (t, lanes, wait, values)
            return wait, forecast
        dt = t - last[0]
        if dt <= 0:
            wait, values = last[2], last[3]
        else:
            aw, af = 1.0 - math.exp(-dt / Smoothing.WAIT_TAU_S), 1.0 - math.exp(-dt / Smoothing.FORECAST_TAU_S)
            wait = last[2] + aw * (wait - last[2])
            values = [old + af * (new - old) for old, new in zip(last[3], values)] if values else None
            track.shown = (t, lanes, wait, values)
        return wait, ([{"inMin": p["inMin"], "waitMin": round(v, 2)} for p, v in zip(forecast, values)] if forecast else None)


@dataclass
class Report:
    t_s: float
    rows: list[dict]
    people: list[dict]


class Chain:
    def __init__(self, terminal: Terminal, cameras: list[CameraSpec], queues: list[QueueSpec], book: LaneBook, corrections=None):
        self.terminal, self.cameras, self.book, self.corrections = terminal, {c.id: c for c in cameras}, book, corrections
        self.queues = list(queues)
        self.index = ZoneIndex.of(terminal)
        self.zone_samples: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        for zone_id, (xs, zs) in self.index.cells.items():
            stride = max(1, xs.size // SAMPLES_MAX)
            self.zone_samples[zone_id] = (xs[::stride], zs[::stride])
        self.queue_samples = {q.queue: ring_samples(q.ring) for q in self.queues}
        # What each camera can see of each target; fixed geometry, computed once.
        self.masks: dict[str, dict[str, np.ndarray]] = {c.id: {} for c in cameras}
        for c in cameras:
            for zone_id, (xs, zs) in self.zone_samples.items():
                if terminal.zones[zone_id].level == c.level:
                    mask = c.sees(xs, zs)
                    if mask.any():
                        self.masks[c.id][zone_id] = mask
            for q in self.queues:
                if q.level == c.level:
                    xs, zs = self.queue_samples[q.queue]
                    mask = c.sees(xs, zs)
                    if mask.any():
                        self.masks[c.id]["q:" + q.queue] = mask
        self.sees_head = {c.id: {q.queue: q.level == c.level and bool(c.sees(np.array([q.head[0]]), np.array([q.head[1]]))[0])
                                 for q in self.queues} for c in cameras}
        self.coverage_cache: dict[frozenset, dict[str, float]] = {}
        self.reset()

    def reset(self) -> None:
        self.zones = {z: ZoneTrack(CountFilter(flows=False, q_n=0.25)) for z in self.terminal.zones}
        self.tracks = {q.queue: QueueTrack(q, CountFilter(flows=True), HeadRate(q.mu0), ArrivalScale()) for q in self.queues}
        self.last_t: float | None = None
        self.people: list[FloorPoint] = []
        # Display only: steadier dots (a bit more smoothing, a track seen three times before it is drawn), kept on the floor.
        self.smoother = PeopleSmoother(alpha=0.35, min_seen=3, inside=lambda level, x, z: int(self.index.lookup(level, np.array([x]), np.array([z]))[0]) >= 0)
        self.shown_people: list[dict] = []
        self.detector = ""
        self.active: frozenset[str] = frozenset()

    # ------------------------------------------------------------------ coverage
    def coverage(self, active: frozenset) -> dict[str, float]:
        cached = self.coverage_cache.get(active)
        if cached is not None:
            return cached
        out: dict[str, float] = {}
        sizes = {z: s[0].size for z, s in self.zone_samples.items()} | {"q:" + q: s[0].size for q, s in self.queue_samples.items()}
        union: dict[str, np.ndarray] = {}
        for camera in active:
            for target, mask in self.masks.get(camera, {}).items():
                union[target] = union[target] | mask if target in union else mask.copy()
        for target, mask in union.items():
            out[target] = float(mask.sum()) / max(sizes.get(target, 1), 1)
        self.coverage_cache[active] = out
        return out

    # ------------------------------------------------------------------ one camera tick
    def ingest(self, tick: Tick, flights: list[Flight]) -> None:
        t = tick.t_s
        if self.last_t is not None and t < self.last_t - 1.0:
            self.reset()         # the sim clock restarted
        dt = 0.0 if self.last_t is None else t - self.last_t
        if self.last_t is not None and dt <= 0:
            return
        self.last_t, self.detector = t, tick.detector
        self.active = frozenset(c for c in tick.cameras if c in self.cameras)
        cover = self.coverage(self.active)
        merged = merge_cameras([p for points in tick.cameras.values() for p in points])

        on_floor: list[FloorPoint] = []
        counts: dict[str, int] = {}
        for level in {p.level for p in merged}:
            pts = [p for p in merged if p.level == level]
            idx = self.index.lookup(level, np.array([p.x for p in pts]), np.array([p.z for p in pts]))
            for p, i in zip(pts, idx):
                if i >= 0:
                    on_floor.append(p)
                    zone_id = self.index.ids[i]
                    counts[zone_id] = counts.get(zone_id, 0) + 1
        self.people = on_floor
        self.shown_people = self.smoother.update(on_floor, tick.tracks_valid)

        for zone_id, track in self.zones.items():
            track.filter.predict(dt)
            cov = cover.get(zone_id, 0.0)
            track.coverage = cov
            if cov >= COVERAGE_MIN:
                n = counts.get(zone_id, 0)
                track.filter.update_count(n / cov, count_variance(n, cov))
                track.seen_t = t

        for track in self.tracks.values():
            self._ingest_queue(track, tick, merged, cover, flights, t, dt)

    def _lanes(self, spec: QueueSpec) -> int:
        return self.book.lanes(spec.lanes_key, spec.default_lanes) if spec.lanes_key else spec.default_lanes

    def _select(self, spec: QueueSpec):
        if spec.queue.startswith("checkin_group_"):
            return lambda f: f.check_in == spec.lanes_key
        if spec.queue == "passport_departures":
            return lambda f: str(f.gate) in ("gate_1", "gate_2", "gate_3")   # the non-Schengen gates
        return lambda f: True

    def _ingest_queue(self, track: QueueTrack, tick: Tick, merged, cover, flights, t, dt) -> None:
        spec = track.spec
        cov = cover.get("q:" + spec.queue, 0.0)
        track.coverage = cov
        lanes = self._lanes(spec)
        points = [p for p in merged if p.level == spec.level]
        count, mean_h, mean_conf = 0, 0.0, 0.0
        if points:
            inside = in_ring(np.array([p.x for p in points]), np.array([p.z for p in points]), spec.ring)
            count = int(inside.sum())
            if count:
                mean_h = float(np.mean([p.box_h for p, ok in zip(points, inside) if ok]))
                mean_conf = float(np.mean([p.conf for p, ok in zip(points, inside) if ok]))

        # Flows, from one camera or one person counts twice: of the working cameras that see the queue's head, the one that has
        # seen the most people leave, since a camera misses exits but rarely invents them. No such camera, or tracks that
        # jumped: no flows this tick, and mu keeps its last measurement.
        watching = [c for c in self.active if "q:" + spec.queue in self.masks.get(c, {})]
        candidates = [c for c in watching if c not in tick.invalid_tracks and self.sees_head[c].get(spec.queue)]
        entries = exits = 0
        flows_seen = bool(candidates) and tick.tracks_valid and cov >= COVERAGE_MIN
        for name, ledger in track.ledgers.items():
            if not tick.tracks_valid or name in tick.invalid_tracks:
                ledger.reset()
        if flows_seen:
            steps = {c: track.ledgers.setdefault(c, TrackLedger(spec)).step(t, tick.cameras.get(c, []), dt) for c in candidates}
            entries, exits = steps[max(candidates, key=lambda c: track.ledgers[c].exits_total)]

        # A lane counts as working only when someone is there for it: with 1 person and 3 lanes, two stand idle.
        busy = track.filter.n >= 1.0
        if dt > 0 and flows_seen:
            track.head.add(t, exits, dt, min(lanes, max(track.filter.n, 1.0)), busy)
        mu = track.head.mu
        if flows_seen:
            track.filter.predict(dt, left=exits, left_var=0.25 * exits)
        else:
            track.filter.predict(dt, left=mu * lanes * dt / 60.0 if busy else 0.0)
        per_camera = [int(in_ring(np.array([p.x for p in tick.cameras[c]]), np.array([p.z for p in tick.cameras[c]]), spec.ring).sum()) if tick.cameras.get(c) else 0 for c in watching]
        count_features = {"kind": KIND_CODE.get(spec.curve, 3), "count": count, "coverage": cov, "density_seen": count / max(spec.area_m2 * cov, 1.0),
                          "mean_box_h": mean_h, "mean_conf": mean_conf, "n_cameras": len(watching), "boxes_sum": sum(per_camera), "boxes_max": max(per_camera, default=0)}
        if cov >= COVERAGE_MIN:
            corrected = self.corrections.count(count_features) if self.corrections else None
            if corrected is None:
                track.filter.update_count(count / cov, count_variance(count, cov))
            else:
                track.filter.update_count(corrected[0], corrected[1])
            track.seen_t = t
        if flows_seen and dt > 0:
            track.filter.update_in_rate(entries / cov / dt, max(entries, 1) / (cov * dt) ** 2)

        if dt > 0:
            n = track.filter.n
            grew = 0.0 if track.last_n is None else n - track.last_n
            curve = CURVES.get(spec.curve)
            expected = float(arrival_rates(flights, t, curve, 0, self._select(spec))[0]) * dt / 60.0 if curve and flights else 0.0
            track.scale.add(expected, grew + (exits if flows_seen else (mu * lanes * dt / 60.0 if busy else 0.0)))
            track.last_n = n
            if not track.history or t - track.history[-1][0] >= TREND_SAMPLE_S:
                track.history.append((t, n))
                while t - track.history[0][0] > TREND_WINDOW_S:
                    track.history.popleft()
        track.features = count_features

    # ------------------------------------------------------------------ the reported rows
    def longest_group(self) -> str | None:
        groups = [t for t in self.tracks.values() if t.spec.queue.startswith("checkin_group_")]
        return max(groups, key=lambda t: t.filter.n).spec.lanes_key if groups else None

    def _alive(self, seen_t, sd, cov, t) -> bool:
        if seen_t is None:
            return False
        return cov >= COVERAGE_MIN or (t - seen_t <= BLIND_MAX_S and sd <= SD_UNKNOWN)

    def _queue_numbers(self, track: QueueTrack, flights: list[Flight], t: float) -> dict:
        spec = track.spec
        lanes = self._lanes(spec)
        queue, sd = track.filter.n, track.filter.sd
        mu, sd_mu = track.head.mu, track.head.sd
        raw_wait = wait_minutes(queue, mu, lanes)
        p90 = wait_p90(queue, sd, mu, sd_mu, lanes)
        curve_spec = CURVES.get(spec.curve)
        select = self._select(spec)
        lam = arrival_rates(flights, t, curve_spec, 120, select) * track.scale.factor if curve_spec else np.zeros(121)
        curve = wait_curve(queue, lam, mu, lanes)
        old_t, old_n = track.history[0] if track.history else (t, queue)
        features = {"kind": KIND_CODE.get(spec.curve, 3), "wait": raw_wait, "queue": queue, "sd": sd, "mu": mu, "lanes": lanes, "lam_now": float(lam[0]),
                    "lam_filter": track.filter.lam * 60.0, "trend": (queue - old_n) / max(t - old_t, 60.0) * 60.0, "scale": track.scale.factor,
                    "departures_next_hour": float(sum(f.pax for f in flights if select(f) and f.status not in ("cancelled", "departed") and t < f.etd_s <= t + 3600.0))}
        wait, correction = raw_wait, None
        if self.corrections:
            wait = self.corrections.wait(features)
            correction = self.corrections.forecast(features, lam)
        # No schedule or no arrival model: no forecast, rather than a queue that only drains. The backend then uses its history (D5b).
        knows_arrivals = curve_spec is not None and bool(flights)
        adv = advise(queue, lam, mu, lanes, spec.target_min, spec.max_lanes, t) if knows_arrivals and spec.target_min and spec.lanes_key else None
        p90 = max(p90 + wait - raw_wait, wait) - wait
        wait, forecast = Smoothing.apply(track, t, lanes, wait, forecast_points(curve, correction) if knows_arrivals else None)
        return dict(queue=queue, sd=sd, mu=mu, lanes=lanes, wait=wait, p90=wait + p90, forecast=forecast,
                    advice=adv, lam=lam, raw_wait=raw_wait, raw_curve=curve, features=features)

    def report(self, flights: list[Flight]) -> Report | None:
        if self.last_t is None:
            return None
        t = self.last_t
        rows: dict[str, dict] = {}
        waits: dict[str, dict] = {}
        for track in self.tracks.values():
            spec = track.spec
            if not self._alive(track.seen_t, track.filter.sd, track.coverage, t):
                continue
            q = self._queue_numbers(track, flights, t)
            waits[spec.zone] = q
            physical = self.terminal.zones.get(spec.zone)
            if physical is not None and spec.area_m2 / physical.area_m2 < 0.5:
                continue         # a queue inside a larger hall (passport): the hall's row below carries its wait
            rows[spec.zone] = flow_row(spec.zone, q["queue"], q["sd"], q["queue"] / spec.area_m2, q["wait"], q["p90"], track.coverage, q["forecast"], q["advice"])
        for zone_id, track in self.zones.items():
            if zone_id in rows or not self._alive(track.seen_t, track.filter.sd, track.coverage, t):
                continue
            n = track.filter.n
            wait = waits.get(zone_id)
            rows[zone_id] = flow_row(zone_id, n, track.filter.sd, n / self.terminal.zones[zone_id].area_m2, wait["wait"] if wait else None,
                                     wait["p90"] if wait else None, track.coverage, wait["forecast"] if wait else None, wait["advice"] if wait else None)
        self._check_in_hall(rows, waits)
        for service, queue in SERVICE_WAIT_FROM.items():
            if service in rows and queue in rows and "waitMin" in rows[queue]:
                for key in ("waitMin", "waitMinP90", "forecast"):
                    if key in rows[queue]:
                        rows[service][key] = rows[queue][key]
        people = list(self.shown_people)
        return Report(t, list(rows.values()), people)

    def _check_in_hall(self, rows: dict, waits: dict) -> None:
        """G_CHECKIN_QUEUE holds all the groups: it shows the worst one. D8: passengers see their own group's row."""
        hall = rows.get("G_CHECKIN_QUEUE")
        groups = [z for z in waits if z.startswith("check_in:")]
        if hall is None or not groups:
            return
        hall["waitMin"] = round(max(waits[z]["wait"] for z in groups), 2)
        hall["waitMinP90"] = round(max(waits[z]["p90"] for z in groups), 2)
        forecasts = [waits[z]["forecast"] for z in groups if waits[z]["forecast"]]
        if forecasts:
            hall["forecast"] = [{"inMin": points[0]["inMin"], "waitMin": max(p["waitMin"] for p in points)} for points in zip(*forecasts)]
        advices = [waits[z]["advice"] for z in groups if waits[z]["advice"]]
        if advices:
            hall["advice"] = max(advices, key=lambda a: a["waitMinIfNot"])

    # ------------------------------------------------------------------ for the evacuation
    def zone_people(self) -> tuple[dict[str, float], dict[str, float], list[str]]:
        """People and density per physical zone the cameras can vouch for, and the indoor zones they cannot (not invented)."""
        people, density, unseen = {}, {}, []
        t = self.last_t or 0.0
        for zone_id, track in self.zones.items():
            zone = self.terminal.zones[zone_id]
            if self._alive(track.seen_t, track.filter.sd, track.coverage, t):
                people[zone_id] = track.filter.n
                density[zone_id] = track.filter.n / zone.area_m2
            elif zone.level in ("G", "U"):
                unseen.append(zone_id)
        # A queue's own filter has the count correction (A2), which the plain zone count has not: dense queues read about half.
        checkin = 0.0
        for track in self.tracks.values():
            if not self._alive(track.seen_t, track.filter.sd, track.coverage, t):
                continue
            n = track.filter.n
            if track.spec.zone in self.terminal.zones:
                area = self.terminal.zones[track.spec.zone].area_m2
                if n > people.get(track.spec.zone, 0.0):
                    people[track.spec.zone], density[track.spec.zone] = n, n / area
            elif track.spec.zone.startswith("check_in:"):
                checkin += n
        hall = self.terminal.zones.get("G_CHECKIN_QUEUE")
        if hall is not None and checkin > people.get(hall.id, 0.0):
            people[hall.id], density[hall.id] = checkin, checkin / hall.area_m2
        return people, density, unseen

    def evacuation_sources(self, flights: list[Flight], blocked: list[str] | None = None) -> tuple[dict[str, float], dict[str, float], dict[str, float]]:
        """For A9 only: who has to leave, seen; density where seen; and a low-confidence estimate for those no camera sees.
        Blocking zones evacuates the people in them, as Unity does; a whole-terminal id, or none given, evacuates everybody.
        Density is for all that is seen: the others are still there, and slow the walk out."""
        people, density, unseen = self.zone_people()
        security = self.tracks.get("security")
        before = (security.filter.n if security else 0.0) + people.get("U_SECURITY", 0.0)
        estimated = estimate_unseen(self.terminal, people, unseen, flights, self.last_t or 0.0, CURVES["security"], security.scale.factor if security else 1.0, before)
        if not blocked or is_whole_terminal(blocked):
            return people, density, estimated
        seen_there, guessed_there = {}, {}
        groups = {t.spec.zone: t.filter.n for t in self.tracks.values() if t.spec.zone.startswith("check_in:") and self._alive(t.seen_t, t.filter.sd, t.coverage, self.last_t or 0.0)}
        for zone in {map_node_id(b) for b in blocked}:
            if zone in groups:
                seen_there[zone] = groups[zone]
            elif zone in people:
                seen_there[zone] = people[zone]
            elif zone in estimated:
                guessed_there[zone] = estimated[zone]
        if "G_CHECKIN_QUEUE" in seen_there:
            seen_there = {z: n for z, n in seen_there.items() if z not in groups}      # the hall already holds its groups
        return seen_there, density, guessed_there

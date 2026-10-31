"""A11's dataset: replay a simulated day's camera log through the chain and pair what the chain would have said with Unity's
truth. Truth is read here and only here: this is offline training code, the live service never imports it (D0).

A run folder, data/interim/clarion_runs/<seed>_<arm>/:
    run.json       seed, arm, speed, sim_start, sim_end
    detlog.jsonl   the camera log, same schema as detections.json (CctvLive.cs, -cctv-det-log)
    truth.jsonl    {t_s, zones: [{zone, waiting, waitMin}], lanes: {zone: n}, queue_exits: {queue: n}}, one line per 5 sim s
    stages.csv     each person's stages: the wait of those who joined a queue at a given moment
    flights.jsonl  {t_s, flights: [...]} at every flight.update
    ops.jsonl      {t_s, type, zone, delta, ...} at every lane or evacuation change
    metrics.json   evacT90, evacLastOut when the run had an evacuation"""
from __future__ import annotations

import bisect
import csv
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from ..chain import Chain
from ..evac import plan_evacuation
from ..forecast import HORIZONS_MIN, Flight
from ..mapids import lanes_key
from ..queues import load_queues
from ..sources.base import Tick, load_camera_specs
from ..sources.live_files import load_calibs, tick_from_json
from ..state import LaneBook
from ..terminal import Terminal


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


@dataclass
class Timeline:
    """Schedule and admin decisions in time order. What the live service would know, when it would know it."""
    flights: list[tuple[float, list[Flight]]] = field(default_factory=list)
    ops: list[dict] = field(default_factory=list)
    next_flights: int = 0
    next_op: int = 0
    current: list[Flight] = field(default_factory=list)
    evacuation_t: float | None = None
    evacuation_zones: list[str] = field(default_factory=list)
    evacuation_plan: dict | None = None

    def advance(self, t: float, book: LaneBook, chain: Chain) -> list[Flight]:
        while self.next_flights < len(self.flights) and self.flights[self.next_flights][0] <= t:
            self.current = self.flights[self.next_flights][1]
            self.next_flights += 1
        while self.next_op < len(self.ops) and self.ops[self.next_op]["t_s"] <= t:
            op = self.ops[self.next_op]
            if op.get("type") == "staff":
                book.apply(f"op{self.next_op}", op.get("zone") or "", int(op.get("delta") or 0), chain.longest_group)
            elif op.get("type") == "lanes":        # Unity's log gives the new total
                key = lanes_key(op.get("zone") or "")
                if key and key != "check_in:?":
                    book.apply(f"op{self.next_op}", key, int(op.get("open") or 0) - book.lanes(key))
            elif op.get("type") == "evacuate" and self.evacuation_t is None:
                self.evacuation_t = float(op["t_s"])
                self.evacuation_zones = list(op.get("zones") or [])
            self.next_op += 1
        return self.current


def start_lanes(truth: list[dict], terminal: Terminal) -> dict[str, int]:
    """The day's plan: runs vary their opening lanes (config.lanes), which terminal.json cannot know. Live, the plan is the
    terminal's and the admin changes it; here the first truth line says what the plan was, and ops.jsonl every change after."""
    lanes = dict(terminal.initial_lanes)
    first = next((line.get("lanes") for line in sorted(truth, key=lambda line: line["t_s"]) if line.get("lanes")), None) or {}
    for zone, n in first.items():
        key = lanes_key(zone)
        if key and key != "check_in:?":
            lanes[key] = int(n)
    return lanes


class JoinWaits:
    """The label for "how long is the wait now": what the people who joined around that moment really waited, from stages.csv.
    truth.report's waitMin is the mean of those finishing now, who joined one wait ago, so it lags: on the first run, with the
    queue nearly empty it still said 11 min while newcomers waited 2. Those still queued when the run ended have no record."""

    def __init__(self, path: Path):
        rows: dict[str, list[tuple[float, float]]] = {}
        with open(path, encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                if row["stage"].endswith("Queue"):
                    rows.setdefault(row["where"], []).append((float(row["begin_s"]), float(row["duration_s"]) / 60.0))
        self.rows = {q: sorted(v) for q, v in rows.items()}
        self.starts = {q: [r[0] for r in v] for q, v in self.rows.items()}

    @staticmethod
    def of(run_dir: Path) -> "JoinWaits | None":
        path = Path(run_dir) / "stages.csv"
        return JoinWaits(path) if path.exists() else None

    def at(self, queue: str, t: float, people_waiting: float | None, window_s: float = 60.0) -> float | None:
        starts = self.starts.get(queue, [])
        a, b = bisect.bisect_left(starts, t - window_s), bisect.bisect_right(starts, t + window_s)
        if b > a:
            return sum(r[1] for r in self.rows[queue][a:b]) / (b - a)
        return 0.0 if people_waiting == 0 else None     # nobody joined: known to be 0 only if nobody is waiting


def replay(ticks: Iterable[Tick], truth: list[dict], timeline: Timeline, terminal: Terminal, cameras, queues, seed: int, corrections=None, join_waits: JoinWaits | None = None) -> list[dict]:
    """One row per queue per truth line, up to the first evacuation: the raw features, the physics' numbers, and the labels."""
    book = LaneBook(start_lanes(truth, terminal))
    chain = Chain(terminal, cameras, queues, book, corrections=corrections)
    by_zone: dict[str, list[tuple[float, float, float | None]]] = {}
    for line in truth:
        for row in line.get("zones") or []:
            by_zone.setdefault(row["zone"], []).append((float(line["t_s"]), float(row["waiting"]), row.get("waitMin")))
    truth_lines = sorted(truth, key=lambda line: line["t_s"])
    rows: list[dict] = []
    i = 0
    flights: list[Flight] = []
    for tick in ticks:
        alarm_before = timeline.evacuation_t
        flights = timeline.advance(tick.t_s, book, chain)
        if alarm_before is None and timeline.evacuation_t is not None:
            # A9 as it would have answered at the alarm, from what the cameras estimated until then.
            people, density, estimated = chain.evacuation_sources(flights, timeline.evacuation_zones)
            plan = plan_evacuation(terminal, people, timeline.evacuation_zones, density, estimated=estimated)
            timeline.evacuation_plan = {"flow_clear_s": plan.clear_s, "flow_t90_s": plan.t90_s, "flow_people": plan.people, "flow_people_estimated": plan.people_estimated, "estimated_zones": len(estimated)}
        chain.ingest(tick, flights)
        while i < len(truth_lines) and truth_lines[i]["t_s"] <= tick.t_s:
            line = truth_lines[i]
            i += 1
            if timeline.evacuation_t is not None and line["t_s"] >= timeline.evacuation_t:
                continue
            zones = {z["zone"]: z for z in line.get("zones") or []}
            for track in chain.tracks.values():
                label = zones.get(track.spec.zone)
                if label is None or track.seen_t is None or track.coverage < 0.1:
                    continue
                q = chain._queue_numbers(track, flights, tick.t_s)
                finishers = label.get("waitMin")
                true_wait = join_waits.at(track.spec.queue, float(line["t_s"]), float(label["waiting"])) if join_waits else finishers
                rows.append({"seed": seed, "t": float(line["t_s"]), "zone": track.spec.zone, "queue": track.spec.queue, "capacity": track.spec.capacity,
                             "true_n": float(label["waiting"]), "true_wait": true_wait, "finishers_wait": finishers, "n": q["queue"],
                             "raw_count": track.features["count"] / max(track.features["coverage"], 1e-3),
                             "shown_wait": q["wait"], "count_features": dict(track.features), "wait_features": dict(q["features"]),
                             "forecast_raw": {h: float(q["raw_curve"][h]) for h in HORIZONS_MIN}, "forecast_shown": {f["inMin"]: f["waitMin"] for f in q["forecast"] or []},
                             "lam_at": {h: float(q["lam"][h]) for h in HORIZONS_MIN}})
    _future_labels(rows, by_zone, timeline.evacuation_t, join_waits)
    return rows


def _future_labels(rows: list[dict], by_zone: dict, evacuation_t: float | None, join_waits: JoinWaits | None = None) -> None:
    """true_future[h] = the real wait h minutes later, from the same run, when the run reached that far (and not past an alarm)."""
    for row in rows:
        series = by_zone.get(row["zone"], [])
        row["true_future"] = {}
        if not series:
            continue
        times = [s[0] for s in series]
        for h in HORIZONS_MIN:
            target = row["t"] + h * 60.0
            if evacuation_t is not None and target >= evacuation_t:
                continue
            j = _nearest(times, target)
            if j is None or abs(times[j] - target) > 30.0:
                continue
            value = join_waits.at(row["queue"], target, series[j][1]) if join_waits else series[j][2]
            if value is not None:
                row["true_future"][h] = float(value)


def _nearest(times: list[float], t: float) -> int | None:
    if not times:
        return None
    j = bisect.bisect_left(times, t)
    if j == 0:
        return 0
    if j == len(times):
        return len(times) - 1
    return j if times[j] - t < t - times[j - 1] else j - 1


def read_run(run_dir: Path, terminal: Terminal, corrections=None) -> tuple[list[dict], dict | None]:
    """A run folder's rows and its evacuation record. Cameras and calibration come from the run's own copy when it has one, else the
    live channel's."""
    run_dir = Path(run_dir)
    info = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    cctv_path = run_dir / "cctv.json"
    cctv = json.loads(cctv_path.read_text(encoding="utf-8")) if cctv_path.exists() else None
    cameras = load_camera_specs(cctv)
    queues = load_queues(cctv, lane_limits=terminal.lane_limits)
    calib_root = run_dir if (run_dir / cameras[0].id / "calib.json").exists() else Path(info.get("calib_root") or _live_dir())
    calibs = load_calibs(calib_root, [c.id for c in cameras])
    timeline = Timeline()
    for line in read_jsonl(run_dir / "flights.jsonl"):
        timeline.flights.append((float(line["t_s"]), [f for f in (Flight.parse(r) for r in line["flights"]) if f is not None]))
    timeline.ops = sorted(read_jsonl(run_dir / "ops.jsonl"), key=lambda o: o["t_s"])

    def ticks():
        with open(run_dir / "detlog.jsonl", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    yield tick_from_json(json.loads(line), calibs)
    return replay(ticks(), read_jsonl(run_dir / "truth.jsonl"), timeline, terminal, cameras, queues, int(info["seed"]), corrections, JoinWaits.of(run_dir)), _evacuation_record(run_dir, timeline)


def _evacuation_record(run_dir: Path, timeline: Timeline) -> dict | None:
    """A9's answer next to what Unity's crowd did, counting those in the zone at the alarm (kpi.json). metrics.json's evacT90 is no
    label: it also counts whoever walks into the blocked zone later, up to half an hour on. Nobody inside at the alarm: nothing to compare."""
    path = run_dir / "kpi.json"
    if timeline.evacuation_plan is None or not path.exists():
        return None
    evacuations = json.loads(path.read_text(encoding="utf-8")).get("evacuations") or []
    if not evacuations or not evacuations[0].get("inside_at_alarm"):
        return None
    e = evacuations[0]
    return {**timeline.evacuation_plan, "true_t90": e.get("egress_t90_s"), "true_last_out": e.get("last_out_since_alarm_s"), "true_people": e.get("inside_at_alarm")}


def _live_dir() -> Path:
    from ..config import LIVE_DIR
    return LIVE_DIR

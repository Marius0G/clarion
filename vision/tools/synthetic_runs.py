"""Writes run folders in the batch layout (dataset.py) from the synthetic airport, to exercise `ml.train` end to end with Unity off.
Its numbers are about made-up people: never for a slide.
    python tools/synthetic_runs.py <out dir> [--seeds 8] [--hours 2]"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from clarion_vision.queues import load_queues
from clarion_vision.sources.base import load_camera_specs
from clarion_vision.sources.synthetic import DEMO_FLIGHTS, SyntheticAirport
from clarion_vision.terminal import load_terminal
from tools.fake_cctv_live import Channel, boxes_for

ZONES = {"security": "U_SECURITY_QUEUE", "checkin_group_1": "check_in:1", "checkin_group_2": "check_in:2", "checkin_group_3": "check_in:3"}


def write_run(root: Path, seed: int, hours: float, terminal, specs, queues) -> None:
    root.mkdir(parents=True, exist_ok=True)
    channel = Channel(root)                       # cctv.json and <camera>/calib.json, the run's own copy
    rng = np.random.default_rng(seed)
    air = SyntheticAirport(queues, specs, terminal, seed=seed, start_s=7.5 * 3600, recall=float(rng.uniform(0.7, 0.92)), load=float(rng.uniform(0.9, 1.5)))
    (root / "run.json").write_text(json.dumps({"seed": seed, "arm": "A", "speed": 0.0, "sim_start": air.t, "sim_end": air.t + hours * 3600, "detector": "synthetic"}), encoding="utf-8")
    flights = [{"airline": "W6", "destination": "x", "gateCloseAt": None, "status": "scheduled", "delayMin": 0, **f} for f in DEMO_FLIGHTS]
    (root / "flights.jsonl").write_text(json.dumps({"t_s": air.t, "flights": flights}) + "\n", encoding="utf-8")
    (root / "ops.jsonl").write_text("", encoding="utf-8")
    exits = {q.queue: len(air.served[q.queue]) for q in queues}
    with open(root / "detlog.jsonl", "w", encoding="utf-8") as det, open(root / "truth.jsonl", "w", encoding="utf-8") as truth:
        for k in range(int(hours * 3600 / 5)):
            tick = air.step(5.0)
            cameras = {c: {"boxes": boxes_for(points, channel.calibs[c], channel.cameras[c])} for c, points in tick.cameras.items()}
            det.write(json.dumps({"seq": k, "seed": seed, "t_s": tick.t_s, "speed": 0, "tracks_valid": True, "detector": "synthetic", "cameras": cameras}, separators=(",", ":")) + "\n")
            done = {q.queue: len(air.served[q.queue]) - exits[q.queue] for q in queues if q.queue in ZONES}
            exits.update({q: exits[q] + n for q, n in done.items()})
            truth.write(json.dumps({"t_s": tick.t_s, "zones": [{"zone": ZONES[q.queue], "waiting": air.true_queue(q.queue), "waitMin": air.true_wait_min(q.queue) or 0.0} for q in queues if q.queue in ZONES],
                                    "lanes": {ZONES[q.queue]: q.default_lanes for q in queues if q.queue in ZONES}, "queue_exits": {q: n for q, n in done.items() if n}}) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("out")
    ap.add_argument("--seeds", type=int, default=8)
    ap.add_argument("--hours", type=float, default=2.0)
    a = ap.parse_args()
    terminal = load_terminal()
    specs, queues = load_camera_specs(), load_queues(lane_limits=terminal.lane_limits)
    for seed in range(a.seeds):
        write_run(Path(a.out) / f"{seed}_A", seed, a.hours, terminal, specs, queues)
        print("wrote seed", seed, flush=True)


if __name__ == "__main__":
    main()

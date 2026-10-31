"""The queues the service watches: their floor ring from cctv.json, their head from t2_nav, and how they map to contract zones."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .config import DATA_DIR, UNITY_REPO


@dataclass(frozen=True)
class QueueSpec:
    queue: str                # Unity's queue id
    zone: str                 # flow.report row id
    level: str
    ring: np.ndarray
    head: tuple[float, float]
    area_m2: float
    lanes_key: str | None
    target_min: float | None
    mu0: float                # prior people/min per lane, until the queue head has been watched for a while
    default_lanes: int
    max_lanes: int
    curve: str                # presentation curve, forecast.CURVES


# Priors in people/min per lane, replaced by measurement within minutes (wait.HeadRate). From one simulated run: security
# 1.63 exits per lane-minute while people wait; bag drop 82 s per passenger at a desk.
_PARAMS = {
    "security": dict(zone="U_SECURITY_QUEUE", lanes_key="security", target_min=10.0, mu0=1.6, default_lanes=2, max_lanes=4, curve="security"),
    "checkin_group_1": dict(zone="check_in:1", lanes_key="check_in:1", target_min=15.0, mu0=0.73, default_lanes=3, max_lanes=4, curve="check_in"),
    "checkin_group_2": dict(zone="check_in:2", lanes_key="check_in:2", target_min=15.0, mu0=0.73, default_lanes=3, max_lanes=4, curve="check_in"),
    "checkin_group_3": dict(zone="check_in:3", lanes_key="check_in:3", target_min=15.0, mu0=0.73, default_lanes=3, max_lanes=4, curve="check_in"),
    "passport_departures": dict(zone="U_PASSPORT_DEP", lanes_key=None, target_min=None, mu0=3.0, default_lanes=2, max_lanes=2, curve="passport"),
    "passport_arrivals": dict(zone="G_ARRIVALS_PASSPORT", lanes_key=None, target_min=None, mu0=3.0, default_lanes=2, max_lanes=2, curve="none"),
}


def read_nav_queues(path: Path | None = None) -> dict:
    """Queue paths and heads: Unity's t2_nav.json when this machine has it (it moves with the interior), else the snapshot."""
    live = UNITY_REPO / "data" / "processed" / "unity" / "airport" / "t2_nav.json"
    if path is None and live.exists():
        return {q["id"]: q for q in json.loads(live.read_text(encoding="utf-8"))["queues"]}
    return json.loads((path or DATA_DIR / "nav_queues_snapshot.json").read_text(encoding="utf-8"))


def load_queues(cctv: dict | Path | None = None, nav_queues: Path | None = None, lane_limits: dict | None = None) -> list[QueueSpec]:
    if cctv is None:
        cctv = DATA_DIR / "cctv_snapshot.json"
    if isinstance(cctv, Path):
        cctv = json.loads(cctv.read_text(encoding="utf-8"))
    nav = read_nav_queues(nav_queues)
    out = []
    for q in cctv.get("queues", []):
        params = _PARAMS.get(q["id"])
        if params is None:
            continue
        limits = (lane_limits or {}).get(params["lanes_key"])
        if limits:
            params = {**params, "default_lanes": int(limits.get("initial", params["default_lanes"])), "max_lanes": int(limits.get("max", params["max_lanes"]))}
        info = nav.get(q["id"], {})
        ring = np.asarray(q["ring"], dtype=float)
        polyline = info.get("polyline")
        head = polyline[int(info.get("head", 0))] if polyline else ring.mean(axis=0).tolist()
        out.append(QueueSpec(queue=q["id"], level=q["level"], ring=ring, head=(float(head[0]), float(head[1])), area_m2=float(q["area_m2"]), **params))
    return out

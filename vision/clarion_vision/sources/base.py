"""D0's camera input, one interface for its two modes (and a local stand-in). A source hands the chain floor points per camera;
the chain never knows where they came from, except the `detector` label that keeps simulated numbers from being called YOLO."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np

from ..config import DATA_DIR
from ..state import SimView

SIMULATED, YOLO, SYNTHETIC = "simulated", "yolo", "synthetic"


@dataclass(slots=True)
class FloorPoint:
    x: float
    z: float
    level: str
    track: int
    conf: float
    box_h: float
    camera: str


@dataclass
class Tick:
    t_s: float                                  # sim seconds of the day when the cameras looked
    detector: str
    cameras: dict[str, list[FloorPoint]]        # every working camera, [] if it sees nobody; a missing camera is down
    speed: float | None = None
    tracks_valid: bool = True
    seq: int = 0
    invalid_tracks: set[str] = field(default_factory=set)   # cameras whose tracks jumped this tick, when not all of them did


@dataclass
class VisGrid:
    """cctv.json "vis": line of sight over the floor from the mount, ray-tested on the voxel model. One digit per cell, 0..7."""
    x0: float
    z0: float
    cell: float
    nx: int
    nz: int
    values: np.ndarray

    @staticmethod
    def parse(d: dict | None) -> "VisGrid | None":
        if not d or not d.get("rows"):
            return None
        values = np.frombuffer(str(d["rows"]).encode("ascii"), dtype=np.uint8).astype(float) - 48.0
        return VisGrid(float(d["x0"]), float(d["z0"]), float(d["cell"]), int(d["nx"]), int(d["nz"]), values.reshape(int(d["nz"]), int(d["nx"])) / 7.0)

    def sample(self, xs: np.ndarray, zs: np.ndarray) -> np.ndarray:
        ix = ((np.asarray(xs) - self.x0) / self.cell).astype(int)
        iz = ((np.asarray(zs) - self.z0) / self.cell).astype(int)
        ok = (ix >= 0) & (ix < self.nx) & (iz >= 0) & (iz < self.nz)
        out = np.zeros(np.shape(xs))
        out[ok] = self.values[iz[ok], ix[ok]]
        return out


@dataclass
class CameraSpec:
    id: str
    level: str
    view_region: np.ndarray
    queues_seen: dict[str, float] = field(default_factory=dict)
    vis: VisGrid | None = None

    def sees(self, xs: np.ndarray, zs: np.ndarray, min_vis: float = 0.35) -> np.ndarray:
        """Floor points this camera really looks at: inside its footprint and, when the grid exists, not behind a wall."""
        from ..geometry import in_ring
        mask = in_ring(xs, zs, self.view_region)
        if self.vis is not None:
            mask &= self.vis.sample(xs, zs) >= min_vis
        return mask


class CameraSource(Protocol):
    detector: str

    def camera_specs(self) -> list[CameraSpec]: ...

    def read(self, sim: SimView) -> Tick | None:
        """The newest tick not yet returned, or None. Must not block for long."""

    def close(self) -> None: ...


def load_camera_specs(cctv: dict | Path | None = None) -> list[CameraSpec]:
    """cctv.json: from the live channel's manifest when given, else the snapshot in data/."""
    if cctv is None:
        cctv = DATA_DIR / "cctv_snapshot.json"
    if isinstance(cctv, Path):
        cctv = json.loads(cctv.read_text(encoding="utf-8"))
    specs = []
    for c in cctv["cameras"]:
        region = np.asarray(c.get("view_region") or [], dtype=float)
        if region.shape[0] < 3:
            continue
        specs.append(CameraSpec(c["id"], c["level"], region, {q["queue"]: float(q["coverage"]) for q in c.get("queues_seen") or []}, VisGrid.parse(c.get("vis"))))
    return specs

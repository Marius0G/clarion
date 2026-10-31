"""The simulated detector (D0's fallback): Unity computes what each camera sees and writes boxes to local files (CctvLive.cs,
data/interim/cctv_live/). No truth in this channel, no ports. Also replays the batch log `-cctv-det-log`, same schema per line."""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from ..geometry import Calib
from ..state import SimView
from .base import SIMULATED, CameraSpec, FloorPoint, Tick, load_camera_specs


def read_json(path: Path, retries: int = 5, wait_s: float = 0.02):
    """Files are replaced by rename; on Windows a read can still hit a sharing violation or a half-renamed file."""
    for attempt in range(retries):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (PermissionError, json.JSONDecodeError, OSError):
            if attempt == retries - 1:
                return None
            time.sleep(wait_s)
    return None


def tick_from_json(row: dict, calibs: dict[str, Calib]) -> Tick:
    """One detections.json / JSONL line to floor points. Foot point = (x + w/2, y + h), through the camera's homography."""
    cameras: dict[str, list[FloorPoint]] = {}
    for camera, view in (row.get("cameras") or {}).items():
        calib = calibs.get(camera)
        if calib is None:
            continue
        boxes = view.get("boxes") or []
        points: list[FloorPoint] = []
        if boxes:
            arr = np.asarray(boxes, dtype=float)
            floor = calib.feet_to_floor(arr[:, :4])
            for box, (x, z) in zip(arr, floor):
                points.append(FloorPoint(float(x), float(z), calib.level, int(box[5]), float(box[4]), float(box[3]), camera))
        cameras[camera] = points
    return Tick(float(row["t_s"]), str(row.get("detector") or SIMULATED), cameras, row.get("speed"), bool(row.get("tracks_valid", True)), int(row.get("seq") or 0))


def load_calibs(root: Path, camera_ids: list[str]) -> dict[str, Calib]:
    out = {}
    for camera in camera_ids:
        data = read_json(root / camera / "calib.json")
        if data:
            out[camera] = Calib(data)
    return out


class LiveFilesSource:
    def __init__(self, root: Path):
        self.root = Path(root)
        manifest = read_json(self.root / "manifest.json")
        if manifest is None:
            raise FileNotFoundError(f"no manifest.json in {self.root}: is Unity running with -cctv-live?")
        self.manifest = manifest
        self.cctv = read_json(self.root / "cctv.json")
        if self.cctv is None:
            raise FileNotFoundError(f"no cctv.json in {self.root}: the channel is still starting")
        self.detector = str(manifest.get("detector") or SIMULATED)
        self.specs = load_camera_specs(self.cctv)
        ids = manifest.get("cameras") or [s.id for s in self.specs]
        self.calibs = load_calibs(self.root, ids)
        self.last_seq: int | None = None

    def camera_specs(self) -> list[CameraSpec]:
        return self.specs

    def read(self, sim: SimView) -> Tick | None:
        row = read_json(self.root / "detections.json")
        if not row or row.get("seq") == self.last_seq:
            return None
        self.last_seq = row.get("seq")
        return tick_from_json(row, self.calibs)

    def close(self) -> None:
        pass


class JsonlReplaySource:
    """Offline: the batch log, tick after tick, no clock. Calib comes from a live directory or a labelled export."""

    def __init__(self, log: Path, calib_root: Path, cctv: dict | Path | None = None):
        self.handle = open(log, encoding="utf-8")
        self.specs = load_camera_specs(cctv)
        self.calibs = load_calibs(Path(calib_root), [s.id for s in self.specs])
        self.detector = SIMULATED

    def camera_specs(self) -> list[CameraSpec]:
        return self.specs

    def read(self, sim: SimView | None = None) -> Tick | None:
        line = self.handle.readline()
        return tick_from_json(json.loads(line), self.calibs) if line.strip() else None

    def close(self) -> None:
        self.handle.close()

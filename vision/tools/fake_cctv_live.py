"""Writes the camera channel exactly as Unity's CctvLive.cs does (manifest.json, cctv.json, <camera>/calib.json, detections.json),
from the synthetic airport, so --source live can be exercised with Unity off. Calibration comes from each camera's pose, with
the math of CctvCalib in CctvRig.cs. `detector` says "synthetic", never "simulated".
    python tools/fake_cctv_live.py <dir> [--speed 10] [--hz 2]"""
from __future__ import annotations

import argparse
import json
import math
import os
import time
from pathlib import Path

import numpy as np

from clarion_vision.config import DATA_DIR
from clarion_vision.queues import load_queues
from clarion_vision.sources.base import Tick, load_camera_specs
from clarion_vision.sources.synthetic import SyntheticAirport
from clarion_vision.terminal import load_terminal

WIDTH, HEIGHT = 1280, 720
PERSON_HEIGHT_M = 1.7


def pose(camera: dict) -> tuple[np.ndarray, np.ndarray]:
    """R and t, OpenCV camera frame (x right, y down, z forward), from yaw (compass) and pitch (down) in Unity's left-handed world."""
    yaw, pitch = math.radians(camera["yaw"]), math.radians(camera["pitch"])
    forward = np.array([math.sin(yaw) * math.cos(pitch), -math.sin(pitch), math.cos(yaw) * math.cos(pitch)])
    right = np.array([math.cos(yaw), 0.0, -math.sin(yaw)])
    up = np.cross(forward, right)
    R = np.vstack((right, -up, forward))
    return R, -R @ np.asarray(camera["position"], dtype=float)


def intrinsics(hfov_deg: float, width: int = WIDTH, height: int = HEIGHT) -> np.ndarray:
    fx = width * 0.5 / math.tan(math.radians(hfov_deg) * 0.5)
    return np.array([[fx, 0, width * 0.5], [0, fx, height * 0.5], [0, 0, 1.0]])


def floor_homography(K: np.ndarray, R: np.ndarray, t: np.ndarray, floor_y: float) -> np.ndarray:
    """Floor (x, z, 1) at height floor_y to pixels: K [r1 r3 h r2 + t]."""
    H = K @ np.column_stack((R[:, 0], R[:, 2], floor_y * R[:, 1] + t))
    return H / H[2, 2]


def calib_json(camera: dict, floors: dict) -> dict:
    K, (R, t) = intrinsics(camera["hfov"]), pose(camera)
    out = {}
    for level, y in floors.items():
        H = floor_homography(K, R, t, float(y))
        out[level] = {"floor_y": y, "H_floor_to_image": H.tolist(), "H_image_to_floor": np.linalg.inv(H).tolist()}
    return {"camera": camera["id"], "level": camera["level"], "width": WIDTH, "height": HEIGHT, "K": K.tolist(), "dist_opencv": [0, 0, 0, 0, 0],
            "R_world_to_cam": R.tolist(), "t_world_to_cam": t.tolist(), "floors": out}


def boxes_for(points, calib: dict, camera: dict) -> list[list[float]]:
    K, R, t = np.asarray(calib["K"]), np.asarray(calib["R_world_to_cam"]), np.asarray(calib["t_world_to_cam"])
    floor_y = float(calib["floors"][calib["level"]]["floor_y"])
    out = []
    for p in points:
        feet, head = (K @ (R @ np.array(v) + t) for v in ((p.x, floor_y, p.z), (p.x, floor_y + PERSON_HEIGHT_M, p.z)))
        if feet[2] <= 0.1 or head[2] <= 0.1:
            continue
        u, v = feet[0] / feet[2], feet[1] / feet[2]
        h = abs(v - head[1] / head[2])
        if not (0 <= u < WIDTH and 0 <= v < HEIGHT) or h < 2:
            continue
        w = 0.42 * h
        out.append([round(u - w / 2, 2), round(v - h, 2), round(w, 2), round(h, 2), round(p.conf, 3), p.track])
    return out


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


class Channel:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        cctv = json.loads((DATA_DIR / "cctv_snapshot.json").read_text(encoding="utf-8"))
        self.cameras = {c["id"]: c for c in cctv["cameras"]}
        self.calibs = {}
        for cid, camera in self.cameras.items():
            (self.root / cid).mkdir(exist_ok=True)
            self.calibs[cid] = calib_json(camera, cctv["floors"])
            write_atomic(self.root / cid / "calib.json", json.dumps(self.calibs[cid]))
        write_atomic(self.root / "cctv.json", json.dumps(cctv))
        write_atomic(self.root / "manifest.json", json.dumps({"schema": 1, "seed": 1, "width": WIDTH, "height": HEIGHT, "det_hz": 2, "frame_fps": 1,
                                                              "cameras": list(self.cameras), "frame_cameras": [], "truth": False, "detector": "synthetic"}))
        self.seq = 0

    def write_tick(self, tick: Tick, speed: float) -> dict:
        self.seq += 1
        row = {"seq": self.seq, "seed": 1, "t_s": round(tick.t_s, 3), "speed": speed, "tracks_valid": True, "detector": "synthetic",
               "cameras": {c: {"boxes": boxes_for(points, self.calibs[c], self.cameras[c])} for c, points in tick.cameras.items() if c in self.cameras}}
        write_atomic(self.root / "detections.json", json.dumps(row, separators=(",", ":")))
        return row


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("root")
    ap.add_argument("--speed", type=float, default=10.0)
    ap.add_argument("--hz", type=float, default=2.0)
    a = ap.parse_args()
    terminal = load_terminal()
    specs, queues = load_camera_specs(), load_queues(lane_limits=terminal.lane_limits)
    air = SyntheticAirport(queues, specs, terminal, speed=a.speed)
    channel = Channel(Path(a.root))
    print(f"writing to {a.root} at {a.hz} Hz, {a.speed}x", flush=True)
    while True:
        started = time.monotonic()
        channel.write_tick(air.step(a.speed / a.hz), a.speed)
        time.sleep(max(0.0, 1.0 / a.hz - (time.monotonic() - started)))


if __name__ == "__main__":
    main()

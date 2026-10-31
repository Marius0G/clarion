"""D0's real mode: frames from 2-4 overview cameras (Unity's local ring of JPEGs, 1-2 fps), YOLO11s + ByteTrack per camera, each
foot point through the lens and H_image_to_floor to floor metres (A1). Only the newest frame of a camera is ever read: a slow
GPU loses frames, it does not build a queue. One model per camera, because ByteTrack keeps its state in the predictor.
With `hybrid`, cameras without frames keep the simulated detector, so the rest of the terminal is not unknown."""
from __future__ import annotations

import subprocess
import time
from pathlib import Path

import numpy as np

from ..config import UNITY_REPO
from ..state import SimView
from .base import YOLO, CameraSpec, FloorPoint, Tick, load_camera_specs
from .live_files import load_calibs, read_json, tick_from_json

DEFAULT_WEIGHTS = UNITY_REPO / "data" / "interim" / "cctv" / "models" / "yolo11s.pt"
MAX_TRACK_GAP_S = 2.5     # sim seconds between two frames of a camera; beyond this, people have moved too far for its tracker
GPU_FREE_MIN_MIB = 1500   # the GPU is shared with Unity; below this YOLO runs on the CPU (about 200 ms a frame at 960 px)


def pick_device(requested: str) -> str:
    """`auto`: the GPU only when Unity leaves room on it."""
    if requested != "auto":
        return requested
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5)
        return "0" if int(out.stdout.split()[0]) >= GPU_FREE_MIN_MIB else "cpu"
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return "cpu"


class FrameDetector:
    """YOLO + ByteTrack for one camera. Returns boxes as x, y, w, h, conf, track."""

    def __init__(self, weights: str, device: str, imgsz: int, conf: float):
        from ultralytics import YOLO as Ultralytics
        self.model = Ultralytics(weights)
        self.device, self.imgsz, self.conf = device, imgsz, conf
        self.extra = {} if str(device) == "cpu" else {"quantize": 16}
        self.last_boxes = np.empty((0, 6))

    def detect(self, image: np.ndarray) -> np.ndarray:
        self.last_boxes = self._detect(image)
        return self.last_boxes

    def _detect(self, image: np.ndarray) -> np.ndarray:
        result = self.model.track(image, persist=True, tracker="bytetrack.yaml", classes=[0], conf=self.conf, imgsz=self.imgsz,
                                  device=self.device, verbose=False, **self.extra)[0]
        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            return np.empty((0, 6))
        xyxy = boxes.xyxy.cpu().numpy()
        conf = boxes.conf.cpu().numpy()
        ids = boxes.id.cpu().numpy() if boxes.id is not None else -np.arange(1, len(xyxy) + 1, dtype=float)
        return np.column_stack((xyxy[:, 0], xyxy[:, 1], xyxy[:, 2] - xyxy[:, 0], xyxy[:, 3] - xyxy[:, 1], conf, ids))


class YoloFramesSource:
    def __init__(self, root: Path | str, weights: str | None = None, device: str = "auto", imgsz: int = 960, conf: float = 0.25,
                 hybrid: bool = False, cameras: list[str] | None = None):
        self.root = Path(root)
        manifest = read_json(self.root / "manifest.json")
        self.cctv = read_json(self.root / "cctv.json")
        if manifest is None or self.cctv is None:
            raise FileNotFoundError(f"no manifest.json or cctv.json in {self.root}: is Unity running with -cctv-live?")
        self.manifest = manifest
        self.frame_cameras = cameras or list(manifest.get("frame_cameras") or [])
        if not self.frame_cameras:
            raise FileNotFoundError(f"{self.root}: the channel has no frame cameras")
        self.hybrid = hybrid
        self.detector = f"{YOLO}+{manifest.get('detector', 'simulated')}" if hybrid else YOLO
        specs = load_camera_specs(self.cctv)
        self.specs = specs if hybrid else [s for s in specs if s.id in self.frame_cameras]
        self.calibs = load_calibs(self.root, list(manifest.get("cameras") or []) if hybrid else self.frame_cameras)
        weights = str(weights or DEFAULT_WEIGHTS)
        self.device = pick_device(device)
        self.detectors = {c: FrameDetector(weights, self.device, imgsz, conf) for c in self.frame_cameras}
        self.last_seq: dict[str, int] = {}
        self.last_t: dict[str, float] = {}
        self.last_points: dict[str, list[FloorPoint]] = {}
        self.last_det_seq = None
        self.infer_ms: dict[str, float] = {}

    def camera_specs(self) -> list[CameraSpec]:
        return self.specs

    def _read_frame(self, camera: str):
        meta = read_json(self.root / camera / "frame.json")
        if not meta or meta.get("seq") == self.last_seq.get(camera):
            return None
        import cv2
        image = cv2.imread(str(self.root / camera / str(meta["file"])))
        return (meta, image) if image is not None else None

    def read(self, sim: SimView) -> Tick | None:
        import cv2  # noqa: F401  (loaded here so the module imports without OpenCV in tests)
        fresh = False
        invalid: set[str] = set()
        newest = None
        for camera in self.frame_cameras:
            got = self._read_frame(camera)
            if got is None:
                continue
            meta, image = got
            started = time.perf_counter()
            boxes = self.detectors[camera].detect(image)
            self.infer_ms[camera] = (time.perf_counter() - started) * 1000
            t = float(meta["t_s"])
            calib = self.calibs[camera]
            floor = calib.feet_to_floor(boxes[:, :4]) if len(boxes) else np.empty((0, 2))
            self.last_points[camera] = [FloorPoint(float(x), float(z), calib.level, int(b[5]), float(b[4]), float(b[3]), camera) for b, (x, z) in zip(boxes, floor)]
            if camera in self.last_t and t - self.last_t[camera] > MAX_TRACK_GAP_S:
                invalid.add(camera)
            self.last_seq[camera], self.last_t[camera] = meta.get("seq"), t
            newest = max(newest or t, t)
            fresh = True

        base = None
        if self.hybrid:
            row = read_json(self.root / "detections.json")
            if row and row.get("seq") != self.last_det_seq:
                self.last_det_seq = row.get("seq")
                row = {**row, "cameras": {c: v for c, v in (row.get("cameras") or {}).items() if c not in self.frame_cameras}}
                base = tick_from_json(row, self.calibs)
        if not fresh and base is None:
            return None
        cameras = dict(base.cameras) if base else {}
        cameras.update(self.last_points)
        t = max(x for x in (newest, base.t_s if base else None) if x is not None)
        return Tick(t, self.detector, cameras, base.speed if base else None, base.tracks_valid if base else True, invalid_tracks=invalid | {c for c in self.frame_cameras if c not in self.last_t})

    def close(self) -> None:
        self.detectors.clear()

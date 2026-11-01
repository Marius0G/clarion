"""Camera video for the dashboard: Unity's live CCTV frames (CctvLive frame cameras, <live dir>/<camera>/frame.json + f0..f3.jpg),
real YOLO on each, the boxes drawn on the picture, sent as `camera.frame` on vision's socket. Display only: the counts in
flow.report still come from the camera channel the service reads (in the demo, the simulated detector, D0), so the frame says
"YOLO" and its own count. Off unless --frames. Bounded: the newest frame of each camera only, one model for all cameras, at
most 1 frame/s per camera (slower on the CPU), at most 4 cameras, each JPEG under 120 KB.

YOLO runs in its own process (`python -m clarion_vision.camera_feed`, started by the service), which loads torch before anything
else and with a PATH of only this env and Windows: in the service's process torch's shm.dll failed to load (WinError 127) on
one machine, because a DLL of the same name was already loaded. The child prints one camera.frame per line on stdout.

    {"type":"camera.frame","ts":"...","data":{"camera":"cctv_security_queue","zone":"U_SECURITY_QUEUE","simTime":54335.0,
     "w":960,"h":540,"jpeg":"<base64>","count":37,"detector":"yolo"}}"""
from __future__ import annotations

if __name__ == "__main__":        # the YOLO child: torch's DLLs before numpy's and OpenCV's
    import torch  # noqa: F401

import base64
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .sources.live_files import read_json

log = logging.getLogger("clarion.frames")
DEFAULT_CAMERAS = ("cctv_security_queue", "cctv_checkin_overview", "cctv_hall_east", "cctv_upper_4")
MAX_CAMERAS, WIDTH, HEIGHT = 4, 960, 540
# Each picture goes out at up to SEND_FPS a camera so the console's monitors move smoothly (worker FRAME_MIN_MS 90);
# YOLO still runs at most every `period` (about 2 a second) and its latest boxes are drawn on the pictures in between.
# Smaller JPEGs at that rate keep the upload near 1 MB/s for four cameras.
import os as _os
SEND_FPS = float(_os.environ.get("CAMERA_SEND_FPS", "5"))
JPEG_MAX_BYTES = int(_os.environ.get("CAMERA_JPEG_KB", "14")) * 1000
# Sent pictures are this wide (16:9). Every picture crosses the venue Wi-Fi twice (vision up, the console down: ~0.6-0.9 MB/s
# measured on 1 Nov), so 640 px at ~25 KB keeps four cameras at about 4-5 frames a second each.
OUT_W = int(_os.environ.get("CAMERA_OUT_W", "512"))
GPU_PERIOD_S, CPU_PERIOD_S = 1.0, 2.0          # real seconds between two frames of one camera (slowest on the GPU)
GPU_BUDGET = 0.2                                # YOLO may take at most this share of each second on the GPU it shares with Unity
MIN_PERIOD_S = 0.5                              # at most 2 frames/s per camera: Unity renders at most that (-cctv-live-fps 2)
QUEUE_ZONE = {"security": "U_SECURITY_QUEUE", "checkin_group_1": "check_in:1", "checkin_group_2": "check_in:2", "checkin_group_3": "check_in:3"}


def camera_ids(names: str | None) -> list[str]:
    ids = [n.strip() for n in (names or ",".join(DEFAULT_CAMERAS)).split(",") if n.strip()]
    return [n if n.startswith("cctv_") else "cctv_" + n for n in ids][:MAX_CAMERAS]


def zone_of(camera: dict | None) -> str | None:
    """The queue a camera watches best, as a contract zone; None for a camera over no queue."""
    seen = [q for q in (camera or {}).get("queues_seen") or [] if q.get("queue") in QUEUE_ZONE]
    return QUEUE_ZONE[max(seen, key=lambda q: q.get("coverage", 0))["queue"]] if seen else None


def frame_message(camera: str, zone: str | None, sim_time: float, jpeg: bytes, count: int, detector: str = "yolo") -> str:
    """The same envelope as every vision message: {type, ts, data}."""
    if len(jpeg) > JPEG_MAX_BYTES:
        raise ValueError(f"camera.frame {camera}: {len(jpeg)} bytes, over {JPEG_MAX_BYTES}")
    data = {"camera": camera, "zone": zone, "simTime": round(float(sim_time), 2), "w": WIDTH, "h": HEIGHT,
            "jpeg": base64.b64encode(jpeg).decode("ascii"), "count": int(count), "detector": detector}
    ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return json.dumps({"type": "camera.frame", "ts": ts, "data": data}, separators=(",", ":"))


def draw(image: np.ndarray, boxes: np.ndarray, camera: str, label: str) -> np.ndarray:
    """Boxes in the source picture's pixels, then down to 960 x 540 with a one-line caption."""
    import cv2
    out = image.copy()
    for x, y, w, h, conf in boxes[:, :5] if len(boxes) else []:
        cv2.rectangle(out, (int(x), int(y)), (int(x + w), int(y + h)), (60, 220, 60), 2)
    out = cv2.resize(out, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA)
    cv2.rectangle(out, (0, 0), (WIDTH, 26), (0, 0, 0), -1)
    cv2.putText(out, label, (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def encode(image: np.ndarray) -> bytes:
    import cv2
    for scale in (1.0, 0.75, 0.5):          # a busy picture that will not fit at full size goes out smaller
        img = image if scale == 1.0 else cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        for quality in (60, 50, 42, 35):        # start near what fits (each try is a full encode)
            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
            if ok and len(buf) <= JPEG_MAX_BYTES:
                return buf.tobytes()
    raise ValueError("cannot fit the frame under the size limit")


class Yolo:
    """One YOLO11s for every camera (predict, no tracker: the picture needs boxes, not ids)."""

    def __init__(self, weights: str, device: str, imgsz: int, conf: float = 0.25):
        from ultralytics import YOLO as Ultralytics
        self.model, self.device, self.imgsz, self.conf = Ultralytics(weights), device, imgsz, conf

    def __call__(self, image: np.ndarray) -> np.ndarray:
        result = self.model.predict(image, classes=[0], conf=self.conf, imgsz=self.imgsz, device=self.device, verbose=False)[0]
        if result.boxes is None or len(result.boxes) == 0:
            return np.empty((0, 5))
        xyxy, conf = result.boxes.xyxy.cpu().numpy(), result.boxes.conf.cpu().numpy()
        return np.column_stack((xyxy[:, 0], xyxy[:, 1], xyxy[:, 2] - xyxy[:, 0], xyxy[:, 3] - xyxy[:, 1], conf))


class CameraFeed:
    def __init__(self, root: Path | str, cameras: str | None = None, device: str = "auto", weights: str | None = None, detector=None):
        self.root = Path(root)
        self.cameras = camera_ids(cameras)
        self.detector, self.device, self.weights = detector, device, weights
        self.last_seq: dict[str, object] = {}
        self.next_due: dict[str, float] = {}
        self.next_send: dict[str, float] = {}
        self.boxes: dict[str, np.ndarray] = {}
        self.zones: dict[str, str | None] = {}
        self.sent = 0
        self.infer_ms = 0.0
        self.infer_avg_ms = 0.0

    def _ensure(self) -> None:
        if self.detector is None:
            from .sources.yolo import DEFAULT_WEIGHTS, pick_device
            self.device = pick_device(self.device)
            self.detector = Yolo(str(self.weights or DEFAULT_WEIGHTS), self.device, 960)
            log.info("camera frames: YOLO11s on %s for %s", self.device, self.cameras)
        if not self.zones:
            cctv = read_json(self.root / "cctv.json") or {}
            by_id = {c.get("id"): c for c in cctv.get("cameras") or []}
            self.zones = {c: zone_of(by_id.get(c)) for c in self.cameras}

    @property
    def period(self) -> float:
        """Per camera. On the GPU, as fast as the budget allows: n cameras x measured YOLO time <= GPU_BUDGET of a second,
        between MIN_PERIOD_S and GPU_PERIOD_S (28 ms at 960 px with Unity running -> 0.56 s, about 1.8 frames/s each)."""
        if self.device == "cpu":
            return CPU_PERIOD_S
        if self.infer_avg_ms <= 0:
            return GPU_PERIOD_S
        return min(GPU_PERIOD_S, max(MIN_PERIOD_S, len(self.cameras) * self.infer_avg_ms / 1000.0 / GPU_BUDGET))

    def next_frames(self) -> list[str]:
        """Blocking (run it in a thread): one camera.frame per camera with a new picture that is due. [] when nothing is new."""
        import cv2
        out = []
        for camera in self.cameras:
            now = time.monotonic()
            if now < self.next_send.get(camera, 0.0):
                continue
            meta = read_json(self.root / camera / "frame.json")
            if not meta or meta.get("seq") == self.last_seq.get(camera):
                continue
            image = cv2.imread(str(self.root / camera / str(meta.get("file"))))
            if image is None:
                continue
            self._ensure()
            self.last_seq[camera] = meta.get("seq")
            self.next_send[camera] = now + 1.0 / max(0.5, SEND_FPS)
            if camera not in self.boxes or now >= self.next_due.get(camera, 0.0):
                self.next_due[camera] = now + self.period
                started = time.perf_counter()
                self.boxes[camera] = self.detector(image)
                self.infer_ms = (time.perf_counter() - started) * 1000
                self.infer_avg_ms = self.infer_ms if self.infer_avg_ms <= 0 else 0.8 * self.infer_avg_ms + 0.2 * self.infer_ms
            boxes = self.boxes[camera]
            label = f"{camera.removeprefix('cctv_')}  |  {len(boxes)} persoane  |  YOLO11s"
            shown = draw(image, boxes, camera, label)
            if OUT_W and shown.shape[1] > OUT_W:
                shown = cv2.resize(shown, (OUT_W, round(shown.shape[0] * OUT_W / shown.shape[1])), interpolation=cv2.INTER_AREA)
            out.append(frame_message(camera, self.zones.get(camera), float(meta.get("t_s") or 0.0), encode(shown), len(boxes)))
        return out


def child_env() -> dict:
    """The child's environment: this one, with PATH cut to the Python env and Windows, so no foreign DLL shadows torch's."""
    import os
    import sys
    env_dir = Path(sys.executable).parent
    keep = [env_dir, env_dir / "Library" / "bin", env_dir / "Scripts", env_dir / "bin"]
    root = os.environ.get("SystemRoot", r"C:\Windows")
    keep += [Path(root) / "System32", Path(root), Path(root) / "System32" / "Wbem"]
    return {**os.environ, "PATH": os.pathsep.join(str(d) for d in keep), "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}


def main() -> None:
    import argparse
    import sys
    ap = argparse.ArgumentParser(description="YOLO on Unity's CCTV frames; one camera.frame JSON per line on stdout")
    ap.add_argument("--live-dir", required=True)
    ap.add_argument("--cameras", default=None)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--weights", default=None)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(name)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    feed = CameraFeed(a.live_dir, a.cameras, a.device, a.weights)
    while True:
        try:
            messages = feed.next_frames()
        except (OSError, ValueError) as e:          # a half-written picture: try the next one
            log.warning("camera frames: %s", e)
            messages = []
        try:
            # An empty line is a heartbeat: when the service is gone the write fails and this process ends with it.
            sys.stdout.write("".join(m + "\n" for m in messages) or "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            return
        time.sleep(0.05 if messages else 0.1)        # cheap (four small JSON reads); a new frame goes out within 0.1 s


if __name__ == "__main__":
    main()

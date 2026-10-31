"""YOLO + ByteTrack on an exported run's frames, through the same path as live: real frames -> YoloFramesSource (one model per
camera, newest frame only) -> floor points -> the chain. Plays a frame ring from the export; prints speed and what the chain says.
With labels in the export it also prints precision and recall against them.
    python tools/yolo_check.py <run dir> --cameras cctv_security_queue,cctv_upper_3 [--frames 30] [--device cpu]"""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path

import cv2
import numpy as np

from clarion_vision.chain import Chain
from clarion_vision.queues import load_queues
from clarion_vision.sources.base import load_camera_specs
from clarion_vision.sources.yolo import YoloFramesSource
from clarion_vision.state import LaneBook, SimView
from clarion_vision.terminal import load_terminal


def labels_of(path: Path, w: int, h: int) -> np.ndarray:
    if not path.exists() or path.stat().st_size == 0:
        return np.empty((0, 4))
    r = np.loadtxt(path, ndmin=2)
    return np.column_stack(((r[:, 1] - r[:, 3] / 2) * w, (r[:, 2] - r[:, 4] / 2) * h, r[:, 3] * w, r[:, 4] * h))


def match(boxes: np.ndarray, truth: np.ndarray) -> tuple[int, int, int]:
    used, tp = set(), 0
    for b in boxes:
        best, best_i = 0.0, -1
        for i, g in enumerate(truth):
            if i in used:
                continue
            ix = max(0.0, min(b[0] + b[2], g[0] + g[2]) - max(b[0], g[0]))
            iy = max(0.0, min(b[1] + b[3], g[1] + g[3]) - max(b[1], g[1]))
            inter = ix * iy
            union = b[2] * b[3] + g[2] * g[3] - inter
            if union > 0 and inter / union > best:
                best, best_i = inter / union, i
        if best >= 0.5:
            used.add(best_i)
            tp += 1
    return tp, len(boxes) - tp, len(truth) - tp


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("run")
    ap.add_argument("--cameras", default="cctv_security_queue")
    ap.add_argument("--frames", type=int, default=30)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--stride", type=int, default=1)
    ap.add_argument("--t0", type=float, default=8.5 * 3600)
    ap.add_argument("--dt", type=float, default=1.0)
    a = ap.parse_args()
    run, cameras = Path(a.run), a.cameras.split(",")
    terminal = load_terminal()
    with tempfile.TemporaryDirectory(prefix="yolo_check_") as tmp:
        root = Path(tmp)
        cctv = json.loads((Path(__file__).resolve().parents[1] / "data" / "cctv_snapshot.json").read_text(encoding="utf-8"))
        (root / "cctv.json").write_text(json.dumps(cctv), encoding="utf-8")
        (root / "manifest.json").write_text(json.dumps({"schema": 1, "frame_cameras": cameras, "cameras": cameras, "detector": "simulated"}), encoding="utf-8")
        for camera in cameras:
            (root / camera).mkdir()
            shutil.copy(run / camera / "calib.json", root / camera / "calib.json")
        source = YoloFramesSource(root, device=a.device)
        book = LaneBook(terminal.initial_lanes)
        chain = Chain(terminal, load_camera_specs(cctv), load_queues(cctv, lane_limits=terminal.lane_limits), book)
        files = {c: sorted((run / c / "rgb_deg").glob("*.jpg"))[:: a.stride][: a.frames] for c in cameras}
        counts = {c: [] for c in cameras}
        totals = {c: [0, 0, 0] for c in cameras}
        report = None
        for k in range(min(len(f) for f in files.values())):
            for camera in cameras:
                shutil.copy(files[camera][k], root / camera / "f0.jpg")
                (root / camera / "frame.json").write_text(json.dumps({"seq": k, "t_s": a.t0 + k * a.dt, "file": "f0.jpg"}), encoding="utf-8")
            tick = source.read(SimView())
            if tick is None:
                continue
            chain.ingest(tick, [])
            report = chain.report([])
            for camera in cameras:
                points = tick.cameras.get(camera, [])
                counts[camera].append(len(points))
                image = cv2.imread(str(files[camera][k]))
                truth = labels_of(run / camera / "yolo" / (files[camera][k].stem + ".txt"), image.shape[1], image.shape[0])
                # score against the labels with the source's own boxes
                boxes = source.detectors[camera].last_boxes
                tp, fp, fn = match(boxes[:, :4] if len(boxes) else boxes, truth)
                totals[camera][0] += tp; totals[camera][1] += fp; totals[camera][2] += fn
        for camera in cameras:
            tp, fp, fn = totals[camera]
            labelled = tp + fn > 0
            print(f"{camera}: {len(counts[camera])} frames, mean detections {np.mean(counts[camera]):.1f}, inference {source.infer_ms.get(camera, 0):.0f} ms on {source.device}; "
                  + (f"precision {tp / max(tp + fp, 1):.3f} recall {tp / max(tp + fn, 1):.3f} (tp {tp}, fp {fp}, fn {fn})" if labelled else "no labels in this export, nothing to score against"))
        if report:
            print("rows:", {r["zone"]: (r["waiting"], r.get("coverage")) for r in report.rows})


if __name__ == "__main__":
    main()

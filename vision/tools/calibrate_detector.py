"""Calibrates Unity's simulated detector on a real YOLO run over a labelled export (D0: "noise calibrated on the offline YOLO runs").
For each camera: YOLO + ByteTrack on rgb_deg/, matched against coco.json at IoU 0.5. Writes the parameters of cctv_detector.json.
Box height is the projected body (bbox_amodal), as CctvLive's recall model uses it, not the visible part. A false positive is a box
over nobody: one that overlaps a labelled or ignored person's body is a partial hit, which the simulated detector does not draw.
    python tools/calibrate_detector.py <export>[@glob] [<export>[@glob] ...] [--static <export>] [--device auto] [--stride 2] [--out ...]
An export given with --static has frames at one sim instant (v1's bug): it counts for recall, jitter and false positives, not id switches."""
from __future__ import annotations

import argparse
import fnmatch
import json
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

from clarion_vision.ml.calibrate import fit_detector
from clarion_vision.sources.yolo import DEFAULT_WEIGHTS, FrameDetector, pick_device


def iou(a, b) -> float:
    ix = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def body(a: dict) -> list[float]:
    return (a.get("attributes") or {}).get("bbox_amodal") or a["bbox"]


def match_frame(gt: list[dict], boxes: np.ndarray, threshold: float = 0.5, over_body: float = 0.3) -> tuple[dict[int, int], int]:
    """Greedy, best IoU first. Returns annotation index -> detection index, and the false positives: unmatched boxes that overlap
    no person's body (visible box or projected body, ignored people included) by over_body IoU and hold no body's centre."""
    pairs = sorted(((iou(a["bbox"], b[:4]), i, j) for i, a in enumerate(gt) for j, b in enumerate(boxes)), reverse=True)
    found: dict[int, int] = {}
    used: set[int] = set()
    for score, i, j in pairs:
        if score < threshold:
            break
        if i not in found and j not in used:
            found[i] = j
            used.add(j)
    false_pos = 0
    for j, b in enumerate(boxes):
        if j in used:
            continue
        cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
        over_someone = any(iou(a["bbox"], b[:4]) >= over_body or iou(body(a), b[:4]) >= over_body
                           or (body(a)[0] <= cx <= body(a)[0] + body(a)[2] and body(a)[1] <= cy <= body(a)[1] + body(a)[3]) for a in gt)
        false_pos += 0 if over_someone else 1
    return found, false_pos


def score_camera(camera_dir: Path, detector: FrameDetector, fps: float, stride: int) -> dict:
    coco = json.loads((camera_dir / "coco.json").read_text(encoding="utf-8"))
    per_image = defaultdict(list)
    for annotation in coco["annotations"]:
        per_image[annotation["image_id"]].append(annotation)
    frames = sorted((camera_dir / "rgb_deg").glob("*.jpg"))[::stride]
    h, vis, hit, jx, jy, jw, jh = [], [], [], [], [], [], []
    fp = 0
    last_track: dict[int, int] = {}
    switches, track_seconds = 0, 0.0
    for frame in frames:
        boxes = detector.detect(cv2.imread(str(frame)))
        gt = per_image.get(int(frame.stem), [])
        found, false_pos = match_frame(gt, boxes)
        fp += false_pos
        for i, a in enumerate(gt):
            if a.get("ignore"):
                continue
            x, y, w, height = a["bbox"]
            h.append(body(a)[3])
            vis.append(a["attributes"]["visibility"])
            hit.append(i in found)
            if i in found:
                b = boxes[found[i]]
                jx.append((b[0] - x) / height); jy.append((b[1] - y) / height); jw.append(b[2] / w - 1.0); jh.append(b[3] / height - 1.0)
                person = a.get("track_id")
                if person in last_track and last_track[person] != int(b[5]):
                    switches += 1
                last_track[person] = int(b[5])
                track_seconds += stride / fps
    return dict(h=h, vis=vis, hit=hit, jx=jx, jy=jy, jw=jw, jh=jh, fp=fp, frames=len(frames), switches=switches, track_seconds=track_seconds)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("runs", nargs="+", help="export folder, optionally @glob for its camera dirs (e.g. ...v1@r1530_*)")
    ap.add_argument("--static", action="append", default=[], help="an export whose frames do not move in time: no id switches from it")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--stride", type=int, default=1)
    ap.add_argument("--out", default="cctv_detector.calibrated.json")
    a = ap.parse_args()
    device = pick_device(a.device)
    totals: dict = defaultdict(list)
    fp = frames = switches = 0
    track_seconds = 0.0
    used = []
    static = {Path(x).resolve() for x in a.static}
    for spec in a.runs:
        path, _, pattern = spec.partition("@") if "@" in spec[2:] else (spec, "", "")
        run = Path(path)
        fps = float(json.loads((run / "run.json").read_text(encoding="utf-8"))["fps"])
        names = sorted(p.name for p in run.iterdir() if (p / "coco.json").exists() and (not pattern or fnmatch.fnmatch(p.name, pattern)))
        moving = run.resolve() not in static
        for name in names:
            result = score_camera(run / name, FrameDetector(str(DEFAULT_WEIGHTS), device, 960, 0.25), fps, a.stride)
            for key in ("h", "vis", "hit", "jx", "jy", "jw", "jh"):
                totals[key] += result[key]
            fp += result["fp"]; frames += result["frames"]
            if moving:
                switches += result["switches"]; track_seconds += result["track_seconds"]
            used.append(f"{run.name}/{name}")
            print(f"{run.name}/{name}: {result['frames']} frames, {len(result['hit'])} labelled boxes, recall {np.mean(result['hit']) if result['hit'] else 0:.3f}, "
                  f"{result['fp']} false positives{'' if moving else ', static: no id switches'}", flush=True)
    if len(totals["hit"]) < 100:
        raise SystemExit(f"only {len(totals['hit'])} labelled boxes: not enough to calibrate, nothing written")
    params = fit_detector(np.array(totals["h"]), np.array(totals["vis"]), np.array(totals["hit"], dtype=float))
    params.update(jitter_xy=float(np.std(totals["jx"] + totals["jy"])), jitter_wh=float(np.std(totals["jw"] + totals["jh"])), fp_per_frame=fp / max(frames, 1),
                  id_switch_per_s=switches / track_seconds if track_seconds > 0 else 0.01, width_ratio=0.42,
                  about=f"Calibrated by vision/tools/calibrate_detector.py on {', '.join(used)}; YOLO11s COCO at 960 px, {device}. Box height = projected body.")
    Path(a.out).write_text(json.dumps(params, indent=1), encoding="utf-8")
    print(json.dumps(params, indent=1))


if __name__ == "__main__":
    main()

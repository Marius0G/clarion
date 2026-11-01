"""Send test `camera.frame` messages to the backend, without Unity or the vision service (SPEC-v2 contract).

    python tools/send_test_frames.py --dir <folder>      # JPEGs from a folder: one subfolder per camera, or files spread over --cameras
    python tools/send_test_frames.py --synthetic         # drawn frames with fake boxes (needs Pillow)

CLARION_URL (default http://127.0.0.1:8788) and DEMO_TOKEN come from the environment. The token is never printed.
It connects as client=vision, so it REPLACES a running vision service on that backend. Use it on a test worker, not during the demo.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import random
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from websockets.sync.client import connect

# The four overview cameras the vision service streams, with the queue each one watches best.
DEFAULT_CAMERAS = "cctv_security_queue=U_SECURITY_QUEUE,cctv_checkin_overview=check_in:1,cctv_hall_east=check_in:2,cctv_upper_4=U_SECURITY_QUEUE"
MAX_BYTES = 120_000
W, H = 960, 540


def cameras(spec: str) -> list[tuple[str, str | None]]:
    out = []
    for item in filter(None, (s.strip() for s in spec.split(","))):
        cam, _, zone = item.partition("=")
        out.append((cam, zone or None))
    return out[:4]


def fit(jpeg: bytes) -> bytes:
    """Re-encode to 960x540 and at most ~120 KB when Pillow is available; else send as is."""
    try:
        from PIL import Image
    except ImportError:
        return jpeg
    img = Image.open(io.BytesIO(jpeg)).convert("RGB")
    if img.size != (W, H):
        img = img.resize((W, H))
    for quality in (85, 75, 65, 55, 45):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality)
        if buf.tell() <= MAX_BYTES:
            break
    return buf.getvalue()


def drawn(camera: str, frame: int, sim_time: float) -> tuple[bytes, int]:
    """A synthetic frame: grey floor, a few person boxes that drift, the camera name and the sim clock."""
    from PIL import Image, ImageDraw
    rng = random.Random(sum(map(ord, camera)))
    n = 8 + int(6 * (1 + math.sin(frame / 15 + rng.random() * 6)))
    img = Image.new("RGB", (W, H), (178, 180, 176))
    d = ImageDraw.Draw(img)
    for i in range(0, W, 60):
        d.line([(i, H), (W / 2 + (i - W / 2) * 0.3, 160)], fill=(160, 162, 158))
    for i in range(n):
        x = (rng.uniform(80, W - 80) + frame * rng.uniform(-4, 4)) % (W - 60)
        y = rng.uniform(200, H - 120)
        s = 0.6 + (y - 200) / (H - 200)
        bw, bh = 36 * s, 96 * s
        d.rectangle([x, y, x + bw, y + bh], fill=(90, 96, 110))
        d.rectangle([x - 3, y - 3, x + bw + 3, y + bh + 3], outline=(0, 230, 90), width=2)
    clock = time.strftime("%H:%M:%S", time.gmtime(sim_time % 86400))
    d.rectangle([0, 0, W, 28], fill=(20, 22, 26))
    d.text((10, 8), f"{camera}  {clock}  person: {n}  (test frame)", fill=(240, 240, 240))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=70)
    return buf.getvalue(), n


def sim_time(url: str, token: str | None, fallback: float) -> float:
    """Unity's clock from GET /api/sim when it has one, else a local clock."""
    try:
        req = urllib.request.Request(url.rstrip("/") + "/api/sim", headers={"Authorization": f"Bearer {token}"} if token else {})
        with urllib.request.urlopen(req, timeout=2) as r:
            t = json.load(r).get("simTime")
            return float(t) if t is not None else fallback
    except Exception:
        return fallback


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--dir", type=Path, help="folder of JPEGs; subfolders named like a camera id feed that camera")
    src.add_argument("--synthetic", action="store_true", help="draw frames with fake boxes (Pillow)")
    ap.add_argument("--cameras", default=DEFAULT_CAMERAS, help="camera=zone,... (at most 4; zone may be empty)")
    ap.add_argument("--fps", type=float, default=1.0, help="frames per second per camera (the contract allows at most 1)")
    ap.add_argument("--seconds", type=float, default=0, help="stop after this many seconds (0 = until Ctrl+C)")
    ap.add_argument("--detector", choices=["yolo", "simulated"], default="simulated")
    args = ap.parse_args()

    url = os.environ.get("CLARION_URL", "http://127.0.0.1:8788")
    token = os.environ.get("DEMO_TOKEN")
    parts = urllib.parse.urlsplit(url)
    query = "client=vision" + (f"&token={urllib.parse.quote(token)}" if token else "")
    ws_url = urllib.parse.urlunsplit(("wss" if parts.scheme == "https" else "ws", parts.netloc, "/ws", query, ""))

    cams = cameras(args.cameras)
    feeds: dict[str, list[Path]] = {}
    if args.dir:
        subdirs = {p.name: p for p in args.dir.iterdir() if p.is_dir()}
        loose = sorted(args.dir.glob("*.jp*g"))
        for i, (cam, _) in enumerate(cams):
            files = sorted(subdirs[cam].glob("*.jp*g")) if cam in subdirs else loose[i::len(cams)] or loose
            if not files:
                print(f"no JPEGs for {cam} in {args.dir}", file=sys.stderr)
                return 1
            feeds[cam] = files

    print(f"sending {len(cams)} camera(s) to {url} as client=vision ({'synthetic' if args.synthetic else args.dir}); Ctrl+C stops")
    period = 1.0 / max(0.01, min(args.fps, 1.0))
    started, frame, local_t = time.monotonic(), 0, 15 * 3600.0
    with connect(ws_url, max_size=8 * 1024 * 1024, open_timeout=10) as ws:
        while not args.seconds or time.monotonic() - started < args.seconds:
            tick = time.monotonic()
            t = sim_time(url, token, local_t + frame * period)
            for cam, zone in cams:
                if args.synthetic:
                    jpeg, count = drawn(cam, frame, t)
                else:
                    files = feeds[cam]
                    jpeg, count = fit(files[frame % len(files)].read_bytes()), 0
                    side = files[frame % len(files)].with_suffix(".json")
                    if side.exists():
                        count = int(json.loads(side.read_text()).get("count", 0))
                data = {"camera": cam, "zone": zone, "simTime": t, "w": W, "h": H, "jpeg": base64.b64encode(jpeg).decode("ascii"),
                        "count": count, "detector": args.detector}
                ws.send(json.dumps({"type": "camera.frame", "ts": datetime.now(timezone.utc).isoformat(), "data": data}))
            while True:     # print the backend's errors, skip the rest (state, ops.command...)
                try:
                    msg = json.loads(ws.recv(timeout=0))
                except TimeoutError:
                    break
                if msg.get("type") == "error":
                    print("backend error:", msg.get("data", {}).get("message"), file=sys.stderr)
            frame += 1
            if frame % 10 == 0:
                print(f"{frame} rounds sent, simTime {t:.0f}")
            time.sleep(max(0.0, period - (time.monotonic() - tick)))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)

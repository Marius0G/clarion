"""Copies what tests and the synthetic source need from Unity's data to data/: cameras, queue rings, queue paths.
Run after a re-aim, from vision/. At runtime --source live and yolo read the channel's own cctv.json, not this."""
import json

from clarion_vision.config import DATA_DIR, UNITY_REPO

airport = UNITY_REPO / "data" / "processed" / "unity" / "airport"
cctv = json.loads((airport / "cctv.json").read_text(encoding="utf-8"))
nav = json.loads((airport / "t2_nav.json").read_text(encoding="utf-8"))
keep = ("id", "kind", "level", "position", "yaw", "pitch", "hfov", "width", "height", "fps", "view_region", "queues_seen", "queue", "vis")
cameras = [{k: c.get(k) for k in keep} for c in cctv["cameras"]]
out = {"floors": cctv["floors"], "queues": cctv["queues"], "cameras": cameras}
(DATA_DIR / "cctv_snapshot.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
queues = {q["id"]: {k: q[k] for k in ("polyline", "head", "spacing", "service", "level")} for q in nav["queues"]}
(DATA_DIR / "nav_queues_snapshot.json").write_text(json.dumps(queues, separators=(",", ":")), encoding="utf-8")
for c in cameras:
    if "security" in {q["queue"] for q in c.get("queues_seen") or []}:
        print(c["id"], [round(q["coverage"], 2) for q in c["queues_seen"] if q["queue"] == "security"])

"""Plays a recorded Unity run (a folder from ClarionRun: manifest.json, cctv.json, <camera>/calib.json, detlog.jsonl) into a live
directory as CctvLive.cs writes it live, so `--source live` can be tested on Unity's own files with Unity off. Only camera files
are copied: the run's truth stays where it is. A test tool: what it plays did not happen now, so it is never the demo's input.
    python tools/replay_live.py <run dir> <live dir> [--speed 10] [--hz 2] [--from-s 0]"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from pathlib import Path


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    for _ in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:      # the reader has it open (Windows)
            time.sleep(0.01)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("run")
    ap.add_argument("live")
    ap.add_argument("--speed", type=float, default=10.0, help="sim seconds per real second")
    ap.add_argument("--hz", type=float, default=2.0, help="detections.json writes per real second, as CctvLive's det_hz")
    ap.add_argument("--from-s", type=float, default=0.0, help="skip this many sim seconds from the start of the log")
    ap.add_argument("--log", action="store_true", help="also append every tick to <live>/detlog_live.jsonl, as CctvLive with a det log")
    a = ap.parse_args()
    run, live = Path(a.run), Path(a.live)
    live.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
    for camera in manifest.get("cameras") or []:
        if (run / camera / "calib.json").exists():
            (live / camera).mkdir(exist_ok=True)
            shutil.copyfile(run / camera / "calib.json", live / camera / "calib.json")
    shutil.copyfile(run / "cctv.json", live / "cctv.json")
    write_atomic(live / "manifest.json", json.dumps(manifest))
    period = 1.0 / max(a.hz, 0.1)
    start_wall, start_sim, next_write, seq = None, None, 0.0, 0
    log = open(live / "detlog_live.jsonl", "a", encoding="utf-8") if a.log else None
    with open(run / "detlog.jsonl", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            t = float(row["t_s"])
            if start_sim is None:
                start_sim = t + a.from_s
            if t < start_sim:
                continue
            if start_wall is None:
                start_wall = time.monotonic()
                next_write = start_wall
            due = start_wall + (t - start_sim) / a.speed
            if log is None and due < next_write:            # one write per period, like CctvLive: the ticks in between are skipped
                continue
            wait = due - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            if log is not None:
                log.write(line if line.endswith("\n") else line + "\n")
                log.flush()
                if due < next_write:
                    continue
            seq += 1
            row["seq"], row["speed"] = seq, a.speed
            write_atomic(live / "detections.json", json.dumps(row))
            next_write = due + period
    print(f"replayed to {live}: {seq} ticks", flush=True)


if __name__ == "__main__":
    main()

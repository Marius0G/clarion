"""Offline check of a live run: polls GET /api/sim and logs what vision sent (flow) next to Unity's truth.report, the numbers the
accuracy panel (D16) shows. Truth stays in this tool, which the service never imports (D0). Ctrl+C prints the summary.
    python tools/watch_live.py [--out runs/watch_<time>.jsonl] [--zones U_SECURITY_QUEUE,check_in:1] [--period 2]
    python tools/watch_live.py --summary runs/watch_<time>.jsonl"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import httpx

URL = os.environ.get("CLARION_URL", "http://127.0.0.1:8788").rstrip("/")


def summary(path: Path, zones: list[str]) -> None:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    print(f"{path}: {len(rows)} samples")
    for zone in zones:
        pairs = [(r["flow"].get(zone), r["truth"].get(zone)) for r in rows if r["flow"].get(zone) and r["truth"].get(zone)]
        pairs = [(f, t) for f, t in pairs if not f.get("stale")]
        if not pairs:
            print(f"  {zone}: no samples with both vision and truth")
            continue
        n_err = [abs(f["waiting"] - t["waiting"]) for f, t in pairs if t.get("waiting") is not None]
        w_err = [abs(f["waitMin"] - t["waitMin"]) for f, t in pairs if t.get("waitMin") is not None and f.get("waitMin") is not None]
        true_n = [t["waiting"] for _, t in pairs if t.get("waiting") is not None]
        print(f"  {zone}: {len(pairs)} samples, true queue mean {sum(true_n) / max(len(true_n), 1):.1f} (max {max(true_n, default=0)}), "
              f"count MAE {sum(n_err) / max(len(n_err), 1):.1f} people, wait MAE vs panel {sum(w_err) / max(len(w_err), 1):.2f} min")
    print("  the panel's waitMin is the mean of those finishing now, so it lags a changing queue (RESULTS.md)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=f"runs/watch_{time.strftime('%H%M%S')}.jsonl")
    ap.add_argument("--zones", default="U_SECURITY_QUEUE,check_in:1,check_in:2,check_in:3,G_CHECKIN_QUEUE")
    ap.add_argument("--period", type=float, default=2.0)
    ap.add_argument("--summary", default=None)
    a = ap.parse_args()
    zones = a.zones.split(",")
    if a.summary:
        summary(Path(a.summary), zones)
        return
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"watching {URL} -> {out}", flush=True)
    try:
        with httpx.Client(base_url=URL, timeout=5.0, trust_env=False) as client, open(out, "a", encoding="utf-8") as handle:
            last_t = None
            while True:
                try:
                    sim = client.get("/api/sim").json()
                except (httpx.HTTPError, ValueError):
                    time.sleep(a.period)
                    continue
                t = sim.get("simTime")
                if t is not None and t != last_t:
                    last_t = t
                    truth = ((sim.get("truth") or {}).get("zones") or {})
                    flow = sim.get("flow") or {}
                    keep = ("waiting", "waitingSd", "waitMin", "waitMinP90", "forecast", "advice", "coverage", "stale")
                    handle.write(json.dumps({"wall": time.time(), "simTime": t, "speed": sim.get("speed"), "vision": sim.get("vision"),
                                             "lanes": sim.get("lanes"), "blocked": sim.get("blocked"), "metrics": sim.get("metrics"), "flights": sim.get("flights"),
                                             "flow": {z: {k: flow[z].get(k) for k in keep} for z in zones if z in flow},
                                             "truth": {z: truth[z] for z in zones if z in truth}}) + "\n")
                    handle.flush()
                time.sleep(a.period)
    except KeyboardInterrupt:
        pass
    summary(out, zones)


if __name__ == "__main__":
    main()

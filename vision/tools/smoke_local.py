"""End-to-end check against a running worker, with a fake Unity and the synthetic camera source. Prints what the worker accepted.
    (worker/) npm run dev -- --ip 127.0.0.1 --port 8799 --var DEMO_TOKEN:local-smoke --var SIM_SPEED:10
    (vision/) CLARION_URL=http://127.0.0.1:8799 DEMO_TOKEN=local-smoke python tools/smoke_local.py
    SMOKE_SOURCE=replay SMOKE_RUN=<a ClarionRun folder> python tools/smoke_local.py   (Unity's own camera files, replayed)
Exits nonzero when a check fails. Use an isolated worker: it mutates telemetry and the command history."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

VISION = Path(__file__).resolve().parents[1]
URL = os.environ.get("CLARION_URL", "http://127.0.0.1:8799").rstrip("/")
TOKEN = os.environ.get("DEMO_TOKEN", "")
failures: list[str] = []


def check(name: str, ok: bool, detail="") -> None:
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail != "" else ""), flush=True)
    if not ok:
        failures.append(name)


def api(client: httpx.Client, path: str, body=None):
    if body is None:
        return client.get(path)
    return client.post(path, json=body, headers={"Authorization": f"Bearer {TOKEN}"})


def wait_for(client, predicate, seconds=20.0):
    end = time.time() + seconds
    sim = None
    while time.time() < end:
        sim = api(client, "/api/sim").json()
        if predicate(sim):
            return sim
        time.sleep(0.5)
    return sim


def main() -> int:
    env = {**os.environ, "CLARION_URL": URL, "DEMO_TOKEN": TOKEN, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "PYTHONPATH": str(VISION)}
    twin_log = open(VISION / "smoke_twin.log", "w", encoding="utf-8")
    vision_log = open(VISION / "smoke_vision.log", "w", encoding="utf-8")
    twin = subprocess.Popen([sys.executable, "tools/fake_twin.py"], cwd=VISION, env=env, stdout=twin_log, stderr=subprocess.STDOUT)
    source = os.environ.get("SMOKE_SOURCE", "synthetic")
    channel = None
    arguments = ["--source", source]
    if source == "live":                 # the same camera files Unity writes, from the synthetic airport
        tmp = tempfile.mkdtemp(prefix="cctv_live_")
        channel = subprocess.Popen([sys.executable, "tools/fake_cctv_live.py", tmp], cwd=VISION, env=env, stdout=subprocess.DEVNULL)
        arguments += ["--live-dir", tmp]
    elif source == "replay":             # Unity's own camera files, from a recorded run (SMOKE_RUN), through --source live
        tmp = tempfile.mkdtemp(prefix="cctv_replay_")
        run = os.environ["SMOKE_RUN"]
        channel = subprocess.Popen([sys.executable, "tools/replay_live.py", run, tmp, "--speed", "10", "--from-s", os.environ.get("SMOKE_FROM_S", "0")],
                                   cwd=VISION, env=env, stdout=subprocess.DEVNULL)
        arguments = ["--source", "live", "--live-dir", tmp]
    vision = subprocess.Popen([sys.executable, "-m", "clarion_vision.service", *arguments], cwd=VISION, env=env, stdout=vision_log, stderr=subprocess.STDOUT)
    try:
        with httpx.Client(base_url=URL, timeout=5.0, trust_env=False) as client:
            sim = wait_for(client, lambda s: s.get("vision") and s.get("connected") and s.get("flow"), 40.0)
            check("twin and vision connected, flow.report accepted", bool(sim.get("vision") and sim.get("connected") and sim.get("flow")), f"{len(sim.get('flow') or {})} zones")
            time.sleep(5)
            sim = api(client, "/api/sim").json()
            flow = sim["flow"]
            row = flow.get("U_SECURITY_QUEUE") or {}
            print("flow.U_SECURITY_QUEUE =", json.dumps(row))
            check("row carries the contract fields", all(row.get(k) is not None for k in ("waiting", "waitingSd", "density", "waitMin", "waitMinP90", "coverage", "forecast")))
            check("forecast at 30/60/90/120", [f["inMin"] for f in row.get("forecast") or []] == [30, 60, 90, 120])
            check("rows are fresh, source vision", row.get("source") == "vision" and row.get("stale") is False)
            check("check-in group rows", "check_in:1" in flow, sorted(z for z in flow if z.startswith("check_in")))
            check("no bag_drop rows (Unity has one queue per group)", not any(z.startswith("bag_drop") for z in flow))
            people = (sim.get("positions") or {}).get("people") or []
            check("crowd.positions accepted", len(people) > 0, f"{len(people)} people, first {people[:1]}")

            wait_before = row.get("waitMin")
            r = api(client, "/api/ops/command", {"type": "staff", "zone": "security", "delta": 1})
            check("staff command sent", r.status_code == 202, r.status_code)
            time.sleep(3)
            sim = api(client, "/api/sim").json()
            after = sim["flow"]["U_SECURITY_QUEUE"]
            check("wait reacts to the new lane", wait_before == 0 or after["waitMin"] < wait_before * 1.2, f"{wait_before} -> {after['waitMin']}, waiting {after['waiting']}")

            started = time.time()
            r = api(client, "/api/ops/command", {"type": "evacuate", "zones": ["G_CHECKIN_QUEUE"]})
            check("evacuate command sent", r.status_code == 202, r.status_code)
            time.sleep(4)
            twin_lines = (VISION / "smoke_twin.log").read_text(encoding="utf-8").splitlines()
            routes = [l for l in twin_lines if l.startswith("TWIN agent.route")]
            check("evac.plan reached the simulated subscriber as agent.route", bool(routes), routes[-1][:220] if routes else "")
            evac_messages = [l for l in twin_lines if "agent.message" in l and '"evacuate"' in l]
            check("subscriber got the evacuation message", bool(evac_messages), evac_messages[-1][:240] if evac_messages else "")
            sim = api(client, "/api/sim").json()
            check("backend holds the blocked zone", "G_CHECKIN_QUEUE" in (sim.get("blocked") or []), sim.get("blocked"))
            check("no truth or token in the logs", TOKEN == "" or TOKEN not in (VISION / "smoke_vision.log").read_text(encoding="utf-8"))
    finally:
        vision.terminate()
        twin.terminate()
        vision.wait(10)
        twin.wait(10)
        if channel:
            channel.terminate()
            channel.wait(10)
        twin_log.close()
        vision_log.close()
    log = (VISION / "smoke_vision.log").read_text(encoding="utf-8")
    plan_lines = [l for l in log.splitlines() if "evac.plan" in l]
    print("\n".join(plan_lines[-2:]))
    check("evac.plan answered within 2 s", any(_ms(l) is not None and _ms(l) < 2000 for l in plan_lines))
    rejected = [l for l in log.splitlines() if "backend rejected" in l]
    check("the backend rejected nothing", not rejected, rejected[:3] if rejected else "")
    print(f"\n{'ALL PASS' if not failures else 'FAILED: ' + ', '.join(failures)}")
    return 1 if failures else 0


def _ms(line: str) -> float | None:
    import re
    m = re.search(r" in (\d+) ms", line)
    return float(m[1]) if m else None


if __name__ == "__main__":
    sys.exit(main())

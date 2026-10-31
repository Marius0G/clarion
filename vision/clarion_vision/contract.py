"""Vision -> backend messages. The validators mirror backend/src/sim.ts (flow, positions) and worker/src/wa/messaging.ts
(evacPlan), so a bad row fails in tests here instead of the backend rejecting the whole batch (contract: one invalid row
drops the message)."""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone

from .mapids import is_node_id

ZONES_MAX, FORECAST_MAX, PEOPLE_MAX, ROUTES_MAX, ROUTE_NODES_MAX, EXITS_MAX = 64, 12, 2000, 500, 200, 50
DENSITY_MAX, LANES_MAX = 20.0, 50
PAYLOAD_MAX = 1_048_576


def _finite(v, lo=0.0, hi=math.inf) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and lo <= v <= hi


def envelope(kind: str, data: dict) -> str:
    ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    text = json.dumps({"type": kind, "ts": ts, "data": data}, separators=(",", ":"), allow_nan=False)
    if len(text.encode("utf-8")) > PAYLOAD_MAX:
        raise ValueError(f"{kind} exceeds the 1 MiB socket limit")
    return text


def flow_row(zone: str, waiting: float, sd: float | None = None, density: float | None = None, wait_min: float | None = None,
             wait_p90: float | None = None, coverage: float | None = None, forecast: list[dict] | None = None,
             advice: dict | None = None) -> dict:
    """One flow.report row, rounded and clamped to what the backend accepts. Unknown fields are left out, never guessed."""
    row: dict = {"zone": zone, "waiting": max(0, int(round(waiting)))}
    if sd is not None:
        row["waitingSd"] = round(max(0.0, sd), 2)
    if density is not None:
        row["density"] = round(min(DENSITY_MAX, max(0.0, density)), 3)
    if wait_min is not None:
        row["waitMin"] = round(max(0.0, wait_min), 2)
    if wait_p90 is not None:
        row["waitMinP90"] = round(max(0.0, wait_p90), 2)
    if coverage is not None:
        row["coverage"] = round(min(1.0, max(0.0, coverage)), 3)
    if forecast is not None:
        row["forecast"] = forecast
    if advice is not None:
        row["advice"] = advice
    return row


def check_flow(data: dict) -> None:
    zones = data.get("zones")
    if not isinstance(zones, list) or not 1 <= len(zones) <= ZONES_MAX:
        raise ValueError("zones[] required (1-64)")
    seen = set()
    for z in zones:
        if not is_node_id(z.get("zone")) or z["zone"] in seen:
            raise ValueError(f"bad zone id {z.get('zone')!r}")
        seen.add(z["zone"])
        if not isinstance(z.get("waiting"), int) or isinstance(z["waiting"], bool) or z["waiting"] < 0:
            raise ValueError(f"bad waiting in {z['zone']}")
        for k in ("waitMin", "waitMinP90", "waitingSd"):
            if k in z and not _finite(z[k]):
                raise ValueError(f"bad {k} in {z['zone']}")
        if "coverage" in z and not _finite(z["coverage"], 0, 1):
            raise ValueError(f"bad coverage in {z['zone']}")
        if "density" in z and not _finite(z["density"], 0, DENSITY_MAX):
            raise ValueError(f"bad density in {z['zone']}")
        fc = z.get("forecast")
        if fc is not None and (not isinstance(fc, list) or len(fc) > FORECAST_MAX or
                               not all(_finite(f.get("inMin"), 0, 1440) and _finite(f.get("waitMin")) for f in fc)):
            raise ValueError(f"bad forecast in {z['zone']}")
        adv = z.get("advice")
        if adv is not None:
            lanes, by, wait = adv.get("lanes"), adv.get("by"), adv.get("waitMinIfNot")
            if (lanes is not None and (not isinstance(lanes, int) or not 0 <= lanes <= LANES_MAX)) or \
                    (by is not None and not _finite(by)) or (wait is not None and not _finite(wait)):
                raise ValueError(f"bad advice in {z['zone']}")


def check_positions(data: dict) -> None:
    people = data.get("people")
    if not isinstance(people, list) or len(people) > PEOPLE_MAX:
        raise ValueError("people[] required (max 2000)")
    for p in people:
        if not _finite(p.get("x"), -1e5, 1e5) or not _finite(p.get("z"), -1e5, 1e5) or p.get("level") not in ("G", "U", "X"):
            raise ValueError("bad person")


def check_evac(data: dict) -> None:
    ok = isinstance(data.get("id"), str) and 0 < len(data["id"]) <= 100 and \
        isinstance(data.get("blocked"), list) and len(data["blocked"]) <= 50 and all(is_node_id(b) for b in data["blocked"]) and \
        _finite(data.get("clearSec")) and isinstance(data.get("exits"), list) and len(data["exits"]) <= EXITS_MAX and \
        all(is_node_id(e.get("exit")) and isinstance(e.get("people"), int) and e["people"] >= 0 and _finite(e.get("clearSec")) for e in data["exits"]) and \
        isinstance(data.get("routes"), list) and 1 <= len(data["routes"]) <= ROUTES_MAX and \
        all(is_node_id(r.get("from")) and is_node_id(r.get("exit")) and isinstance(r.get("nodes"), list) and
            1 <= len(r["nodes"]) <= ROUTE_NODES_MAX and all(is_node_id(n) for n in r["nodes"]) for r in data["routes"])
    if not ok:
        raise ValueError("Invalid evac plan")


def flow_report(rows: list[dict]) -> str:
    data = {"zones": rows}
    check_flow(data)
    return envelope("flow.report", data)


def crowd_positions(people: list[dict]) -> str:
    data = {"people": people[:PEOPLE_MAX]}
    check_positions(data)
    return envelope("crowd.positions", data)


def evac_plan(data: dict) -> str:
    check_evac(data)
    return envelope("evac.plan", data)

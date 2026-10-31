"""The terminal: zone polygons from docs/contract/map/zones.json (D26), the walk graph, door and stair widths and the start
lanes from docs/contract/terminal.json (Unity's pipeline/scripts/terminal_export.py; ids stay when it is regenerated)."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .config import MAP_DIR, TERMINAL_JSON


@dataclass
class Zone:
    id: str
    level: str
    kind: str
    side: str
    area_m2: float
    polygons: list[tuple[np.ndarray, list[np.ndarray]]]   # (outer ring, holes), world x,z


@dataclass
class Node:
    id: str
    kind: str
    x: float
    z: float
    level: str | None
    zone: str | None
    width_m: float | None = None


@dataclass
class Edge:
    a: str
    b: str
    walk_s: float
    one_way: bool = False
    evacuation_only: bool = False
    inferred: bool = False
    width_m: float | None = None


@dataclass
class Terminal:
    zones: dict[str, Zone]
    nodes: dict[str, Node]
    edges: list[Edge]
    door_width_m: dict[str, float]
    exits: list[str]
    initial_lanes: dict[str, int] = field(default_factory=dict)
    lane_limits: dict[str, dict] = field(default_factory=dict)
    source: str = ""


def load_terminal(map_dir: Path = MAP_DIR, terminal_json: Path = TERMINAL_JSON) -> Terminal:
    zone_data = json.loads((map_dir / "zones.json").read_text(encoding="utf-8"))
    zones = {}
    for z in zone_data["zones"]:
        polys = [(np.asarray(p["outer"], dtype=float), [np.asarray(h, dtype=float) for h in p.get("holes", [])]) for p in z["polygons_world"]]
        zones[z["id"]] = Zone(z["id"], z["level"], z["kind"], z.get("side", ""), float(z["area_m2"]), polys)
    plan = json.loads(terminal_json.read_text(encoding="utf-8"))
    nodes = {n["id"]: Node(n["id"], n.get("kind", "circulation"), float(n.get("x", 0.0)), float(n.get("y", 0.0)), n.get("level"), n.get("zone"), n.get("widthM"))
             for n in plan["nodes"]}
    edges = [Edge(e["from"], e["to"], float(e.get("walkSec", 0.0)), bool(e.get("oneWay")), bool(e.get("evacuationOnly")),
                  bool(e.get("inferred")), e.get("widthM")) for e in plan["edges"] if e["from"] in nodes and e["to"] in nodes]
    # Doors are the exits. The ASSEMBLY_* zones are kind "exit" too, but they lie outside, behind the doors.
    exits = [n.id for n in nodes.values() if n.kind == "exit" and n.id.startswith("door_")]
    doors = {d: float(nodes[d].width_m or 1.8) for d in exits}
    return Terminal(zones, nodes, edges, doors, exits, dict(plan.get("initialLanes") or {}), dict(plan.get("lanes") or {}),
                    f"{terminal_json.name} {plan.get('version', '')}")

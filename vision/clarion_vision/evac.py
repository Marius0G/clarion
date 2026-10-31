"""A9 + A10. Evacuation: a maximum flow over time on the terminal graph (time-expanded, 5 s step).

A9: doors pass at most 1.3 people/s per metre (SFPE); sources are the people estimated per zone at the alarm plus a reaction
time. The smallest horizon whose max flow carries everyone is the time to clear. A min-sum flow at that horizon then gives
who leaves through which door and when (min-sum flows arrive as early as possible; a bare max flow may dawdle up to the
horizon). A10: every node gets the route to the exit its zone's flow chose, with blocked zones removed. Blocked zones keep
their way out: nobody may enter one, but those inside may leave through it. Target: under 2 s in total.

Pure: takes numbers, returns numbers. Times in seconds."""
from __future__ import annotations

import heapq
import math
import time
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linprog
from scipy.sparse import coo_array, csr_array
from scipy.sparse.csgraph import maximum_flow

from .mapids import is_whole_terminal, map_node_id
from .terminal import Terminal

DOOR_FLOW = 1.3        # people / s / m, SFPE (A9)
STAIR_FLOW = 1.0       # people / s / m
UNITS = 10             # capacities are integers: 1 unit = 0.1 people
FREE_SPEED = 1.34
MIN_SPEED = 0.2
HORIZON_MAX_S = 3600.0
INDOOR = ("G", "U")
# Pre-movement, (from s, to s, share of people), read from Unity's rules (EvacReaction): calm 15-35 s, grabbing bags 30-60 s, filming 50-100 s,
# regrouping 60-120 s, which every party of 3 or more does. The shares are a first reading, to re-fit on the evacuation runs.
REACTION_PROFILE = ((15.0, 35.0, 0.40), (30.0, 60.0, 0.15), (50.0, 100.0, 0.10), (60.0, 120.0, 0.35))
REACTION_MEAN_S = sum(w * (a + b) / 2.0 for a, b, w in REACTION_PROFILE)


def walking_speed(density: float | None) -> float:
    """A8, Weidmann. Evacuation never fully stops: a jam still moves at MIN_SPEED."""
    if not density or density <= 1e-9:
        return FREE_SPEED
    if density >= 5.4:
        return MIN_SPEED
    return max(MIN_SPEED, FREE_SPEED * -math.expm1(-1.913 * (1 / density - 1 / 5.4)))


@dataclass
class EvacPlanResult:
    clear_s: float
    t90_s: float
    people: float
    exits: list[dict]
    routes: list[dict]
    blocked: list[str]
    zone_clear_s: dict[str, float] = field(default_factory=dict)
    unreachable: dict[str, float] = field(default_factory=dict)
    no_route: list[str] = field(default_factory=list)
    allocator: str = "flow"
    solve_ms: float = 0.0
    people_estimated: float = 0.0

    def to_contract(self, command_id: str) -> dict:
        """The contract's fields, plus how much of the crowd no camera saw: `partlyEstimated`, `peopleSeen`, `peopleEstimated`."""
        return {"id": command_id, "blocked": self.blocked, "clearSec": round(self.clear_s, 1),
                "exits": [{"exit": e["exit"], "people": int(round(e["people"])), "clearSec": round(e["clear_s"], 1)} for e in self.exits],
                "routes": self.routes, "partlyEstimated": self.people_estimated > 0.5,
                "peopleSeen": int(round(self.people - self.people_estimated)), "peopleEstimated": int(round(self.people_estimated))}


def blocked_nodes(terminal: Terminal, blocked: list[str]) -> set[str]:
    """Nodes inside the blocked zones. A desk group blocks its group node and desks, not the whole check-in hall. A whole-terminal
    alarm blocks nothing in particular: everybody leaves, by any door."""
    if is_whole_terminal(blocked):
        return set()
    canon = {map_node_id(b) for b in blocked} | set(blocked)
    out = {n.id for n in terminal.nodes.values() if n.id in canon or (n.zone in canon)}
    for e in terminal.edges:
        for a, b in ((e.a, e.b), (e.b, e.a)):
            if a in canon and a.startswith("check_in:") and b.startswith("checkin_"):
                out.add(b)
    return out


class Graph:
    """Directed walkable arcs for evacuation: no lifts, nothing outdoors, no leaving an open exit. Each side keeps its own doors, as
    in Unity: the public side does not leave through the checkpoint and across the apron, unless that is the only way out."""

    def __init__(self, terminal: Terminal, blocked: set[str], density: dict[str, float] | None, open_blocked_doors: bool = False, cross_sides: bool = False):
        density = density or {}
        self.terminal = terminal
        self.blocked = blocked
        self.exits = [e for e in terminal.exits if open_blocked_doors or e not in blocked]
        self.exit_set = set(self.exits)
        nodes = terminal.nodes
        self.arcs: list[tuple[str, str, float, float]] = []    # from, to, seconds, people/s
        speed_at = lambda n: walking_speed(max(density.get(n.id, 0.0), density.get(n.zone or "", 0.0)))
        for e in terminal.edges:
            a, b = nodes[e.a], nodes[e.b]
            if a.level not in INDOOR or b.level not in INDOOR or a.kind == "lift" or b.kind == "lift":
                continue
            if not cross_sides and self._side(a) != self._side(b):
                continue
            seconds = e.walk_s * FREE_SPEED / min(speed_at(a), speed_at(b))
            capacity = self._capacity(e, a, b)
            for u, v in ((e.a, e.b),) if e.one_way else ((e.a, e.b), (e.b, e.a)):
                if u in self.exit_set:
                    continue                                   # an exit absorbs
                if v in blocked and u not in blocked:
                    continue                                   # nobody walks into a blocked zone
                self.arcs.append((u, v, seconds, capacity))

    def _side(self, node) -> str:
        zone = self.terminal.zones.get(node.zone or "")
        return zone.side if zone else ""

    def _capacity(self, e, a, b) -> float:
        t = self.terminal
        if a.level != b.level:                                 # a flight of stairs, _G to _U
            return STAIR_FLOW * (e.width_m or a.width_m or b.width_m or 1.8)
        if e.width_m:
            return DOOR_FLOW * e.width_m
        if a.id in t.door_width_m or b.id in t.door_width_m:
            return DOOR_FLOW * t.door_width_m.get(a.id, t.door_width_m.get(b.id, 1.8))
        # No corridor widths in the data: a zone's width is taken as the side of a square of its area, clamped.
        widths = [min(10.0, max(2.0, math.sqrt(t.zones[z].area_m2))) for z in (a.zone, b.zone) if z in t.zones]
        return DOOR_FLOW * (min(widths) if widths else 4.0)

    def reverse_tree(self, exit_id: str) -> tuple[dict[str, float], dict[str, str]]:
        """Dijkstra to one exit over the reversed arcs: seconds to it, and the next node on the way, from every node."""
        incoming: dict[str, list[tuple[str, float]]] = {}
        for u, v, s, _ in self.arcs:
            incoming.setdefault(v, []).append((u, s))
        dist, nxt = {exit_id: 0.0}, {}
        heap = [(0.0, exit_id)]
        while heap:
            d, v = heapq.heappop(heap)
            if d > dist.get(v, math.inf):
                continue
            for u, s in incoming.get(v, ()):
                if d + s < dist.get(u, math.inf):
                    dist[u], nxt[u] = d + s, v
                    heapq.heappush(heap, (d + s, u))
        return dist, nxt


@dataclass
class _Expanded:
    capacity: csr_array
    tails: np.ndarray
    heads: np.ndarray
    caps: np.ndarray
    costs: np.ndarray
    n_vertices: int
    source: int
    sink: int


def _release_shares(supply: int, step_s: float) -> list[tuple[int, int]]:
    """When a zone's people start to move: (time step, units), summing exactly to the supply. Uniform inside each reaction's range."""
    edges = {}
    for lo, hi, weight in REACTION_PROFILE:
        for k in range(int(lo // step_s), int(math.ceil(hi / step_s))):
            overlap = max(0.0, min(hi, (k + 1) * step_s) - max(lo, k * step_s))
            edges[k] = edges.get(k, 0.0) + weight * overlap / (hi - lo)
    steps = sorted(edges)
    exact = np.array([edges[k] for k in steps]) * supply / sum(edges.values())
    units = np.floor(exact).astype(int)
    for i in np.argsort(units - exact)[: supply - int(units.sum())]:
        units[i] += 1
    return [(k, int(u)) for k, u in zip(steps, units) if u > 0]


def _expand(graph: Graph, ids: dict[str, int], supplies: dict[str, int], steps: int, step_s: float, staged: bool = True) -> _Expanded:
    n, layer = len(ids), steps + 1
    total = sum(supplies.values()) + 1
    source, sink = n * layer, n * layer + 1
    tails, heads, caps, costs = [], [], [], []
    for u, v, seconds, people_per_s in graph.arcs:
        if u not in ids or v not in ids:
            continue
        tau = int(round(seconds / step_s))
        if tau > steps:
            continue
        cap = max(1, int(round(people_per_s * step_s * UNITS)))
        t = np.arange(0, layer - tau)
        tails.append(ids[u] * layer + t)
        heads.append(ids[v] * layer + t + tau)
        caps.append(np.full(t.size, cap))
        costs.append(np.full(t.size, 1e-3 * (tau + 1)))         # a small price on walking: no wandering in the min-sum flow
    for node, i in ids.items():
        t = np.arange(steps)
        tails.append(i * layer + t)
        heads.append(i * layer + t + 1)
        caps.append(np.full(t.size, total))
        costs.append(np.zeros(t.size))
    for door in graph.exits:
        if door not in ids:
            continue
        width = graph.terminal.door_width_m.get(door, 1.8)
        cap = max(1, int(round(DOOR_FLOW * width * step_s * UNITS)))
        t = np.arange(layer)
        tails.append(ids[door] * layer + t)
        heads.append(np.full(t.size, sink))
        caps.append(np.full(t.size, cap))
        costs.append(t.astype(float))                           # min-sum: the cost is the time of leaving
    for node, supply in supplies.items():
        for k, units in (_release_shares(supply, step_s) if staged else [(0, supply)]):
            tails.append(np.array([source]))
            heads.append(np.array([ids[node] * layer + min(k, steps)]))
            caps.append(np.array([units]))
            costs.append(np.zeros(1))
    tails, heads, caps, costs = map(np.concatenate, (tails, heads, caps, costs))
    size = n * layer + 2
    matrix = coo_array((caps.astype(np.int32), (tails.astype(np.int32), heads.astype(np.int32))), shape=(size, size)).tocsr()
    return _Expanded(matrix, tails, heads, caps, costs, size, source, sink)


def _max_flow_value(graph, ids, supplies, steps, step_s, staged) -> int:
    e = _expand(graph, ids, supplies, steps, step_s, staged)
    return int(maximum_flow(e.capacity, e.source, e.sink, method="dinic").flow_value)


def _min_steps(graph, ids, supplies, step_s, lower: int, staged: bool = True) -> int | None:
    """The smallest horizon whose max flow carries everyone: doubling, then bisection."""
    want = sum(supplies.values())
    limit = int(HORIZON_MAX_S / step_s)
    lo, hi = max(lower - 1, 0), max(lower, 1)
    while _max_flow_value(graph, ids, supplies, hi, step_s, staged) < want:
        lo, hi = hi, hi * 2
        if hi > limit:
            return None
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if _max_flow_value(graph, ids, supplies, mid, step_s, staged) >= want:
            hi = mid
        else:
            lo = mid
    return hi


def _min_sum(e: _Expanded, supplies: dict[str, int], ids: dict[str, int], layer: int, time_limit: float) -> np.ndarray | None:
    """Min-sum flow on the expanded graph (HiGHS). None when it runs out of time."""
    from scipy.sparse import csr_array as csr
    m = e.tails.size
    arcs = np.arange(m)
    rows = np.concatenate((e.tails, e.heads))
    cols = np.concatenate((arcs, arcs))
    vals = np.concatenate((np.ones(m), -np.ones(m)))
    A = csr((vals, (rows, cols)), shape=(e.n_vertices, m))
    b = np.zeros(e.n_vertices)
    total = sum(supplies.values())
    b[e.source], b[e.sink] = total, -total
    res = linprog(e.costs, A_eq=A, b_eq=b, bounds=np.column_stack((np.zeros(m), e.caps)), method="highs-ds",
                  options={"time_limit": time_limit, "presolve": True})
    return res.x if res.status == 0 else None


def _peel(e: _Expanded, flows: np.ndarray, ids: dict[str, int], layer: int):
    """Flow decomposition: (source node, exit node, units, leaving time step, step it left its source)."""
    names = {i: n for n, i in ids.items()}
    out: dict[int, list[list]] = {}
    for tail, head, f in zip(e.tails[flows > 1e-6], e.heads[flows > 1e-6], flows[flows > 1e-6]):
        out.setdefault(int(tail), []).append([int(head), float(f)])
    paths = []
    for first in out.get(e.source, []):
        start = first[0]
        node_name = names[start // layer]
        remaining = first[1]
        while remaining > 1e-6:
            path = []
            v, amount = start, remaining
            guard = 0
            while v != e.sink and guard < 100000:
                guard += 1
                arcs = out.get(v)
                while arcs and arcs[-1][1] <= 1e-6:
                    arcs.pop()
                if not arcs:
                    break
                arc = arcs[-1]
                amount = min(amount, arc[1])
                path.append(arc)
                v = arc[0]
            if v != e.sink:
                remaining = 0
                break
            for arc in path:
                arc[1] -= amount
            remaining -= amount
            prev = start
            left_at = None
            for arc in path:
                if arc[0] != e.sink and arc[0] // layer != prev // layer and left_at is None:
                    left_at = prev % layer
                if arc[0] == e.sink:
                    exit_vertex = prev
                prev = arc[0]
            paths.append((node_name, names[exit_vertex // layer], amount, exit_vertex % layer, left_at or 0))
    return paths


def _greedy(graph: Graph, sources: dict[str, float], trees: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
    """Fallback allocation when the min-sum solver runs out of time: biggest zone first, to the door that finishes it first."""
    load = {d: 0.0 for d in graph.exits}
    alloc: dict[str, dict[str, float]] = {}
    for zone, people in sorted(sources.items(), key=lambda kv: -kv[1]):
        best, best_finish = None, math.inf
        for door in graph.exits:
            walk = trees[door].get(zone)
            if walk is None:
                continue
            cap = DOOR_FLOW * graph.terminal.door_width_m.get(door, 1.8)
            finish = walk + (load[door] + people) / cap
            if finish < best_finish:
                best, best_finish = door, finish
        if best is not None:
            load[best] += people
            alloc.setdefault(zone, {})[best] = people
    return alloc


def plan_evacuation(terminal: Terminal, people: dict[str, float], blocked: list[str], density: dict[str, float] | None = None,
                    reaction_s: float | None = None, step_s: float = 5.0, min_sum_limit_s: float = 1.0, estimated: dict[str, float] | None = None) -> EvacPlanResult:
    """`people`: who has to leave, seen by the cameras. `estimated`: the same where they cannot see, kept apart so the plan can say how much of it
    is a guess. Routes are for every node all the same: anyone may ask. People start moving over REACTION_PROFILE; a fixed `reaction_s`
    instead moves everybody at once that many seconds after the alarm."""
    started = time.perf_counter()
    staged = reaction_s is None
    reaction_s = reaction_s or 0.0
    estimated = {z: n for z, n in (estimated or {}).items() if n > 0 and z in terminal.nodes and terminal.nodes[z].level in INDOOR and z not in people}
    people = {**people, **estimated}
    closed = blocked_nodes(terminal, blocked)
    graph = Graph(terminal, closed, density)
    trees = {d: graph.reverse_tree(d) for d in graph.exits}
    reachable = {d: t[0] for d, t in trees.items()}

    # A blocked source that no free exit can reach may use the doors of its own blocked zone (the only way out it has).
    sources = {z: float(n) for z, n in people.items() if n > 0 and z in terminal.nodes and terminal.nodes[z].level in INDOOR}
    # With no way out left on its own side, a source may cross; a blocked one may also use the doors of its own zone.
    for relaxed in ({"cross_sides": True}, {"cross_sides": True, "open_blocked_doors": True}):
        if all(any(z in reachable[d] for d in graph.exits) for z in sources):
            break
        graph = Graph(terminal, closed, density, **relaxed)
        trees = {d: graph.reverse_tree(d) for d in graph.exits}
        reachable = {d: t[0] for d, t in trees.items()}
    unreachable = {z: n for z, n in sources.items() if not any(z in reachable[d] for d in graph.exits)}
    for z in unreachable:
        del sources[z]

    alloc: dict[str, dict[str, float]] = {}
    exits_out: dict[str, dict] = {}
    zone_clear: dict[str, float] = {}
    clear_s = t90_s = 0.0
    allocator = "none"
    total_people = sum(sources.values())
    if sources:
        # The time-expanded graph only needs the sources, the exits and what lies on a shortest way between them.
        useful = set(sources)
        for door in graph.exits:
            nxt = trees[door][1]
            for zone in sources:
                cursor = zone
                while cursor in nxt:
                    cursor = nxt[cursor]
                    useful.add(cursor)
        ids = {n: i for i, n in enumerate(sorted(useful))}
        supplies = {z: max(1, int(round(n * UNITS))) for z, n in sources.items()}
        door_rate = sum(DOOR_FLOW * terminal.door_width_m.get(d, 1.8) for d in graph.exits if d in ids) or 1.0
        lower = int(max(total_people / door_rate, max(min(reachable[d].get(z, math.inf) for d in graph.exits) for z in sources)) / step_s)
        steps = _min_steps(graph, ids, supplies, step_s, max(lower, 1), staged)
        if steps is None:
            steps = int(HORIZON_MAX_S / step_s)
        clear_s = reaction_s + steps * step_s
        layer = steps + 1
        expanded = _expand(graph, ids, supplies, steps, step_s, staged)
        remaining = min_sum_limit_s - (time.perf_counter() - started)
        flows = _min_sum(expanded, supplies, ids, layer, max(remaining, 0.2))
        if flows is not None:
            allocator = "flow"
            arrivals: list[tuple[int, float]] = []
            for zone, door, units, leave_step, left_at in _peel(expanded, flows, ids, layer):
                n = units / UNITS
                alloc.setdefault(zone, {})
                alloc[zone][door] = alloc[zone].get(door, 0.0) + n
                row = exits_out.setdefault(door, {"exit": door, "people": 0.0, "clear_s": 0.0})
                row["people"] += n
                row["clear_s"] = max(row["clear_s"], reaction_s + leave_step * step_s)
                zone_clear[zone] = max(zone_clear.get(zone, 0.0), reaction_s + left_at * step_s)
                arrivals.append((leave_step, n))
            arrivals.sort()
            cum, target = 0.0, 0.9 * total_people
            t90_s = clear_s
            for step, n in arrivals:
                cum += n
                if cum >= target - 1e-6:
                    t90_s = reaction_s + step * step_s
                    break
        else:
            allocator = "greedy"
            alloc = _greedy(graph, sources, reachable)
            for zone, doors in alloc.items():
                for door, n in doors.items():
                    row = exits_out.setdefault(door, {"exit": door, "people": 0.0, "clear_s": 0.0})
                    row["people"] += n
            for door, row in exits_out.items():
                walk = max(reachable[door].get(z, 0.0) for z, ds in alloc.items() if door in ds)
                row["clear_s"] = (REACTION_MEAN_S if staged else reaction_s) + walk + row["people"] / (DOOR_FLOW * terminal.door_width_m.get(door, 1.8))
            clear_s = max(clear_s, max(r["clear_s"] for r in exits_out.values()))
            t90_s = clear_s

    routes, no_route = _routes(terminal, graph, trees, reachable, alloc, exits_out, closed)
    result = EvacPlanResult(clear_s, t90_s, total_people, sorted(exits_out.values(), key=lambda r: r["exit"]), routes, list(blocked),
                            zone_clear, unreachable, no_route, allocator)
    result.people_estimated = sum(n for z, n in estimated.items() if z in sources)
    result.solve_ms = (time.perf_counter() - started) * 1000.0
    return result


def _routes(terminal, graph, trees, reachable, alloc, exits_out, closed):
    """A route per indoor node. Nodes of a zone with people follow its largest share of the flow; every other node takes the
    exit that finishes first, given the doors' load."""
    routes, no_route = [], []
    load = {d: exits_out.get(d, {}).get("people", 0.0) for d in graph.exits}
    for node in terminal.nodes.values():
        if node.level not in INDOOR or node.kind == "lift":
            continue
        if node.id in graph.exit_set:
            routes.append({"from": node.id, "exit": node.id, "nodes": [node.id]})
            continue
        chosen = None
        share = alloc.get(node.zone or "") or alloc.get(node.id)
        if share:
            door = max(share, key=share.get)
            if node.id in reachable[door]:
                chosen = door
        if chosen is None:
            best = math.inf
            for door in graph.exits:
                walk = reachable[door].get(node.id)
                if walk is None:
                    continue
                finish = walk + load[door] / (DOOR_FLOW * terminal.door_width_m.get(door, 1.8))
                if finish < best:
                    best, chosen = finish, door
        if chosen is None:
            no_route.append(node.id)
            continue
        path, cursor = [node.id], node.id
        nxt = trees[chosen][1]
        while cursor != chosen and cursor in nxt and len(path) < 200:
            cursor = nxt[cursor]
            path.append(cursor)
        routes.append({"from": node.id, "exit": chosen, "nodes": path})
    return routes[:500], no_route

/** Pure D7/A8 routing. Edges are bidirectional; the denser endpoint zone determines their speed. */
export interface RoutingGraph {
  nodes: readonly { id: string; x: number; y: number; zone?: string }[];
  edges: readonly { from: string; to: string; lengthM?: number; walkSec?: number }[];
}
export interface Route { nodes: string[]; totalSec: number; segments: { from: string; to: string; sec: number }[] }
export const FREE_SPEED = 1.34;
/** Weidmann, people/m² → m/s. Unknown/empty is free flow; jam density is impassable. */
export function walkingSpeed(density: number | null | undefined): number {
  if (density == null || !Number.isFinite(density) || density <= 1e-9) return FREE_SPEED;
  if (density >= 5.4) return 0;
  return FREE_SPEED * -Math.expm1(-1.913 * (1 / density - 1 / 5.4));
}
export function route(graph: RoutingGraph, from: string, to: string,
  density: Readonly<Record<string, number | null | undefined>> = {}, blocked: readonly string[] = []): Route | null {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const closed = new Set(blocked);
  const passable = (id: string) => {
    const n = nodes.get(id);
    return n && !closed.has(id) && !(n.zone && closed.has(n.zone)) && walkingSpeed(density[n.zone ?? id]) > 0;
  };
  if (!passable(from) || !passable(to)) return null;
  const adjacency = new Map<string, { to: string; sec: number }[]>();
  for (const e of graph.edges) {
    if (!passable(e.from) || !passable(e.to)) continue;
    const a = nodes.get(e.from)!, b = nodes.get(e.to)!;
    const speed = Math.min(walkingSpeed(density[a.zone ?? a.id]), walkingSpeed(density[b.zone ?? b.id]));
    const sec = e.lengthM !== undefined ? e.lengthM / speed : e.walkSec !== undefined ? e.walkSec * FREE_SPEED / speed : Math.hypot(a.x - b.x, a.y - b.y) / speed;
    if (!Number.isFinite(sec) || sec < 0) continue;
    for (const [start, end] of [[e.from, e.to], [e.to, e.from]] as const) {
      const list = adjacency.get(start) ?? [];
      list.push({ to: end, sec }); adjacency.set(start, list);
    }
  }
  const dist = new Map<string, number>([[from, 0]]), visited = new Set<string>();
  const prev = new Map<string, { from: string; sec: number }>();
  while (true) {
    let next: string | undefined, best = Infinity;
    for (const [id, d] of dist) if (!visited.has(id) && d < best) { next = id; best = d; }
    if (next === undefined) return null;
    if (next === to) break;
    visited.add(next);
    for (const e of adjacency.get(next) ?? []) {
      const candidate = best + e.sec;
      if (candidate < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, candidate); prev.set(e.to, { from: next, sec: e.sec });
      }
    }
  }
  const segments: Route['segments'] = [];
  for (let id = to; id !== from;) {
    const p = prev.get(id)!;
    segments.push({ from: p.from, to: id, sec: p.sec }); id = p.from;
  }
  segments.reverse();
  return { nodes: [from, ...segments.map(s => s.to)], totalSec: dist.get(to)!, segments };
}

/** Density from camera telemetry, then waiting/zone area. Stale rows are unknown. */
export function zoneDensities(flow: Readonly<Record<string, { density?: number | null; waiting: number; stale?: boolean }>>,
  areas: Readonly<Record<string, number>> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, row] of Object.entries(flow)) {
    if (row.stale) continue;
    if (row.density != null && Number.isFinite(row.density) && row.density >= 0) out[id] = row.density;
    else if (Number.isFinite(row.waiting) && row.waiting >= 0 && (areas[id] ?? 0) > 0) out[id] = row.waiting / areas[id]!;
  }
  return out;
}

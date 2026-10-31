import { mapNodeId } from './mapIds.js';
/** Pure D7/A8 routing. Edges are bidirectional; the denser endpoint zone determines their speed. */
export interface RoutingGraph {
  realMap?: boolean;
  nodes: readonly { id: string; x: number; y: number; zone?: string; kind?: string }[];
  edges: readonly { from: string; to: string; lengthM?: number; walkSec?: number; oneWay?: boolean; evacuationOnly?: boolean }[];
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
  const requestedFrom = from, requestedTo = to;
  if (graph.realMap) {
    from = mapNodeId(from); to = mapNodeId(to);
    blocked = blocked.map(mapNodeId);
    const canonical: Record<string, number | null | undefined> = {};
    for (const [id, value] of Object.entries(density)) canonical[mapNodeId(id)] = Math.max(canonical[mapNodeId(id)] ?? 0, value ?? 0);
    canonical.U_SECURITY = Math.max(canonical.U_SECURITY ?? 0, canonical.U_SECURITY_QUEUE ?? 0);
    density = canonical;
  }
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const closed = new Set(blocked);
  const evacuation = nodes.get(to)?.kind === 'exit';
  const nodeDensity = (n: { id: string; zone?: string }) => Math.max(density[n.id] ?? 0, density[n.zone ?? n.id] ?? 0);
  const passable = (id: string) => {
    const n = nodes.get(id);
    if (graph.realMap && !evacuation && id === 'U_SECURITY' && (closed.has('U_SECURITY_QUEUE') || walkingSpeed(density.U_SECURITY_QUEUE) === 0)) return false;
    return n && !closed.has(id) && !(n.zone && closed.has(n.zone)) && walkingSpeed(nodeDensity(n)) > 0;
  };
  if (!passable(from) || !passable(to)) return null;
  const adjacency = new Map<string, { to: string; sec: number }[]>();
  for (const e of graph.edges) {
    if (e.evacuationOnly && !evacuation) continue;
    if (!passable(e.from) || !passable(e.to)) continue;
    const a = nodes.get(e.from)!, b = nodes.get(e.to)!;
    const speed = Math.min(walkingSpeed(nodeDensity(a)), walkingSpeed(nodeDensity(b)));
    const sec = e.lengthM !== undefined ? e.lengthM / speed : e.walkSec !== undefined ? e.walkSec * FREE_SPEED / speed : Math.hypot(a.x - b.x, a.y - b.y) / speed;
    if (!Number.isFinite(sec) || sec < 0) continue;
    for (const [start, end] of (e.oneWay ? [[e.from, e.to] as const] : [[e.from, e.to] as const, [e.to, e.from] as const])) {
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
  const ids = [from, ...segments.map(s => s.to)];
  ids[0] = requestedFrom; ids[ids.length - 1] = requestedTo;
  if (segments.length) { segments[0]!.from = requestedFrom; segments[segments.length - 1]!.to = requestedTo; }
  return { nodes: ids, totalSec: dist.get(to)!, segments };
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

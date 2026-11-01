import zoneData from '../../docs/contract/map/zones.json' with { type: 'json' };
import pointData from '../../docs/contract/map/points.json' with { type: 'json' };
import navData from '../../docs/contract/terminal.json' with { type: 'json' };
import { deskGroups, logicalKind, type ZoneKind } from './mapIds.js';
export { deskGroups, desksForAirline, desksForGroup, laneKey, mapNodeId, logicalKind } from './mapIds.js';
export type { ZoneKind } from './mapIds.js';
export type Level = 'G' | 'U' | 'X';
type XY = [number, number];
export const frames = zoneData.frames;
export const zones = zoneData.zones;
export const points = pointData.points;
export function worldToPx(x: number, z: number, level: Level): XY {
  const frame = Object.values(frames).find(f => f.level === level);
  if (!frame) throw new Error(`Unknown floor ${level}`);
  return [(x - frame.x0) * frame.pixels_per_metre, (frame.z1 - z) * frame.pixels_per_metre];
}
export interface TerminalZone { id: string; kind: ZoneKind; name: string; polygon: XY[]; level?: string }
export interface TerminalNode { id: string; kind: ZoneKind | 'team_post'; x: number; y: number; level?: string; zone?: string }
export interface TerminalEdge { from: string; to: string; walkSec: number; oneWay?: boolean; inferred?: boolean; evacuationOnly?: boolean }
export interface TerminalPlan {
  realMap?: boolean; version: string; provisional: boolean; units: 'm'; origin: string; width: number; height: number;
  zones: TerminalZone[]; nodes: TerminalNode[]; edges: TerminalEdge[];
}
function inside(p: number[], ring: number[][]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1]! > p[1]!) !== (b[1]! > p[1]!) && p[0]! < (b[0]! - a[0]!) * (p[1]! - a[1]!) / (b[1]! - a[1]!) + a[0]!) hit = !hit;
  }
  return hit;
}
const segmentDistance = (p: number[], a: number[], b: number[]) => {
  const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!;
  const t = Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0]! - a[0]! - t * dx, p[1]! - a[1]! - t * dy);
};
function pointDistance(p: number[], zone: typeof zones[number]): number {
  return Math.min(...zone.polygons_world.map(poly => {
    if (inside(p, poly.outer) && !poly.holes.some(h => inside(p, h))) return 0;
    return Math.min(...[poly.outer, ...poly.holes].flatMap(ring => ring.map((v, i) => segmentDistance(p, v, ring[(i + 1) % ring.length]!))));
  }));
}
function intersects(a: number[], b: number[], c: number[], d: number[]) {
  const cross = (p: number[], q: number[], r: number[]) => (q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!);
  return Math.max(Math.min(a[0]!, b[0]!), Math.min(c[0]!, d[0]!)) <= Math.min(Math.max(a[0]!, b[0]!), Math.max(c[0]!, d[0]!))
    && Math.max(Math.min(a[1]!, b[1]!), Math.min(c[1]!, d[1]!)) <= Math.min(Math.max(a[1]!, b[1]!), Math.max(c[1]!, d[1]!))
    && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
}
export function polygonGap(a: typeof zones[number], b: typeof zones[number]): number {
  for (const p of a.polygons_world) for (const q of b.polygons_world)
    for (let i = 0; i < p.outer.length; i++) for (let j = 0; j < q.outer.length; j++)
      if (intersects(p.outer[i]!, p.outer[(i + 1) % p.outer.length]!, q.outer[j]!, q.outer[(j + 1) % q.outer.length]!)) return 0;
  return Math.min(...a.polygons_world.flatMap(p => p.outer.map(v => pointDistance(v, b))),
    ...b.polygons_world.flatMap(p => p.outer.map(v => pointDistance(v, a))));
}
/** Geometric estimate, not a surveyed navmesh. Gap bridges are exposed for review. */
export function buildPlan(): TerminalPlan {
  const nodes: TerminalNode[] = zones.map(z => ({ id: z.id, kind: logicalKind(z.id, z.kind), x: z.centre[0]!, y: z.centre[1]!, level: z.level, zone: z.id }));
  const edges: TerminalEdge[] = [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const link = (a: string, b: string, inferred = false, oneWay = false) => {
    if (a === b || edges.some(e => e.from === a && e.to === b || !e.oneWay && e.from === b && e.to === a)) return;
    const p = byId.get(a)!, q = byId.get(b)!;
    const height = p.level !== q.level && p.level !== 'X' && q.level !== 'X' ? frames.etaj1.floor_height_m! - frames.parter.floor_height_m! : 0;
    const side = (n: TerminalNode) => zones.find(z => z.id === n.zone)?.side;
    const crossing = side(p) !== side(q) && ![a, b].includes('U_SECURITY');
    edges.push({ ...(crossing && { evacuationOnly: true }), from: a, to: b, walkSec: Math.max(0.01, Math.hypot(p.x - q.x, p.y - q.y, height) / 1.34), ...(inferred && { inferred }), ...(oneWay && { oneWay }) });
  };
  for (let i = 0; i < zones.length; i++) for (const b of zones.slice(i + 1)) {
    const a = zones[i]!;
    if (a.level === b.level && polygonGap(a, b) <= 2) link(a.id, b.id);
  }
  // The export contains isolated service areas and disconnected approximate polygons.
  // Minimum-gap spanning bridges per floor make the estimate usable without hiding those assumptions.
  for (const level of ['G', 'U', 'X']) {
    const floor = zones.filter(z => z.level === level);
    const reached = new Set([floor[0]!.id]);
    while (reached.size < floor.length) {
      let expanded = true;
      while (expanded) { expanded = false; for (const e of edges) if (reached.has(e.from) !== reached.has(e.to)) {
        const next = reached.has(e.from) ? e.to : e.from;
        if (floor.some(z => z.id === next)) { reached.add(next); expanded = true; }
      } }
      if (reached.size === floor.length) break;
      const candidates = floor.filter(a => reached.has(a.id)).flatMap(a => floor.filter(b => !reached.has(b.id)).map(b => ({ a, b, gap: polygonGap(a, b) })));
      candidates.sort((a, b) => a.gap - b.gap || a.a.id.localeCompare(b.a.id) || a.b.id.localeCompare(b.b.id));
      const c = candidates[0]!; link(c.a.id, c.b.id, true); reached.add(c.b.id);
    }
  }
  const walkPoints = points.filter(p => ['door', 'emergency_exit', 'stairs', 'escalator', 'lift', 'gate', 'checkin_desk', 'security_lane'].includes(p.type));
  for (const p of walkPoints) {
    const floor = zones.filter(z => z.level === p.level).sort((a, b) => pointDistance([p.x, p.z], a) - pointDistance([p.x, p.z], b) || Math.hypot(a.centre[0]! - p.x, a.centre[1]! - p.z) - Math.hypot(b.centre[0]! - p.x, b.centre[1]! - p.z) || a.id.localeCompare(b.id));
    const zone = p.type === 'gate' ? zones.find(z => z.id === `U_${p.id.toUpperCase()}`)! : floor[0]!;
    const node: TerminalNode = { id: p.id, kind: p.evacuation_exit ? 'exit' : p.type === 'gate' ? 'gate' : p.type === 'lift' ? 'lift' : 'circulation', x: p.x, y: p.z, level: p.level, zone: zone.id };
    nodes.push(node); byId.set(p.id, node); link(p.id, zone.id, pointDistance([p.x, p.z], zone) > 2);
  }
  for (const p of walkPoints.filter(p => p.level === 'G' && p.links_to === 'U')) {
    const upper = walkPoints.find(q => q.id === p.id.replace(/_G$/, '_U'));
    if (upper) link(p.id, upper.id, false, p.one_way === true);
  }
  // Exterior is a separate coordinate frame, not a different elevation. Exit doors bridge it.
  for (const p of walkPoints.filter(p => p.evacuation_exit)) {
    const side = /apron|arrivals_entry/.test(p.id) ? 'airside' : 'landside';
    const exterior = zones.filter(z => z.level === 'X' && z.side === side).sort((a, b) => pointDistance([p.x, p.z], a) - pointDistance([p.x, p.z], b) || a.id.localeCompare(b.id));
    if (exterior[0]) link(p.id, exterior[0].id, true);
  }
  // Arriving passengers leave the baggage hall through the arrivals exit into the public hall: a normal,
  // one-way crossing (the two-way edge stays evacuation-only, so nobody routes from landside into reclaim).
  // Only the real exit; other reclaim/landside contacts are shared walls. The gate-stair boxes (departures,
  // down to the apron) only touch the baggage hall: that contact is for evacuations, not a walkway.
  // Assembly points are for evacuations only; walking across the apron between them is not a passenger route.
  for (const e of edges) if ([e.from, e.to].some(id => id.startsWith('G_GATE_DOOR_')) && [e.from, e.to].some(id => /^G_RECLAIM_|^G_ARRIVALS_PASSPORT$/.test(id))
    || [e.from, e.to].some(id => id.startsWith('ASSEMBLY_'))) e.evacuationOnly = true;
  for (const e of [...edges]) {
    const reclaim = [e.from, e.to].find(id => /^G_RECLAIM_[12]$/.test(id));
    const other = e.from === reclaim ? e.to : e.from;
    if (e.evacuationOnly && reclaim && other === 'G_ARRIVALS_EXIT') edges.push({ from: reclaim, to: other, walkSec: e.walkSec, oneWay: true });
  }
  for (const [group, desks] of Object.entries(deskGroups)) {
    const members = desks.map(id => byId.get(id)!);
    const node: TerminalNode = { id: `check_in:${group}`, kind: 'check_in', level: 'G', zone: 'G_CHECKIN_QUEUE',
      x: members.reduce((s, n) => s + n.x, 0) / members.length, y: members.reduce((s, n) => s + n.y, 0) / members.length };
    nodes.push(node); byId.set(node.id, node);
    for (const desk of desks) link(node.id, desk);
  }
  return { realMap: true, version: 't2-2026-10-31', provisional: true, units: 'm', origin: 'Unity world x,z (metres); level G/U/X', width: 530, height: 320,
    zones: zones.map(z => ({ ...z, kind: logicalKind(z.id, z.kind), name: z.name_ro, polygon: z.polygons_world[0]!.outer as XY[] })), nodes, edges };
}
export const plan = buildPlan();
export const terminalGraph = plan;
export const zoneAreas: Readonly<Record<string, number>> = Object.fromEntries(zones.map(z => [z.id, z.area_m2]));
/** Lanes open at start, from Marius's terminal.json (`lanes`): security 2, each desk group 3. One key per counter. */
export const initialLanes: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(navData.lanes as Record<string, { initial: number }>).map(([key, lane]) => [key, lane.initial]));

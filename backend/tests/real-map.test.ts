import { describe, expect, it } from 'vitest';
import { buildPlan, plan, zones, points, frames, worldToPx, polygonGap } from '../src/terminal.js';
import { isNodeId, deskGroups, desksForAirline, mapNodeId, logicalKind, flowRow } from '../src/mapIds.js';
import { route, zoneDensities } from '../src/routing.js';
import { SimStore, opsCommand } from '../src/sim.js';

describe('D26 real map contract', () => {
  it('builds deterministically from all 52 zones and keeps pixel geometry and frames intact', () => {
    expect(zones).toHaveLength(52);
    for (const entry of [...zones, ...points]) expect(isNodeId(entry.id), entry.id).toBe(true);
    expect(buildPlan()).toEqual(plan);
    expect(new Set(plan.nodes.map(n => n.id)).size).toBe(plan.nodes.length);
    expect(Object.keys(frames)).toHaveLength(3);
    for (const z of zones) {
      expect(z.polygons_px.length).toBe(z.polygons_world.length);
      for (let i = 0; i < z.polygons_world.length; i++) for (let j = 0; j < z.polygons_world[i]!.outer.length; j++) {
        const p = z.polygons_world[i]!.outer[j]!, px = z.polygons_px[i]!.outer[j]!;
        const actual = worldToPx(p[0]!, p[1]!, z.level as 'G' | 'U' | 'X');
        expect(Math.abs(actual[0] - px[0]!)).toBeLessThanOrEqual(0.051);
        expect(Math.abs(actual[1] - px[1]!)).toBeLessThanOrEqual(0.051);
      }
    }
    expect(worldToPx(6160, -440, 'G')).toEqual([0, 0]);
    expect(worldToPx(6460, -545, 'U')).toEqual([3000, 1050]);
    expect(worldToPx(6640, -700, 'X')).toEqual([2120, 1280]);
  });
  it('recognises crossed polygons even when neither contains a vertex of the other', () => {
    const shape = (outer: number[][]) => ({ ...zones[0]!, polygons_world: [{ outer, holes: [] }] });
    expect(polygonGap(shape([[-2, -1], [2, -1], [2, 1], [-2, 1]]), shape([[-1, -2], [1, -2], [1, 2], [-1, 2]]))).toBe(0);
    expect(polygonGap(shape([[0, 0], [1, 0], [1, 1], [0, 1]]), shape([[3, 0], [4, 0], [4, 1], [3, 1]]))).toBe(2);
  });
  it('connects every zone per floor, flags gap bridges and connects floors only at exported links', () => {
    for (const level of ['G', 'U', 'X']) {
      const floor = plan.nodes.filter(n => n.level === level);
      const sub = { nodes: floor, edges: plan.edges.filter(e => floor.some(n => n.id === e.from) && floor.some(n => n.id === e.to)).map(e => ({ ...e, evacuationOnly: false })) };
      for (const n of floor) expect(route(sub, floor[0]!.id, n.id), n.id).not.toBeNull();
    }
    for (const a of zones) for (const b of zones) if (a.id < b.id && a.level === b.level && polygonGap(a, b) <= 2)
      expect(plan.edges.some(e => e.from === a.id && e.to === b.id || e.to === a.id && e.from === b.id)).toBe(true);
    for (const e of plan.edges) {
      expect(e.walkSec).toBeGreaterThan(0);
      const a = plan.nodes.find(n => n.id === e.from)!, b = plan.nodes.find(n => n.id === e.to)!;
      const dz = a.level !== b.level && a.level !== 'X' && b.level !== 'X' ? 5.4 : 0;
      expect(e.walkSec).toBeCloseTo(Math.max(0.01, Math.hypot(a.x - b.x, a.y - b.y, dz) / 1.34), 8);
      if (a.level !== b.level && a.level !== 'X' && b.level !== 'X') {
        expect(a.id.replace(/_[GU]$/, '')).toBe(b.id.replace(/_[GU]$/, ''));
        expect(points.find(p => p.id === a.id)?.links_to).toBe(b.level);
      }
    }
    const escalator = { nodes: plan.nodes.filter(n => n.id.startsWith('escalator_east_')), edges: plan.edges.filter(e => e.from === 'escalator_east_G' && e.to === 'escalator_east_U') };
    expect(route(escalator, 'escalator_east_U', 'escalator_east_G')).toBeNull();
    expect(route(escalator, 'escalator_east_G', 'escalator_east_U')).not.toBeNull();
    expect(plan.edges.find(e => e.from === 'escalator_east_G' && e.to === 'escalator_east_U')?.oneWay).toBe(true);
    expect(route(plan, 'entrance', 'U_GATE_10')).not.toBeNull();
  });
  it('preserves aliases, applies crowd costs and blocks routes through security', () => {
    expect(mapNodeId('G10')).toBe('U_GATE_10');
    expect(mapNodeId('gate_2')).toBe('U_GATE_2');
    expect(mapNodeId('check_in:1')).toBe('check_in:W6');
    expect(route(plan, 'entrance', 'gate_2')?.totalSec).toBe(route(plan, 'G_DEPARTURES', 'U_GATE_2')?.totalSec);
    const free = route(plan, 'security', 'gate_2')!;
    expect(route(plan, 'security', 'gate_2', { security: 4 })!.totalSec).toBeGreaterThan(free.totalSec);
    expect(route(plan, 'entrance', 'gate_2', {}, ['security'])).toBeNull();
    expect(route(plan, 'entrance', 'gate_2', { U_SECURITY_QUEUE: 5.4 })).toBeNull();
    expect(route(plan, 'U_GATE_2', 'ASSEMBLY_AIRSIDE', {}, ['security'])).not.toBeNull();
    const exits = plan.nodes.filter(n => n.kind === 'exit');
    expect(exits.some(n => n.id.startsWith('door_emergency'))).toBe(true);
  });
  it('assigns each real desk exactly once and keeps group observations distinct', () => {
    const assigned = Object.values(deskGroups).flat();
    expect(new Set(assigned).size).toBe(12);
    expect(assigned.every(id => points.some(p => p.id === id))).toBe(true);
    expect(desksForAirline('w6')).toEqual(Array.from({ length: 6 }, (_, i) => `checkin_${i + 1}`));
    expect(desksForAirline('ZZ')).toEqual(['checkin_11', 'checkin_12']);
    expect(flowRow({ 'check_in:1': 12 }, 'check_in:W6')).toBe(12);
    expect(flowRow({ 'check_in:W6': 12 }, 'check_in:1')).toBe(12);
    expect(flowRow({ 'bag_drop:1': 99 }, 'check_in:W6')).toBeUndefined();
    expect(flowRow({ 'check_in:W6': 12, 'check_in:RO': 20 }, 'check_in:RO')).toBe(20);
    expect(flowRow({ 'check_in:W6': 12 }, 'check_in:RO')).toBeUndefined();
    for (const [id, kind] of [['G_CHECKIN_QUEUE', 'check_in'], ['G_CHECKIN_DESKS', 'check_in'], ['U_SECURITY', 'security'], ['U_PASSPORT_DEP', 'passport'], ['U_GATE_10', 'gate'], ['G_RECLAIM_1', 'reclaim'], ['X_TAXI_RANK', 'taxi_rank']]) expect(logicalKind(id!)).toBe(kind);
  });
  it('accepts real and legacy telemetry and preserves world coordinates without using truth', () => {
    const store = new SimStore();
    store.flow({ zones: [{ zone: 'G_CHECKIN_QUEUE', waiting: 20, density: 1 }, { zone: 'check_in:w6', waiting: 6 }] }, 'vision', 10000);
    store.truth({ zones: [{ zone: 'G_CHECKIN_QUEUE', waiting: 999 }] }, 10000);
    store.positions({ people: [{ x: 6380, z: -510, level: 'G' }] }, 'vision', 10000);
    const snap = store.snapshot(true, {}, true, 10000);
    expect(snap.flow.G_CHECKIN_QUEUE?.waiting).toBe(20);
    expect(snap.flow['check_in:W6']?.waiting).toBe(6);
    expect(snap.positions?.people[0]).toEqual({ x: 6380, y: -510, z: -510, level: 'G' });
    expect(zoneDensities(snap.flow).G_CHECKIN_QUEUE).toBe(1);
    expect(opsCommand({ type: 'close', zone: 'U_GATE_10' })).toEqual({ type: 'close', zone: 'U_GATE_10' });
    expect(() => store.positions({ people: [{ x: 1, z: 2, level: 'bad' }] }, 'vision', 12000)).toThrow();
  });
});

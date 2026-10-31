import { describe, expect, it } from 'vitest';
import { route, walkingSpeed, zoneDensities, type RoutingGraph } from '../src/routing.js';
const graph: RoutingGraph = {
  nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0, zone: 'queue' }, { id: 'c', x: 20, y: 0 }],
  edges: [{ from: 'a', to: 'b', lengthM: 13.4 }, { from: 'b', to: 'c', walkSec: 10 }, { from: 'a', to: 'c', walkSec: 25 }],
};
describe('Weidmann routing (A8)', () => {
  it('matches hand-calculated speeds: exponent at rho=1 is -1.55874074, giving 1.05806286 m/s', () => {
    expect(walkingSpeed(1)).toBeCloseTo(1.058062856, 8);
    expect(walkingSpeed(0)).toBe(1.34);
    expect(walkingSpeed(1e-12)).toBe(1.34);
    expect(walkingSpeed(undefined)).toBe(1.34);
    expect(walkingSpeed(5.4)).toBe(0);
    expect(walkingSpeed(6)).toBe(0);
    expect(walkingSpeed(5.399)).toBeGreaterThan(0);
  });
  it('chooses shortest path and returns individual seconds in both directions', () => {
    expect(route(graph, 'a', 'c')).toEqual({ nodes: ['a', 'b', 'c'], totalSec: 20,
      segments: [{ from: 'a', to: 'b', sec: 10 }, { from: 'b', to: 'c', sec: 10 }] });
    expect(route(graph, 'c', 'a')?.nodes).toEqual(['c', 'b', 'a']);
  });
  it('scales metres and walkSec equally: 13.4/1.058062856 = 12.66465402 seconds', () => {
    const r = route({ ...graph, edges: graph.edges.slice(0, 2) }, 'a', 'c', { queue: 1 })!;
    expect(r.segments[0]!.sec).toBeCloseTo(12.66465402, 6);
    expect(r.segments[1]!.sec).toBeCloseTo(12.66465402, 6);
    expect(r.totalSec).toBeCloseTo(25.32930803, 6);
  });
  it('reroutes around crowds, blocked nodes/zones and jam density', () => {
    for (const density of [1, 4, 5.4, 6]) expect(route(graph, 'a', 'c', { queue: density })?.nodes).toEqual(['a', 'c']);
    expect(route(graph, 'a', 'c', {}, ['queue'])?.totalSec).toBe(25);
    expect(route(graph, 'a', 'c', {}, ['b'])?.totalSec).toBe(25);
    expect(route(graph, 'a', 'c', {}, ['c'])).toBeNull();
  });
  it('handles missing, disconnected and same-node routes', () => {
    expect(route(graph, 'missing', 'a')).toBeNull();
    expect(route({ ...graph, edges: [] }, 'a', 'c')).toBeNull();
    expect(route(graph, 'a', 'a')).toEqual({ nodes: ['a'], totalSec: 0, segments: [] });
  });
  it('prefers live density, falls back to waiting/area, ignores stale and unknown zones', () => {
    expect(zoneDensities({ a: { waiting: 10, density: 0 }, b: { waiting: 20 }, c: { waiting: 40, stale: true, density: 3 }, d: { waiting: 2 } },
      { a: 10, b: 10, c: 10 })).toEqual({ a: 0, b: 2 });
  });
});

import { describe, expect, it } from 'vitest';
import { plan } from '../src/terminal.js';
import { route } from '../src/routing.js';
import { evacuationRoute, exitSide } from '../src/evacuation.js';

describe('arrivals exit', () => {
  it('lets arriving passengers walk from the baggage belts to the public side', () => {
    for (const belt of ['G_RECLAIM_1', 'G_RECLAIM_2']) for (const to of ['G_ARRIVALS_EXIT', 'G_MEETING', 'X_KERB_ARRIVALS', 'X_TAXI_RANK']) {
      const r = route(plan, belt, to, {}, [], { evacuation: false });
      expect(r, `${belt} → ${to}`).not.toBeNull();
      expect(r!.nodes).toContain('G_ARRIVALS_EXIT');
      expect(r!.nodes.some(n => n.startsWith('U_'))).toBe(false);
    }
  });
  it('never routes a departing passenger from landside into the baggage hall', () => {
    for (const from of ['G_ARRIVALS_EXIT', 'G_MEETING', 'G_CENTER', 'X_TAXI_RANK', 'U_GATE_6'])
      for (const belt of ['G_RECLAIM_1', 'G_RECLAIM_2', 'G_ARRIVALS_PASSPORT'])
        expect(route(plan, from, belt, {}, [], { evacuation: false }), `${from} → ${belt}`).toBeNull();
  });
  it('keeps the arrivals exit one way in the graph', () => {
    const normal = plan.edges.filter(e => !e.evacuationOnly && [e.from, e.to].includes('G_ARRIVALS_EXIT') && /RECLAIM/.test(e.from + e.to));
    expect(normal.length).toBe(2);
    for (const e of normal) { expect(e.oneWay).toBe(true); expect(e.from).toMatch(/^G_RECLAIM_/); }
  });
});

describe('route to a door', () => {
  it('uses a normal path when there is one, and evacuation mode only when asked', () => {
    const normal = route(plan, 'G_CENTER', 'door_exit_west')!;
    const crossings = new Set(plan.edges.filter(e => e.evacuationOnly).flatMap(e => [`${e.from}>${e.to}`, `${e.to}>${e.from}`]));
    expect(normal.nodes.some((n, i) => i > 0 && crossings.has(`${normal.nodes[i - 1]}>${n}`))).toBe(false);
    expect(route(plan, 'G_CENTER', 'door_exit_west', {}, [], { evacuation: true })!.totalSec).toBeLessThanOrEqual(normal.totalSec);
  });
});

describe('evacuation fallback', () => {
  it('sends public-side zones out through landside doors to a landside assembly point', () => {
    for (const from of ['check_in:1', 'G_CHECKIN_QUEUE', 'G_CHECKIN_DESKS', 'G_DEPARTURES', 'U_SECURITY_QUEUE']) {
      const e = evacuationRoute(from)!;
      expect(exitSide(e.exit), `${from} → ${e.exit}`).toBe('landside');
      expect(e.assembly).toMatch(/^ASSEMBLY_LANDSIDE_/);
      expect(e.route.nodes.some(n => /RECLAIM|GATE_DOOR|U_GATE/.test(n))).toBe(false);
    }
  });
  it('sends gate and airside zones out through the apron doors', () => {
    for (const from of ['gate_1', 'U_GATE_7', 'U_GATE_10', 'U_DUTY_FREE']) {
      const e = evacuationRoute(from)!;
      expect(e.exit, from).toMatch(/^door_apron_gate_/);
      expect(e.assembly).toBe('ASSEMBLY_AIRSIDE');
    }
    expect(evacuationRoute('U_GATE_7')!.exit).toBe('door_apron_gate_7');
  });
  it('returns null for an unknown place', () => { expect(evacuationRoute('nowhere')).toBeNull(); });
});

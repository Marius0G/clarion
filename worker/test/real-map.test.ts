import { expect, it } from 'vitest';
import { arrivalPlan } from '../src/wa/tools.js';
import { PROVISIONAL_FLIGHTS, gateName } from '../src/wa/flights.js';
import { evacPlan, routeFor } from '../src/wa/messaging.js';
import { desksForGroup } from '../../backend/src/mapIds.js';

it('reads real map camera ids in the arrival plan and preserves measured waits', () => {
  const result = arrivalPlan(PROVISIONAL_FLIGHTS[0]!, {
    G_CHECKIN_QUEUE: { waiting: 12, waitMin: 7 },
    U_SECURITY_QUEUE: { waiting: 5, waitMin: 3 },
  }, { now: 0, sim: true }, true);
  expect(result.queues.map(q => q.nowMin)).toEqual([7, 3]);
  expect(result.steps.slice(0, 2).map(s => s.source)).toEqual(['acum', 'acum']);
});
it('reads per-airline aliases for legacy numeric flight groups', () => {
  const result = arrivalPlan(PROVISIONAL_FLIGHTS[0]!, { 'bag_drop:W6': { waiting: 1, waitMin: 9 } }, { now: 0, sim: true }, true);
  expect(result.queues[0]?.nowMin).toBe(9);
  expect(result.steps[0]?.min).toBe(9);
});
it('accepts real evacuation ids and selects the stage route across legacy aliases', () => {
  const plan = evacPlan({ id: 'evac-real', blocked: ['U_SECURITY'], clearSec: 50,
    exits: [{ exit: 'ASSEMBLY_AIRSIDE', people: 10, clearSec: 50 }],
    routes: [
      { from: 'G_DEPARTURES', exit: 'door_departures', nodes: ['G_DEPARTURES', 'door_departures'] },
      { from: 'U_GATE_2', exit: 'ASSEMBLY_AIRSIDE', nodes: ['U_GATE_2', 'gate_2_stairs_U', 'gate_2_stairs_G', 'ASSEMBLY_AIRSIDE'] },
    ] });
  expect(routeFor(plan, PROVISIONAL_FLIGHTS[0], 9 * 3600).from).toBe('U_GATE_2');
});
it('uses real gates by departure area and the shared desk-group table', () => {
  for (const f of PROVISIONAL_FLIGHTS) {
    const gate = Number(gateName(f.gate));
    expect(gate).toBeGreaterThanOrEqual(f.destination.startsWith('Londra') ? 1 : 4);
    expect(gate).toBeLessThanOrEqual(f.destination.startsWith('Londra') ? 3 : 10);
    expect(f.checkInDesks).toEqual(desksForGroup(f.checkIn));
  }
  expect(gateName('U_GATE_10')).toBe('10');
});

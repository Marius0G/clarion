import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimFlightRow } from '../src/wa/flights.js';
import { toolsFor, type ZoneRow } from '../src/wa/tools.js';
import { airportView } from '../src/wa/tower.js';

// Vision's data as WhatsApp sees it (integration audit): fresh rows only.
const hm = (h: number, m: number) => h * 3600 + m * 60;
const flight = (extra: Partial<SimFlightRow> = {}): SimFlightRow => ({
  flight: 'W6 3751', airline: 'W6', destination: 'Londra Luton', std: '09:40', gate: 'gate_2', checkIn: 'check_in:2', checkInDesks: [],
  gateCloseAt: hm(9, 10), status: 'scheduled', delayMin: 0, pax: 180, ...extra,
});
function sim(flow: Record<string, ZoneRow> = {}) {
  const state = { simTime: hm(7, 0) as number | null, flow, flights: [flight()], blocked: [] as string[] };
  return { state, view: airportView({ snapshot: () => state }, () => true) };
}
afterEach(() => vi.restoreAllMocks());

describe('WhatsApp reads only fresh camera rows (D0, D5b)', () => {
  it('drops stale rows, so a dead feed is never quoted as "now"', () => {
    const { view } = sim({ security: { waiting: 40, waitMin: 12, stale: false }, 'check_in:2': { waiting: 9, waitMin: 4, stale: true } });
    expect(Object.keys(view.flow())).toEqual(['security']);
  });
  it('falls back to the standard estimate once the queue row went stale', async () => {
    const { state, view } = sim({ security: { waiting: 40, waitMin: 30, stale: false } });
    const tools = toolsFor({ view, profile: () => ({ phone: '+40700000001', role: 'passenger', flight: 'W6 3751' }), save: async () => {} });
    const live: any = await tools.whenToArrive({ hasCheckedBag: false });
    expect(live.queues.find((q: any) => q.zone === 'security')).toMatchObject({ nowMin: 30 });
    state.flow.security!.stale = true;
    const dead: any = await tools.whenToArrive({ hasCheckedBag: false });
    expect(dead.queues.find((q: any) => q.zone === 'security').source).toBe('estimare standard');
  });
});

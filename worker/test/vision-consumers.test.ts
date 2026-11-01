import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimFlightRow } from '../src/wa/flights.js';
import { WhatsAppAgent, type WaStore } from '../src/wa/index.js';
import { toolsFor, type ZoneRow } from '../src/wa/tools.js';
import { airportView } from '../src/wa/tower.js';

// Vision's data as WhatsApp sees it (integration audit): fresh rows only, and evac.plan behind routeTo('exit').
const hm = (h: number, m: number) => h * 3600 + m * 60;
class MemoryStore implements WaStore {
  data = new Map<string, unknown>();
  async get<T>(k: string) { return this.data.get(k) as T | undefined; }
  async put(k: string, v: unknown) { this.data.set(k, structuredClone(v)); }
  async delete(k: string) { return this.data.delete(k); }
}
const flight = (extra: Partial<SimFlightRow> = {}): SimFlightRow => ({
  flight: 'W6 3751', airline: 'W6', destination: 'Londra Luton', std: '09:40', gate: 'gate_2', checkIn: 'check_in:2', checkInDesks: [],
  gateCloseAt: hm(9, 10), status: 'scheduled', delayMin: 0, pax: 180, ...extra,
});
function sim(flow: Record<string, ZoneRow> = {}) {
  const state = { simTime: hm(7, 0) as number | null, flow, flights: [flight()], blocked: [] as string[] };
  return { state, view: airportView({ snapshot: () => state }, () => true) };
}
const plan = { id: 'ev1', blocked: ['G_CHECKIN_QUEUE'], clearSec: 120, exits: [{ exit: 'exit_2', people: 30, clearSec: 90 }],
  routes: [{ from: 'airside', exit: 'exit_1', nodes: ['airside', 'exit_1'] }, { from: 'check_in:2', exit: 'exit_2', nodes: ['check_in:2', 'entrance', 'exit_2'] }] };
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

describe('routeTo exit during an evacuation uses evac.plan (A10)', () => {
  it('returns the plan route for the passenger, and the graph again once nothing is blocked', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { state, view } = sim();
    const store = new MemoryStore();
    const fetcher = vi.fn(async () => Response.json({}));
    const agent = new WhatsAppAgent({ WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'PN1' }, store, view, { fetcher, pause: 0, toUnity: () => true, evacWaitMs: 20 });
    await agent.messaging.plan(plan);
    const tools = () => toolsFor({ view, profile: () => ({ phone: '+40700000001', role: 'passenger', flight: 'W6 3751' }), save: async () => {},
      evacRoute: f => agent.messaging.evacRouteFor(f) });
    // Nothing blocked any more (all clear): the ordinary nearest-exit route.
    expect(await agent.messaging.evacRouteFor(undefined)).toBeNull();
    expect(((await tools().routeTo({ to: 'exit' })) as any).status).toBe('ready');
    state.blocked = ['G_CHECKIN_QUEUE'];
    const r: any = await tools().routeTo({ to: 'exit' });
    // 07:00 with the gate closing at 09:10: still landside, at the check-in of group 2.
    expect(r).toMatchObject({ status: 'evacuation', from: 'check_in:2', to: 'exit_2', nodes: ['check_in:2', 'entrance', 'exit_2'] });
    expect(r.note).toMatch(/^Evacuare: /);
    expect(((await tools().routeTo({ to: 'gate' })) as any).status).not.toBe('evacuation');
  });
});

import { describe, expect, it } from 'vitest';
import { SimStore } from '../../backend/src/sim.js';
import { Reports } from '../src/wa/reports.js';
import { PROVISIONAL_FLIGHTS } from '../src/wa/flights.js';
import { toolsFor, arrivalPlan, type AirportView, type Profile, type ZoneRow } from '../src/wa/tools.js';
import { airportView } from '../src/wa/tower.js';
import { fallbackReply } from '../src/wa/agent.js';

function setup(flow: Record<string, ZoneRow> = {}, blocked: string[] = []) {
  const data = new Map<string, unknown>();
  const reports = new Reports({ get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => { data.set(key, structuredClone(value)); }, delete: async key => data.delete(key) });
  let profile: Profile = { phone: '+40700000000', role: 'passenger', flight: 'W6 3751' };
  const view: AirportView = { clock: () => ({ now: 0, sim: true }), flights: () => PROVISIONAL_FLIGHTS,
    flow: () => flow, provisional: () => true, blocked: () => blocked };
  const tools = toolsFor({ view, profile: () => profile, save: async p => { profile = { ...profile, ...p }; },
    report: r => reports.add(r), pageLink: async () => 'https://passenger.example/m/token' });
  return { tools, reports, view, staff: () => { profile.role = 'staff'; } };
}
describe('live routing tools', () => {
  it('routes to the flight gate and desk group and gives a step list, minutes and passenger link', async () => {
    const { tools } = setup();
    const result = await tools.routeTo!({ to: 'gate' }) as any;
    expect(result).toMatchObject({ status: 'ready', minutes: 3, from: 'entrance', to: 'gate_2', link: 'https://passenger.example/m/token' });
    expect(result.nodes).toContain('U_SECURITY');
    expect(result.nodes).toContain('escalator_east_U');
    expect(result.steps.at(-1)).toBe('Poarta 2');
    expect(result.totalSec).toBeCloseTo(160.67016, 4);
    expect(await tools.routeTo!({ to: 'check_in' })).toMatchObject({ to: 'check_in:1', minutes: 1 });
    expect(await tools.routeTo!({ to: 'invalid' })).toMatchObject({ error: 'invalid_destination' });
  });
  it('chooses a reachable exit and respects density, blocked zones and unknown destinations', async () => {
    expect(await setup().tools.routeTo!({ to: 'exit' })).toMatchObject({ to: 'door_departures', minutes: 1 });
    expect(await setup({}, ['door_departures']).tools.routeTo!({ to: 'exit' })).toMatchObject({ to: 'door_emergency_east', minutes: 1 });
    expect(await setup({}, ['security']).tools.routeTo!({ to: 'gate' })).toMatchObject({ status: 'unavailable' });
    expect(await setup({ security: { waiting: 0, waitMin: 0, density: 5.4 } }).tools.routeTo!({ to: 'gate' })).toMatchObject({ status: 'unavailable' });
    expect(await setup().tools.routeTo!({ flight: 'XX 9999' })).toMatchObject({ error: 'unknown_flight' });
  });
  it('persists the crowd-sensitive response ETA, with an explicit unknown/blocked fallback', async () => {
    const h = setup({ security: { waiting: 0, waitMin: 0, density: 4 } }); h.staff();
    const r = await h.tools.reportIssue!({ text: 'medical la securitate' }) as any;
    // Only edges touching the crowded queue slow down; other segments retain free speed.
    expect(r).toMatchObject({ status: 'sent', etaMin: 2, note: expect.stringContaining('Echipa ajunge în ~2 min') });
    expect((await h.reports.list())[0]).toMatchObject({ node: 'security', etaMin: 2 });
    expect(await h.tools.reportIssue!({ text: 'medical undeva' })).toMatchObject({ etaMin: null });
    const blocked = setup({}, ['security']); blocked.staff();
    expect(await blocked.tools.reportIssue!({ text: 'medical la securitate' })).toMatchObject({ etaMin: null });
  });
  it('uses security-to-gate routing in arrival plans, retaining the fallback for absent gates', () => {
    const h = setup(); const f = PROVISIONAL_FLIGHTS[0]!;
    const walk = (flight = f, flow = h.view.flow()) => arrivalPlan(flight, flow, h.view.clock(), false).steps.find(s => s.zone === 'walk');
    expect(walk()).toMatchObject({ min: 2, source: 'traseu live' });
    expect(walk(f, { security: { waiting: 0, waitMin: 0, density: 4 } })!.min).toBeGreaterThan(1);
    expect(walk({ ...f, gate: 'missing_gate' })).toMatchObject({ min: 5, source: 'constantă' });
  });
  it('keeps blocked state beyond the retained ops history and applies reopening', () => {
    const sim = new SimStore(); sim.sent({ type: 'close', zone: 'security' });
    for (let n = 0; n < 60; n++) sim.sent({ type: 'staff', zone: 'security', delta: 1 });
    const view = airportView(sim, () => true);
    expect(view.blocked?.()).toEqual(['security']);
    sim.sent({ type: 'open', zone: 'security' });
    sim.sent({ type: 'evacuate', zones: ['gate_1', 'gate_2'] });
    expect(view.blocked?.()).toEqual(['gate_1', 'gate_2']);
  });
  it('answers routing requests without an LLM, including the page link', async () => {
    const answer = await fallbackReply('cum ajung la poarta?', setup().tools);
    expect(answer[0]).toContain('Poarta 2');
    expect(answer[1]).toBe('https://passenger.example/m/token');
  });
});

import { describe, expect, it } from 'vitest';
import { WaitHistory } from '../src/wa/history.js';
import { arrivalPlan, toolsFor, waitAt, type AirportView, type Profile } from '../src/wa/tools.js';
import { fromSim, type SimFlightRow } from '../src/wa/flights.js';

const hm = (h: number, m: number) => h * 3600 + m * 60;
const memory = () => { const data = new Map<string, unknown>(); return { data, get: async <T>(k: string) => data.get(k) as T | undefined, put: async (k: string, v: unknown) => { data.set(k, structuredClone(v)); } }; };
const row: SimFlightRow = { flight: 'W6 3751', airline: 'W6', destination: 'Londra Luton', std: '09:40', gate: 'gate_2', checkIn: 'check_in:2', checkInDesks: [],
  gateCloseAt: hm(9, 10), status: 'scheduled', delayMin: 0, pax: 180 };

describe('D5b same-hour history fallback', () => {
  it('keeps one sample a minute per zone and hour, from fresh rows only', async () => {
    const store = memory(), h = new WaitHistory(store);
    await h.record({ U_SECURITY_QUEUE: { waiting: 30, waitMin: 12 }, check_in: { waiting: 3, waitMin: 4, stale: true } }, hm(8, 5), 0);
    expect(h.record({ U_SECURITY_QUEUE: { waiting: 30, waitMin: 99 } }, hm(8, 6), 30_000)).toBeUndefined();
    await h.record({ U_SECURITY_QUEUE: { waiting: 30, waitMin: 8 } }, hm(8, 50), 60_000);
    expect(h.rows(hm(8, 30))).toEqual({ U_SECURITY_QUEUE: { waiting: 0, waitMin: 10 } });
    expect(h.rows(hm(9, 0))).toEqual({});
    const again = new WaitHistory(store);
    await again.load();
    expect(again.rows(hm(8, 0)).U_SECURITY_QUEUE!.waitMin).toBe(10);
  });
  it('uses the history mean before the standard estimate, never over a live row', () => {
    expect(waitAt(undefined, 'security', 30, { waiting: 0, waitMin: 7 })).toEqual({ min: 7, source: 'istoric' });
    expect(waitAt({ waiting: 5, waitMin: 3 }, 'security', 30, { waiting: 0, waitMin: 7 })).toEqual({ min: 3, source: 'acum' });
    expect(waitAt(undefined, 'security', 30)).toEqual({ min: 15, source: 'estimare standard' });
    const f = fromSim([row])[0]!;
    const plan = arrivalPlan(f, {}, { now: hm(7, 0), sim: true }, false, [], () => ({ U_SECURITY_QUEUE: { waiting: 0, waitMin: 7 } }));
    expect(plan.queues.find(q => q.zone === 'security')).toMatchObject({ forecastMin: 7, source: 'istoric' });
  });
});

describe('pitch: the gate and the walk from security', () => {
  it('routeTo gate says the walk from security to the gate', async () => {
    const view: AirportView = { clock: () => ({ now: hm(7, 0), sim: true }), flow: () => ({}), flights: () => fromSim([row]), provisional: () => false, blocked: () => [] };
    let profile: Profile = { phone: '+40712345678', role: 'passenger', flight: 'W6 3751' };
    const tools = toolsFor({ view, profile: () => profile, save: async p => { profile = { ...profile, ...p }; } });
    const r = await tools.routeTo!({ to: 'gate', from: 'Securitate' }) as any;
    expect(r.minutes).toBeGreaterThan(0);
    expect(r.note).toContain(`Poarta 2: ~${r.minutes} min de mers.`);
    const w = await tools.whenToArrive!({}) as any;
    expect(w.situation).toMatch(/Până la poarta 2 ~\d+ min de mers/);
  });
});

import { afterEach,describe,expect,it,vi } from 'vitest';
import { PROVISIONAL_FLIGHTS,fromSim,simSeconds,type Flight,type SimFlightRow } from '../src/wa/flights.js';
import { WhatsAppAgent,parseStaff,type WaStore } from '../src/wa/index.js';
import { Messaging,estimateStage,evacPlan,routeFor,splitRegister,type EvacPlan } from '../src/wa/messaging.js';
import { classifyIssue,matchNode } from '../src/wa/reports.js';
import { arrivalPlan,toolsFor,type AirportView,type Profile,type ZoneRow } from '../src/wa/tools.js';
import { airportView } from '../src/wa/tower.js';
import { WhatsAppClient } from '../src/wa/transport.js';

const hm = (h: number, m: number) => h * 3600 + m * 60;
class MemoryStore implements WaStore {
  data = new Map<string, unknown>();
  async get<T>(k: string) { return this.data.get(k) as T | undefined; }
  async put(k: string, v: unknown) { this.data.set(k, structuredClone(v)); }
  async delete(k: string) { return this.data.delete(k); }
}
const row = (extra: Partial<SimFlightRow> = {}): SimFlightRow => ({
  flight: 'W6 3751', airline: 'W6', destination: 'Londra Luton', std: '09:40', gate: 'gate_2', checkIn: 'check_in:2', checkInDesks: [],
  gateCloseAt: hm(9, 10), status: 'scheduled', delayMin: 0, pax: 180, ...extra,
});
/** A mutable fake of the sim store, read through the real airportView. */
function fakeSim(flights: SimFlightRow[] = [row()], flow: Record<string, ZoneRow> = {}) {
  const state = { simTime: hm(7, 0) as number | null, flow, flights };
  return { state, view: airportView({ snapshot: () => state }, () => true) };
}
afterEach(() => vi.restoreAllMocks());
const quiet = () => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); };

describe('passenger page profiles', () => {
  it('sends route steps and a working passenger link, preserving its token on subsequent turns', async () => {
    quiet();
    const h = harness(fakeSim().view);
    await h.store.put('wa:profile:+40712345678', { phone: '+40712345678', role: 'passenger', flight: 'W6 3751' });
    await h.inbound('cum ajung la poarta?');
    const p = await h.agent.profile('+40712345678');
    expect(p?.pageToken).toBeTruthy();
    expect(h.texts().some(m => m.text.includes('Poarta 2') && m.text.includes('~2 min'))).toBe(true);
    expect(h.texts().some(m => m.text.includes(`/m/${p!.pageToken}`))).toBe(true);
    expect(await h.m.passenger(p!.pageToken!)).toBeDefined();
    await h.inbound('când să fiu la aeroport?');
    expect((await h.agent.profile('+40712345678'))?.pageToken).toBe(p!.pageToken);
  });

  it('keeps tokens across restarts and rebindings, respects bag choice, and revokes on deletion', async () => {
    quiet();
    const { view } = fakeSim([row(), row({ flight: 'W6 3401' })]);
    const h = harness(view, { APP_URL: 'https://passenger.example/' });
    await h.inbound('START W6 3751 a8f2');
    const sub = { channel: 'whatsapp' as const, phone: '+40712345678' };
    const link = await h.m.pageLink(sub);
    expect(link).toMatch(/^https:\/\/passenger.example\/m\/[a-f0-9-]{36}$/);
    const token = link.split('/').at(-1)!;
    const profile = await h.agent.profile(sub.phone);
    expect(profile?.token).toBe('a8f2');
    await h.store.put(`wa:profile:${sub.phone}`, { ...profile, hasCheckedBag: false });
    const restarted = new WhatsAppAgent({ APP_URL: 'https://passenger.example' }, h.store, view, { pause: 0 });
    expect(await restarted.messaging.pageLink(sub)).toBe(link);
    const data = await restarted.messaging.passenger(token);
    expect(data?.steps.map(s => s.zone)).toEqual(['security', 'walk']);
    expect(data?.arriveBy).toBe(arrivalPlan(view.flights()[0]!, view.flow(), view.clock(), false).beAtEntranceAt);
    expect(JSON.stringify(data)).not.toContain(sub.phone);
    await h.inbound('START W6 3401');
    expect(await h.m.pageLink(sub)).toBe(link);
    expect((await h.m.passenger(token))?.flight.flight).toBe('W6 3401');
    await h.inbound('delete my data');
    expect(await h.m.passenger(token)).toBeUndefined();
    expect(h.store.data.has(`page:${token}`)).toBe(false);
    expect(h.store.data.has(`msg:alerts:wa:${sub.phone}`)).toBe(false);
  });

  it('excludes undelivered alerts and persists evacuation plans', async () => {
    quiet();
    const { view } = fakeSim();
    const h = harness(view);
    const sub = { channel: 'sim' as const, agentId: 'page-agent', role: 'passenger', flight: 'W6 3751' };
    await h.m.registerSims([sub]);
    const token = (await h.m.pageLink(sub)).split('/').at(-1)!;
    const offline = new Messaging({ store: h.store, wa: h.agent.wa, view, toUnity: () => false });
    expect(await offline.notify(sub, { kind: 'admin', text: 'Unsent' })).toBe('offline');
    expect((await offline.passenger(token))?.alerts).toHaveLength(1);
    await h.m.plan({ id: 'page-evac', blocked: ['security'], clearSec: 10, exits: [], routes: [{ from: 'entrance', exit: 'exit_1', nodes: ['entrance', 'exit_1'] }] });
    expect((await offline.passenger(token))?.evacuation).toEqual({ active: true, zones: ['security'] });
  });
});

function harness(view: AirportView, env: Record<string, string> = { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'PN1' }) {
  const store = new MemoryStore();
  const graph: any[] = [];
  const unity: { type: string; data: any }[] = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { graph.push(JSON.parse(String(init?.body))); return Response.json({}); });
  const agent = new WhatsAppAgent(env, store, view, { fetcher, pause: 0, toUnity: (type, data) => { unity.push({ type, data }); return true; }, evacWaitMs: 20 });
  const texts = () => graph.filter(b => b.type === 'text').map(b => ({ to: b.to, text: b.text.body as string }));
  const inbound = (text: string, from = '40712345678') => agent.inbound({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' },
    messages: [{ id: `wamid.${Math.random()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return { agent, store, graph, unity, texts, inbound, m: agent.messaging };
}

describe('flight.update wiring (D14)', () => {
  it('reads Unity flights from the sim store, seconds or HH:MM, and falls back to the fixture', () => {
    expect(simSeconds('14:20')).toBe(hm(14, 20));
    expect(simSeconds('14:20:30')).toBe(hm(14, 20) + 30);
    expect(simSeconds(51000)).toBe(51000);
    expect(simSeconds('25:99')).toBeNaN();
    const { state, view } = fakeSim([row(), row({ flight: 'RO 642', airline: 'RO', std: 'x' }), row({ flight: 'FR 1', airline: 'FR', gateCloseAt: null, std: hm(12, 0) })]);
    expect(view.provisional()).toBe(false);
    expect(view.flights().map(f => [f.flight, f.std, f.gateCloseAt, f.checkIn])).toEqual([
      ['W6 3751', hm(9, 40), hm(9, 10), 'check_in:2'],
      ['FR 1', hm(12, 0), hm(11, 30), 'check_in:2'], // no gateCloseAt: 30 min before departure; unreadable std skipped
    ]);
    state.flights = [];
    expect(view.provisional()).toBe(true);
    expect(view.flights()).toBe(PROVISIONAL_FLIGHTS);
    expect(PROVISIONAL_FLIGHTS.every(f => /^check_in:\d+$/.test(f.checkIn!) && /^gate_\d$/.test(f.gate))).toBe(true);
  });
  it('whenToArrive uses the desk group of the flight (check_in:2, bag_drop:2) and the delay', async () => {
    const { view } = fakeSim([row()], { 'bag_drop:1': { waiting: 90, waitMin: 40 }, 'bag_drop:2': { waiting: 20, waitMin: 8 }, security: { waiting: 30, waitMin: 12 } });
    let profile: Profile = { phone: '+40712345678', role: 'passenger', flight: 'W6 3751', hasCheckedBag: true };
    const tools = toolsFor({ view, profile: () => profile, save: async p => { profile = { ...profile, ...p }; } });
    const plan = await tools.whenToArrive!({}) as any;
    // 8 (bag_drop:2) + 12 + 4 + 10 = 34 before 09:10 = 08:36 -> 08:35.
    expect(plan.steps[0]).toMatchObject({ step: 'Predare bagaje, grupul 2', min: 8 });
    expect(plan.beAtEntranceAt).toBe('08:35');
    expect((await tools.queues!({}) as any).zones.filter((z: any) => z.yours).map((z: any) => z.zone)).toEqual(['Predare bagaje, grupul 2']);
    const delayed = fromSim([row({ status: 'delayed', delayMin: 45 })])[0]!;
    expect(arrivalPlan(delayed, view.flow(), view.clock(), true)).toMatchObject({ gateCloseAt: '09:55', beAtEntranceAt: '09:20' });
  });
});

describe('agent.register for simulated subscribers (D17)', () => {
  it('splits sim entries from the legacy shape and validates them', () => {
    expect(splitRegister({ agentId: 'a1', role: 'passenger_terminal', channel: 'sim', flight: 'W6 3751' })).toEqual({ sims: [{ agentId: 'a1', role: 'passenger_terminal', flight: 'W6 3751' }], rest: null });
    const legacy = { agents: [{ agentId: 'u1', role: 'taxi', channel: 'whatsapp' }] };
    expect(splitRegister(legacy)).toEqual({ sims: [], rest: legacy });
    const mixed = splitRegister({ agents: [{ agentId: 'u1', role: 'taxi', channel: 'whatsapp' }, { agentId: 'a2', role: 'p', channel: 'sim', flight: 'RO 1' }] });
    expect(mixed).toEqual({ sims: [{ agentId: 'a2', role: 'p', flight: 'RO 1' }], rest: { agents: [{ agentId: 'u1', role: 'taxi', channel: 'whatsapp' }] } });
    expect(() => splitRegister({ agentId: 'a1', role: 'p', channel: 'sim' })).toThrow('Invalid sim agent');
    expect(() => splitRegister({ agents: [{ agentId: '', role: 'p', channel: 'sim', flight: 'W6 1' }] })).toThrow();
  });
  it('sends the arrive message once per agent, as agent.message', async () => {
    const { view } = fakeSim();
    const h = harness(view);
    expect(await h.m.registerSims([{ agentId: 'a1', role: 'passenger_terminal', flight: 'W6 3751' }, { agentId: 'a2', role: 'p', flight: 'XX 1' }])).toBe(2);
    expect(await h.m.registerSims([{ agentId: 'a1', role: 'passenger_terminal', flight: 'W6 3751' }])).toBe(0);
    expect(h.unity).toEqual([{ type: 'agent.message', data: { agentId: 'a1', kind: 'arrive', text: expect.stringMatching(/^Fii la intrarea în terminal la 08:30 \(ora simulării\)\. Zborul W6 3751 .*poarta 2 se închide la 09:10/) } }]);
  });
});

describe('notify (D17)', () => {
  it('routes to WhatsApp inside the 24h window, skips outside it, and to Unity for sim', async () => {
    quiet();
    const h = harness(fakeSim().view);
    await h.store.put('wa:last:+40700000001', Date.now() - 3600000);
    await h.store.put('wa:last:+40700000002', Date.now() - 90000000);
    expect(await h.m.notify({ channel: 'whatsapp', phone: '+40700000001' }, { kind: 'admin', text: 'a' })).toBe('sent');
    expect(await h.m.notify({ channel: 'whatsapp', phone: '+40700000002' }, { kind: 'admin', text: 'b' })).toBe('outside_window');
    expect(await h.m.notify({ channel: 'sim', agentId: 'a1', role: 'p', flight: 'W6 3751' }, { kind: 'route', text: 'c' })).toBe('sent');
    expect(h.texts()).toEqual([{ to: '40700000001', text: 'a' }]);
    expect(h.unity).toEqual([{ type: 'agent.message', data: { agentId: 'a1', text: 'c', kind: 'route' } }]);
  });
});

describe('automatic flight messages (D14, D18 beat 3)', () => {
  it('announces a delay once per change to WhatsApp and sim subscribers of that flight only', async () => {
    quiet();
    const sim = fakeSim([row(), row({ flight: 'RO 642', airline: 'RO' })]);
    const h = harness(sim.view);
    await h.inbound('START W6 3751');
    await h.inbound('START RO 642', '40799999999');
    await h.m.registerSims([{ agentId: 'a1', role: 'p', flight: 'W6 3751' }]);
    h.graph.length = 0; h.unity.length = 0;

    expect(await h.m.flightsChanged()).toEqual([]);
    sim.state.flights = [row({ status: 'delayed', delayMin: 45 }), row({ flight: 'RO 642', airline: 'RO' })];
    expect(await h.m.flightsChanged()).toEqual(['W6 3751']);
    // Unity resends the same schedule (reconnect): nothing new goes out.
    expect(await h.m.flightsChanged()).toEqual([]);
    const wa = h.texts();
    expect(wa).toHaveLength(1);
    expect(wa[0]!.to).toBe('40712345678');
    expect(wa[0]!.text).toContain('întârziere de 45 min. Pleacă la 10:25 în loc de 09:40, poarta 2 se închide la 09:55 (ora simulării). Fii la intrarea în terminal la 09:');
    expect(h.unity).toEqual([{ type: 'agent.message', data: { agentId: 'a1', kind: 'flight', text: expect.stringContaining('întârziere de 45 min') } }]);

    sim.state.flights = [row({ status: 'delayed', delayMin: 60 }), row({ flight: 'RO 642', airline: 'RO', status: 'cancelled' })];
    expect(await h.m.flightsChanged()).toEqual(['W6 3751', 'RO 642']);
    expect(h.texts().at(-1)).toEqual({ to: '40799999999', text: expect.stringContaining('RO 642 spre Londra Luton a fost anulat') });
    expect(h.unity).toHaveLength(2);
  });
});

describe('staff reports (D11, D18 beat 4)', () => {
  it('extracts kind and place', () => {
    expect(classifyIssue('Bagaj abandonat lângă check-in Wizz')).toBe('bagaj_abandonat');
    expect(classifyIssue('un domn a leșinat la poarta 3')).toBe('medical');
    expect(classifyIssue('bătaie la poarta 3')).toBe('securitate');
    expect(classifyIssue('e foarte aglomerat la control')).toBe('aglomerare');
    const flights: Flight[] = fromSim([row()]);
    expect(matchNode('lângă check-in Wizz', flights)).toBe('check_in:2');
    expect(matchNode('la check-in grupul 1')).toBe('check_in:1');
    expect(matchNode('bag drop 2')).toBe('bag_drop:2');
    expect(matchNode('poarta 3')).toBe('gate_3');
    expect(matchNode('la controlul de securitate')).toBe('security');
    expect(matchNode('nu știu')).toBeNull();
  });
  it('STAFF <code> grants the role; a report is stored and confirmed (no LLM)', async () => {
    quiet();
    const h = harness(fakeSim().view);
    expect(parseStaff('staff CRAIOVA2026')).toBe('CRAIOVA2026');
    await h.inbound('STAFF gresit');
    expect((await h.store.get<Profile>('wa:profile:+40712345678'))!.role).toBe('passenger');
    await h.inbound('bagaj abandonat lângă check-in Wizz');
    expect(await h.agent.reports.list()).toEqual([]);
    await h.inbound('STAFF craiova2026');
    expect((await h.store.get<Profile>('wa:profile:+40712345678'))!.role).toBe('staff');
    await h.inbound('Bagaj abandonat lângă check-in Wizz');
    const [r] = await h.agent.reports.list();
    expect(r).toEqual({ id: 'R1', at: expect.any(String), kind: 'bagaj_abandonat', node: 'check_in:2', text: 'Bagaj abandonat lângă check-in Wizz', status: 'open', etaMin: 1 });
    expect(Object.keys(r!)).toEqual(['id', 'at', 'kind', 'node', 'text', 'status', 'etaMin']);
    expect(h.texts().at(-1)!.text).toBe('Am primit (R1): bagaj abandonat, Check-in, grupul 2. Raportul e pe harta din dashboard. Echipa de intervenție a fost anunțată. Echipa ajunge în ~1 min');
    expect((await h.agent.reports.close('R1'))!.status).toBe('closed');
    expect(await h.agent.reports.close('R9')).toBeUndefined();
  });
  it('honours STAFF_CODE from env', async () => {
    quiet();
    const h = harness(fakeSim().view, { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'PN1', STAFF_CODE: 'secret-1' });
    await h.inbound('STAFF craiova2026');
    expect((await h.store.get<Profile>('wa:profile:+40712345678'))!.role).toBe('passenger');
    await h.inbound('STAFF secret-1');
    expect((await h.store.get<Profile>('wa:profile:+40712345678'))!.role).toBe('staff');
  });
});

describe('evacuation (D10, A10)', () => {
  const plan = (extra: Partial<EvacPlan> = {}): EvacPlan => ({
    id: 'ops-1', blocked: ['check_in:2'], clearSec: 140, exits: [{ exit: 'exit_1', people: 40, clearSec: 90 }, { exit: 'exit_2', people: 30, clearSec: 140 }],
    routes: [{ from: 'entrance', exit: 'exit_1', nodes: ['entrance', 'exit_1'] }, { from: 'airside', exit: 'exit_2', nodes: ['airside', 'exit_2'] }, { from: 'gate_2', exit: 'exit_2', nodes: ['gate_2', 'airside', 'exit_2'] }],
    ...extra,
  });
  it('validates evac.plan', () => {
    expect(evacPlan(plan())).toEqual(plan());
    for (const bad of [{ id: '' }, { blocked: ['Check In'] }, { clearSec: -1 }, { routes: [] }, { routes: [{ from: 'entrance', exit: 'exit_1', nodes: [] }] }, { exits: [{ exit: 'exit_1', people: 1.5, clearSec: 1 }] }])
      expect(() => evacPlan({ ...plan(), ...bad })).toThrow('Invalid evac plan');
  });
  it('picks the route for the estimated stage', () => {
    const f = fromSim([row()])[0]!; // gate closes 09:10
    expect(estimateStage(f, hm(7, 0))).toBe('public');
    expect(estimateStage(f, hm(8, 30))).toBe('airside');
    expect(estimateStage(f, hm(9, 0))).toBe('gate');
    expect(routeFor(plan(), f, hm(7, 0)).from).toBe('entrance');
    expect(routeFor(plan(), f, hm(8, 30)).from).toBe('airside');
    expect(routeFor(plan(), f, hm(9, 0)).from).toBe('gate_2');
    expect(routeFor(plan(), undefined, hm(9, 0)).from).toBe('entrance');
  });
  it('without evac.plan, everyone gets the generic message after the wait', async () => {
    quiet();
    const h = harness(fakeSim().view);
    await h.inbound('START W6 3751');
    await h.m.registerSims([{ agentId: 'a1', role: 'p', flight: 'W6 3751' }]);
    h.graph.length = 0; h.unity.length = 0;
    expect(await h.m.evacuate(['check_in:2', 'security'], 'ops-0')).toBe('generic');
    const text = 'Evacuare: Check-in, grupul 2, Control de securitate sunt închise. Părăsește zona și urmează indicatoarele spre cea mai apropiată ieșire.';
    expect(h.texts()[0]!.text).toContain(text);
    expect(h.unity).toEqual([{ type: 'agent.message', data: { agentId: 'a1', kind: 'evacuate', text: expect.stringContaining(text) } }]);
  });
  it('with evac.plan in time, each subscriber gets its route and sim agents walk it', async () => {
    quiet();
    const h = harness(fakeSim().view); // sim clock 07:00: stage public -> route from entrance
    await h.inbound('START W6 3751');
    await h.m.registerSims([{ agentId: 'a1', role: 'p', flight: 'W6 3751' }]);
    h.graph.length = 0; h.unity.length = 0;
    const generic = h.m.evacuate(['check_in:2'], 'ops-1');
    expect(await h.m.plan(plan())).toBe(2);
    expect(await generic).toBe('planned');
    expect(h.texts()).toEqual([{ to: '40712345678', text: '⚠️ Evacuare: Check-in, grupul 2 e închisă. Ieși pe Ieșirea 1: Intrarea → Ieșirea 1. Urmează indicatoarele și personalul.' }]);
    expect(h.unity).toEqual([
      { type: 'agent.message', data: { agentId: 'a1', kind: 'evacuate', text: expect.stringContaining('Ieși pe Ieșirea 1') } },
      { type: 'agent.route', data: { agentId: 'a1', nodes: ['entrance', 'exit_1'], reason: 'evacuate' } },
    ]);
  });
});

it('the WhatsApp client is still inert without secrets', async () => {
  quiet();
  expect((await new WhatsAppClient({}).sendText('+40700000000', 'x')).dryRun).toBe(true);
});

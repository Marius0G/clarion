import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validWhatsAppSignature } from '../src/channels.js';
import { WhatsAppAgent, parseStart, type WaStore } from '../src/wa/index.js';
import { PROVISIONAL_FLIGHTS, clockFrom, clockText, findFlight, type Flight } from '../src/wa/flights.js';
import { arrivalPlan, toolsFor, waitAt, type AirportView, type Profile, type ZoneRow } from '../src/wa/tools.js';
import { fallbackReply, paceReactions, toBubbles } from '../src/wa/agent.js';
import { parseWebhook, redact, splitText } from '../src/wa/transport.js';

const hm = (h: number, m: number) => h * 3600 + m * 60;
const W6 = findFlight(PROVISIONAL_FLIGHTS, 'W6 3751')!; // gate G2 (4 min walk), closes 09:10
const sim7 = { now: hm(7, 0), sim: true };

class MemoryStore implements WaStore {
  data = new Map<string, unknown>();
  async get<T>(k: string) { return this.data.get(k) as T | undefined; }
  async put(k: string, v: unknown) { this.data.set(k, structuredClone(v)); }
  async delete(k: string) { return this.data.delete(k); }
}
function view(flow: Record<string, ZoneRow> = {}, flights: readonly Flight[] = PROVISIONAL_FLIGHTS): AirportView {
  return { clock: () => sim7, flow: () => flow, flights: () => flights, provisional: () => true };
}
const inbound = (text: string, extra: Record<string, unknown> = {}, id = `wamid.${Math.random()}`) => ({
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: '40712345678', profile: { name: 'Ana' } }],
    messages: [{ id, from: '40712345678', timestamp: '1793440000', type: 'text', text: { body: text }, ...extra }] } }] }],
});
afterEach(() => vi.restoreAllMocks());

describe('webhook signature', () => {
  it('accepts only HMAC-SHA256 of the raw body with the app secret', async () => {
    const body = JSON.stringify(inbound('salut'));
    const good = 'sha256=' + createHmac('sha256', 'app-secret').update(body).digest('hex');
    expect(await validWhatsAppSignature(body, good, 'app-secret')).toBe(true);
    expect(await validWhatsAppSignature(body, good, 'other-secret')).toBe(false);
    expect(await validWhatsAppSignature(body + ' ', good, 'app-secret')).toBe(false);
    expect(await validWhatsAppSignature(body, null, 'app-secret')).toBe(false);
    expect(await validWhatsAppSignature(body, 'sha256=zz', 'app-secret')).toBe(false);
  });
});

describe('transport', () => {
  it('parses messages for our number only, oldest first, with names and button ids', () => {
    const tap = inbound('', { type: 'interactive', text: undefined, interactive: { button_reply: { id: 'bag:yes', title: 'Da, am bagaj' } } });
    expect(parseWebhook(tap, 'PN1')[0]).toMatchObject({ phone: '+40712345678', name: 'Ana', text: 'Da, am bagaj', replyId: 'bag:yes' });
    expect(parseWebhook(tap, 'OTHER')).toEqual([]);
    expect(parseWebhook(inbound('x', { type: 'image', text: undefined }), 'PN1')[0]!.text).toBeNull();
  });
  it('redacts card numbers and splits long text on sentence ends', () => {
    expect(redact('cardul 4111 1111 1111 1111')).toBe('cardul [număr de card eliminat]');
    expect(splitText('Unu. '.repeat(1000), 4000).every(p => p.length <= 4000)).toBe(true);
  });
});

describe('START binding', () => {
  it('parses START <flight> <token>', () => {
    expect(parseStart('START W6 3751 a8f2')).toEqual({ flight: 'W6 3751', token: 'a8f2' });
    expect(parseStart('start w63751')).toEqual({ flight: 'W6 3751', token: undefined });
    expect(parseStart('START TAXI')).toBeUndefined();
    expect(parseStart('vreau START W6 3751')).toBeUndefined();
  });
});

describe('whenToArrive (D5)', () => {
  it('gate close − (bag drop + security + walk + 10 min margin), floored to 5 minutes', () => {
    const flow = { 'bag_drop:W6': { waiting: 30, waitMin: 12 }, bag_drop: { waiting: 90, waitMin: 40 }, security: { waiting: 50, waitMin: 18 } };
    const p = arrivalPlan(W6, flow, sim7, true);
    // 12 + 18 + 4 + 10 = 44 min before 09:10 = 08:26 -> 08:25. The airline's own queue wins over the shared one (D8).
    expect(p.totalMin).toBe(44);
    expect(p.beAtEntranceAt).toBe('08:25');
    expect(p.gateCloseAt).toBe('09:10');
    expect(p.minutesFromNow).toBe(85);
    expect(p.steps.map(s => s.step)).toEqual(['Predare bagaje W6', 'Control de securitate', 'Drum până la poarta G2', 'Marjă']);
    expect(p.clock).toBe('ora simulării');
    // Hand luggage only: no bag drop. 18 + 4 + 10 = 32 -> 08:38 -> 08:35.
    expect(arrivalPlan(W6, flow, sim7, false).beAtEntranceAt).toBe('08:35');
  });
  it('uses the forecast for the time he gets there', () => {
    const flow = { 'bag_drop:W6': { waiting: 30, waitMin: 12 }, security: { waiting: 50, waitMin: 18, forecast: [{ inMin: 60, waitMin: 30 }, { inMin: 120, waitMin: 40 }] } };
    const p = arrivalPlan(W6, flow, sim7, true);
    const security = p.steps.find(s => s.step === 'Control de securitate')!;
    expect(security.source).toBe('prognoză');
    // Arrival ≈ 70 min from now: 30 + 10 * (≈10/60) ≈ 32 min at security.
    expect(security.min).toBe(32);
    expect(p.beAtEntranceAt).toBe('08:10');
  });
  it('falls back to live wait, then a standard estimate', () => {
    expect(waitAt({ waiting: 5, waitMin: 7 }, 'security', 30)).toEqual({ min: 7, source: 'acum' });
    expect(waitAt(undefined, 'security', 30)).toEqual({ min: 15, source: 'estimare standard' });
    const p = arrivalPlan(W6, {}, sim7, undefined);
    expect(p.assumedCheckedBag).toBe(true);
    expect(p.beAtEntranceAt).toBe('08:25'); // 12 + 15 + 4 + 10 = 41 -> 08:29 -> 08:25
  });
  it('flags late when the time has passed', () => {
    expect(arrivalPlan(W6, {}, { now: hm(9, 0), sim: true }, false).late).toBe(true);
  });
  it('reads the simulated clock when Unity is connected, else Bucharest wall time', () => {
    expect(clockFrom(hm(14, 20), true)).toEqual({ now: hm(14, 20), sim: true });
    const wall = clockFrom(hm(14, 20), false, Date.UTC(2026, 9, 31, 12, 0));
    expect(wall.sim).toBe(false);
    expect(clockText(wall.now)).toBe('14:00'); // EET, UTC+2 after the DST change on 25 Oct
  });
});

describe('agent tools', () => {
  const setup = (p: Partial<Profile> = {}, flow: Record<string, ZoneRow> = {}, flights?: Flight[]) => {
    let profile: Profile = { phone: '+40712345678', role: 'passenger', ...p };
    const tools = toolsFor({ view: view(flow, flights), profile: () => profile, save: async patch => { profile = { ...profile, ...patch }; } });
    return { tools, profile: () => profile };
  };
  it('myFlight asks for the flight, then binds the one named in chat', async () => {
    const { tools, profile } = setup();
    expect(await tools.myFlight!({})).toMatchObject({ error: 'no_flight' });
    expect(await tools.myFlight!({ flight: 'XX 0001' })).toMatchObject({ error: 'unknown_flight' });
    expect(await tools.myFlight!({ flight: 'w6-3751' })).toMatchObject({ flight: 'W6 3751', gate: 'G2', gateCloseAt: '09:10', departure: '09:40', note: expect.stringContaining('provizoriu') });
    expect(profile()).toMatchObject({ flight: 'W6 3751', airline: 'W6', verified: false });
  });
  it('whenToArrive saves the bag answer and handles cancelled flights', async () => {
    const { tools, profile } = setup({ flight: 'W6 3751', airline: 'W6' });
    // No live flow: 15 (standard security) + 4 + 10 = 29 -> 08:41 -> 08:40.
    expect(await tools.whenToArrive!({ hasCheckedBag: false })).toMatchObject({ beAtEntranceAt: '08:40', assumedCheckedBag: false });
    expect(profile().hasCheckedBag).toBe(false);
    const cancelled = PROVISIONAL_FLIGHTS.map(f => (f.flight === 'W6 3751' ? { ...f, status: 'cancelled' as const } : f));
    expect(await setup({ flight: 'W6 3751' }, {}, cancelled).tools.whenToArrive!({})).toMatchObject({ status: 'cancelled' });
  });
  it('queues marks the passenger airline queue; stubs answer politely', async () => {
    const { tools } = setup({ airline: 'W6' }, { 'check_in:W6': { waiting: 12, waitMin: 6, peak: 20 }, security: { waiting: 40, waitMin: 14, staff: 3 } });
    const q = await tools.queues!({}) as any;
    expect(q.zones).toEqual([
      { zone: 'Check-in W6', waiting: 12, waitMin: 6, peak30min: 20, staff: undefined, yours: true },
      { zone: 'Control de securitate', waiting: 40, waitMin: 14, peak30min: undefined, staff: 3 },
    ]);
    expect(await setup().tools.queues!({})).toMatchObject({ available: false });
    expect(await tools.routeTo!({ to: 'gate' })).toMatchObject({ status: 'coming_soon' });
    expect(await tools.reportIssue!({ text: 'bagaj abandonat' })).toMatchObject({ error: 'staff_only' });
    expect(await setup({ role: 'staff' }).tools.reportIssue!({ text: 'x' })).toMatchObject({ status: 'coming_soon' });
  });
  it('the no-key fallback answers from the same tools', async () => {
    const { tools } = setup({ flight: 'W6 3751', airline: 'W6', hasCheckedBag: true });
    expect((await fallbackReply('cand sa fiu la aeroport?', tools))[0]).toContain('08:25');
    expect((await fallbackReply('de la ce poarta plec?', tools))[0]).toContain('poarta G2');
  });
});

describe('bubbles', () => {
  it('splits on --- and turns a lone emoji into a reaction', () => {
    expect(toBubbles('[react]⏱️\n---\nFii la 08:25.\n---\n✈️')).toEqual(['[react]⏱️', 'Fii la 08:25.', '[react]✈️']);
    expect(paceReactions(['[react]⏱️', 'Fii la 08:25.'], [], 0)).toEqual(['[react]⏱️', 'Fii la 08:25.']);
    expect(paceReactions(['[react]⏱️', 'Fii la 08:25.'], [], 0.99)).toEqual(['Fii la 08:25.']);
  });
});

describe('WhatsAppAgent turn', () => {
  type Call = { url: string; body: any };
  function harness(env: Record<string, string>, claude: any[] = []) {
    const calls: Call[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      if (url.startsWith('https://api.anthropic.com')) { const next = claude.shift(); return next ? Response.json(next) : new Response('overloaded', { status: 529 }); }
      return Response.json({ messages: [{ id: 'wamid.out' }] });
    });
    const store = new MemoryStore();
    const flow = { 'bag_drop:W6': { waiting: 30, waitMin: 12 }, security: { waiting: 50, waitMin: 18 } };
    const agent = new WhatsAppAgent(env, store, view(flow), { fetcher, pause: 0 });
    const meta = () => calls.filter(c => c.url.startsWith('https://graph.facebook.com')).map(c => c.body);
    return { agent, store, calls, meta };
  }
  const live = { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'PN1' };

  it('stays inert without secrets: dry-run logs, no network, deterministic answer', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { agent, store, calls } = harness({});
    await agent.inbound(inbound('START W6 3751 a8f2'));
    await agent.inbound(inbound('cand sa vin?'));
    expect(calls).toEqual([]);
    expect(log.mock.calls.some(c => String(c[0]).includes('"dry-run"'))).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain('cand sa vin');
    expect(await store.get('wa:profile:+40712345678')).toMatchObject({ flight: 'W6 3751' });
  });

  it('START binds phone to flight, opens the 24h window and asks about the bag', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { agent, store, meta } = harness(live);
    await agent.inbound(inbound('START W6 3751 a8f2', {}, 'wamid.start'));
    expect(await store.get('wa:profile:+40712345678')).toMatchObject({
      phone: '+40712345678', flight: 'W6 3751', airline: 'W6', role: 'passenger', token: 'a8f2', verified: true, name: 'Ana', lastInboundAt: 1793440000000,
    });
    expect(await store.get('wa:last:+40712345678')).toBe(1793440000000);
    expect(await agent.withinWindow('+40712345678', 1793440000000 + 3600000)).toBe(true);
    expect(await agent.withinWindow('+40712345678', 1793440000000 + 86400001)).toBe(false);
    const sent = meta();
    expect(sent[0]).toMatchObject({ status: 'read', message_id: 'wamid.start', typing_indicator: { type: 'text' } });
    expect(sent.find(b => b.type === 'text')?.text.body).toContain('W6 3751 spre Londra Luton');
    expect(sent.find(b => b.type === 'interactive')?.interactive.action.buttons.map((b: any) => b.reply.id)).toEqual(['bag:yes', 'bag:no']);
    // An unknown flight does not bind.
    const other = harness(live);
    await other.agent.inbound(inbound('START XX 9999 abcd'));
    expect((await other.store.get<Profile>('wa:profile:+40712345678'))?.flight).toBeUndefined();
  });

  it('runs the Claude tool loop and sends the bubbles as reaction + texts', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { agent, store, calls, meta } = harness({ ...live, ANTHROPIC_API_KEY: 'k' }, [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'whenToArrive', input: { hasCheckedBag: true } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '[react]⏱️\n---\nFii la intrare la 08:25.\n---\nPoarta G2 se închide la 09:10.' }] },
    ]);
    await store.put('wa:profile:+40712345678', { phone: '+40712345678', role: 'passenger', flight: 'W6 3751', airline: 'W6' });
    await agent.inbound(inbound('cand trebuie sa fiu la aeroport?', {}, 'wamid.q'));
    const claude = calls.filter(c => c.url.startsWith('https://api.anthropic.com'));
    expect(claude[0]!.body).toMatchObject({ model: 'claude-sonnet-5-5', tools: expect.arrayContaining([expect.objectContaining({ name: 'whenToArrive' })]) });
    expect(claude[0]!.body.system[1].text).toContain('Zbor: W6 3751');
    const toolResult = JSON.parse(claude[1]!.body.messages.at(-1).content[0].content);
    expect(toolResult).toMatchObject({ beAtEntranceAt: '08:25', gateCloseAt: '09:10' });
    const sent = meta();
    expect(sent.filter(b => b.type === 'reaction').map(b => b.reaction.emoji)).toEqual(['👀', '⏱️']);
    expect(sent.filter(b => b.type === 'text').map(b => b.text.body)).toEqual(['Fii la intrare la 08:25.', 'Poarta G2 se închide la 09:10.']);
    expect((await store.get<any>('wa:ctx:+40712345678')).history.map((h: any) => h.role)).toEqual(['user', 'clarion', 'clarion', 'clarion']);
    expect((await store.get<Profile>('wa:profile:+40712345678'))!.hasCheckedBag).toBe(true);
  });

  it('a bag button tap is saved and answered with the arrival time', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { agent, store, meta } = harness(live);
    await store.put('wa:profile:+40712345678', { phone: '+40712345678', role: 'passenger', flight: 'W6 3751', airline: 'W6' });
    await agent.inbound(inbound('', { type: 'interactive', text: undefined, interactive: { button_reply: { id: 'bag:no', title: 'Doar de mână' } } }));
    expect((await store.get<Profile>('wa:profile:+40712345678'))!.hasCheckedBag).toBe(false);
    expect(meta().find(b => b.type === 'text')?.text.body).toContain('08:35');
  });

  it('answers the fallback when Claude fails, and respects WA_ALLOWLIST', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = harness({ ...live, ANTHROPIC_API_KEY: 'k' });
    await failing.agent.inbound(inbound('salut, ce faci?'));
    expect(failing.meta().find(b => b.type === 'text')?.text.body).toContain('problemă tehnică');
    const blocked = harness({ ...live, WA_ALLOWLIST: '+40700000000' });
    await blocked.agent.inbound(inbound('salut'));
    expect(blocked.calls).toEqual([]);
  });
});

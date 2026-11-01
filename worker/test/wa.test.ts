import { JOIN_TTL_MS, joinKey } from '../src/join.js';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validWhatsAppSignature } from '../src/channels.js';
import { WhatsAppAgent, parseStart, type WaStore } from '../src/wa/index.js';
import { PROVISIONAL_FLIGHTS, clockFrom, clockText, findFlight, type Flight } from '../src/wa/flights.js';
import { arrivalPlan, toolsFor, waitAt, type AirportView, type Profile, type ZoneRow } from '../src/wa/tools.js';
import { fallbackReply, paceReactions, toBubbles, reply } from '../src/wa/agent.js';
import { parseWebhook, redact, splitText } from '../src/wa/transport.js';

const hm = (h: number, m: number) => h * 3600 + m * 60;
const W6 = findFlight(PROVISIONAL_FLIGHTS, 'W6 3751')!; // gate_2 (4 min walk), desk group check_in:1, closes 09:10
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
    const flow = { 'bag_drop:1': { waiting: 30, waitMin: 12 }, 'bag_drop:2': { waiting: 90, waitMin: 40 }, bag_drop: { waiting: 90, waitMin: 40 }, security: { waiting: 50, waitMin: 18 } };
    const p = arrivalPlan(W6, flow, sim7, true);
    // 12 + 18 + 2 + 10 = 42 min before 09:10 = 08:28 -> 08:25. The flight's desk group wins over other groups and the shared one (D8).
    expect(p.totalMin).toBe(42);
    expect(p.beAtEntranceAt).toBe('08:25');
    expect(p.gateCloseAt).toBe('09:10');
    expect(p.minutesFromNow).toBe(85);
    expect(p.steps.map(s => s.step)).toEqual(['Predare bagaje, grupul 1', 'Control de securitate', 'Drum până la poarta 2', 'Marjă']);
    expect(p.clock).toBe('ora simulării');
    // Hand luggage only: no bag drop. 18 + 2 + 10 = 30 -> 08:40 -> 08:40.
    expect(arrivalPlan(W6, flow, sim7, false).beAtEntranceAt).toBe('08:40');
  });
  it('uses the forecast for the time he gets there', () => {
    const flow = { 'bag_drop:1': { waiting: 30, waitMin: 12 }, security: { waiting: 50, waitMin: 18, forecast: [{ inMin: 60, waitMin: 30 }, { inMin: 120, waitMin: 40 }] } };
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
    expect(p.beAtEntranceAt).toBe('08:30'); // 12 + 15 + 2 + 10 = 39 -> 08:31 -> 08:30
  });
  it('flags late when the time has passed', () => {
    expect(arrivalPlan(W6, {}, { now: hm(9, 0), sim: true }, false).late).toBe(true);
  });
  it('keeps the simulation clock after Unity disconnects', () => {
    expect(clockFrom(hm(14, 20), true)).toEqual({ now: hm(14, 20), sim: true });
    const wall = clockFrom(hm(14, 20), false, Date.UTC(2026, 9, 31, 12, 0));
    expect(wall.sim).toBe(true);
    expect(clockText(wall.now)).toBe('14:20'); // EET, UTC+2 after the DST change on 25 Oct
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
    expect(await tools.myFlight!({ flight: 'w6-3751' })).toMatchObject({ flight: 'W6 3751', gate: '2', gateCloseAt: '09:10', departure: '09:40', checkIn: ['Check-in, grupul 1'] });
    expect(profile()).toMatchObject({ flight: 'W6 3751', airline: 'W6', verified: false });
  });
  it('whenToArrive saves the bag answer and handles cancelled flights', async () => {
    const { tools, profile } = setup({ flight: 'W6 3751', airline: 'W6' });
    // No live flow: 15 (standard security) + 2 + 10 = 27 -> 08:43 -> 08:40.
    expect(await tools.whenToArrive!({ hasCheckedBag: false })).toMatchObject({ beAtEntranceAt: '08:40', assumedCheckedBag: false });
    expect(profile().hasCheckedBag).toBe(false);
    const cancelled = PROVISIONAL_FLIGHTS.map(f => (f.flight === 'W6 3751' ? { ...f, status: 'cancelled' as const } : f));
    expect(await setup({ flight: 'W6 3751' }, {}, cancelled).tools.whenToArrive!({})).toMatchObject({ status: 'cancelled' });
  });
  it('queues marks the queue of the passenger desk group; routes and staff-only tools answer appropriately', async () => {
    const { tools } = setup({ flight: 'W6 3751', airline: 'W6' }, { 'check_in:1': { waiting: 12, waitMin: 6, peak: 20 }, 'check_in:2': { waiting: 3, waitMin: 1 }, security: { waiting: 40, waitMin: 14, staff: 3 } });
    const q = await tools.queues!({}) as any;
    expect(q.zones).toEqual([
      { zone: 'Check-in, grupul 1', waiting: 12, waitMin: 6, peak30min: 20, staff: undefined, yours: true },
      { zone: 'Check-in, grupul 2', waiting: 3, waitMin: 1, peak30min: undefined, staff: undefined },
      { zone: 'Control de securitate', waiting: 40, waitMin: 14, peak30min: undefined, staff: 3 },
    ]);
    expect(await setup().tools.queues!({})).toMatchObject({ available: false });
    expect(await tools.routeTo!({ to: 'gate', from: 'Intrare plecări' })).toMatchObject({ status: 'ready' });
    expect(await tools.reportIssue!({ text: 'bagaj abandonat' })).toMatchObject({ error: 'staff_only' });
    expect(await setup({ role: 'staff' }).tools.reportIssue!({ text: 'x' })).toMatchObject({ error: 'unavailable' });
  });
  it('the no-key fallback answers from the same tools', async () => {
    const { tools } = setup({ flight: 'W6 3751', airline: 'W6', hasCheckedBag: true });
    expect((await fallbackReply('cand sa fiu la aeroport?', tools))[0]).toContain('~27 min la cozi');
    expect((await fallbackReply('de la ce poarta plec?', tools))[0]).toContain('poarta 2,');
  });
});

describe('bubbles', () => {
  it('splits on --- and turns a lone emoji into a reaction', () => {
    expect(toBubbles('[react]⏱️\n---\nFii la 08:25.\n---\n✈️')).toEqual(['[react]⏱️', 'Fii la 08:25.', '[react]✈️']);
    expect(paceReactions(['[react]⏱️', 'Fii la 08:25.'], [], 0)).toEqual(['[react]⏱️', 'Fii la 08:25.']);
    expect(paceReactions(['[react]⏱️', 'Fii la 08:25.'], [], 0.99)).toEqual(['Fii la 08:25.']);
  });
});

describe('tool-derived urgency', () => {
  it.each([
    ['myFlight', { status: 'delayed', delayMin: 20 }],
    ['myFlight', { status: 'cancelled' }],
    ['reportIssue', { status: 'sent' }],
  ])('filters a model reaction after %s regardless of the incoming wording', async (name, result) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const responses = [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name, input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '[react]👍\n---\nConfirmed 🙂' }] },
    ];
    const answer = await reply({
      env: { ANTHROPIC_API_KEY: 'k' }, fetcher: async () => Response.json(responses.shift()),
      profile: { phone: '+40712345678', role: 'passenger' }, clock: sim7, history: [], text: 'Details',
      tools: { [name]: async () => result },
    });
    expect(answer).toEqual({ bubbles: ['Confirmed'], used: [name] });
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
    const flow = { 'bag_drop:1': { waiting: 30, waitMin: 12 }, security: { waiting: 50, waitMin: 18 } };
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
    const token = 'a'.repeat(48);
    await store.put(joinKey(token), { flight: 'W6 3751', expiresAt: Date.now() + JOIN_TTL_MS });
    await agent.inbound(inbound(`START W6 3751 ${token}`, {}, 'wamid.start'));
    expect(await store.get('wa:profile:+40712345678')).toMatchObject({
      phone: '+40712345678', flight: 'W6 3751', airline: 'W6', role: 'passenger', verified: true, name: 'Ana', lastInboundAt: 1793440000000,
    });
    expect(await store.get('wa:last:+40712345678')).toBe(1793440000000);
    expect(await agent.withinWindow('+40712345678', 1793440000000 + 3600000)).toBe(true);
    expect(await agent.withinWindow('+40712345678', 1793440000000 + 86400001)).toBe(false);
    const sent = meta();
    expect(sent[0]).toMatchObject({ status: 'read', message_id: 'wamid.start', typing_indicator: { type: 'text' } });
    expect(sent.find(b => b.type === 'text')?.text.body).toContain('W6 3751 spre Londra Luton');
    expect(sent.find(b => b.type === 'interactive')?.interactive.action.buttons.map((b: any) => b.reply.id)).toEqual(['bag:yes', 'bag:no']);
    expect(await store.get(joinKey(token))).toBeUndefined();
    await agent.inbound(inbound(`START W6 3751 ${token}`));
    expect(await agent.profile('+40712345678')).toMatchObject({ flight: 'W6 3751', verified: false });
    // An unknown flight does not bind.
    const other = harness(live);
    await other.agent.inbound(inbound('START XX 9999 abcd'));
    expect((await other.store.get<Profile>('wa:profile:+40712345678'))?.flight).toBeUndefined();
  });

  it('binds unknown, expired, missing and mismatched tokens as unverified without consuming another flight token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { agent, store } = harness(live);
    for (const scenario of ['unknown', 'expired', 'mismatch', 'missing']) {
      const token = 'b'.repeat(48);
      if (scenario !== 'unknown') await store.put(joinKey(token), {
        flight: scenario === 'mismatch' ? 'W6 3401' : 'W6 3751',
        expiresAt: Date.now() + (scenario === 'expired' ? -1 : JOIN_TTL_MS),
      });
      await agent.inbound(inbound(`START W6 3751${scenario === 'missing' ? '' : ` ${token}`}`));
      expect(await agent.profile('+40712345678')).toMatchObject({ flight: 'W6 3751', verified: false });
      if (scenario === 'mismatch') expect(await store.get(joinKey(token))).toBeDefined();
    }
    expect(warn).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('b'.repeat(48));
  });

  it('runs the Claude tool loop and sends the bubbles as reaction + texts', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { agent, store, calls, meta } = harness({ ...live, ANTHROPIC_API_KEY: 'k' }, [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'whenToArrive', input: { hasCheckedBag: true } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '[react]⏱️\n---\nSecuritate: 12 min acum.\n---\nPoarta G2 se închide la 09:10.' }] },
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
    expect(sent.filter(b => b.type === 'text').map(b => b.text.body)).toEqual(['Securitate: 12 min acum.', 'Poarta G2 se închide la 09:10.']);
    expect((await store.get<any>('wa:ctx:+40712345678')).history.map((h: any) => h.role)).toEqual(['user', 'clarion', 'clarion', 'clarion']);
    expect((await store.get<Profile>('wa:profile:+40712345678'))!.hasCheckedBag).toBe(true);
  });

  it.each([
    ['ro', 'pasager', 'Evacuare la securitate?', 'routeTo'],
    ['en', 'pasager', 'Evacuation at security?', 'routeTo'],
    ['ro', 'pasager', 'Zborul e anulat?', 'myFlight'],
    ['en', 'pasager', 'Is my flight delayed?', 'myFlight'],
    ['ro', 'pasager', 'S-a schimbat poarta?', 'myFlight'],
    ['en', 'pasager', 'Has the gate changed?', 'myFlight'],
    ['ro', 'staff', 'Bagaj abandonat la poarta 3?', 'reportIssue'],
    ['en', 'staff', 'Unattended bag at gate 3?', 'reportIssue'],
  ])('suppresses all urgent reactions and emoji (%s, %s, %s)', async (lang, role, text, tool) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { agent, store, meta } = harness({ ...live, ANTHROPIC_API_KEY: 'k' }, [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'urgent', name: tool, input: { text, to: 'exit' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '[react]⚠️\n---\nReceived ⚠️. Exit 1 → 2. 👩🏽‍🚒 🇷🇴 1️⃣\n---\n🙏' }] },
    ]);
    await store.put('wa:profile:+40712345678', { phone: '+40712345678', role: role === 'staff' ? 'staff' : 'passenger', flight: 'W6 3751', lang, position: { node: 'entrance', at: sim7.now * 1000 } });
    await agent.inbound(inbound(text));
    expect(meta().filter(b => b.type === 'reaction')).toEqual([]);
    expect(meta().filter(b => b.type === 'text').map(b => b.text.body)).toEqual(['Received . Exit 1 → 2.']);
  });

  it('keeps the queue reaction and Moni prompt in English', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { agent, store, calls, meta } = harness({ ...live, ANTHROPIC_API_KEY: 'k' }, [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'q', name: 'queues', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '[react]👀\n---\nSecurity: 12 min now 🙂' }] },
    ]);
    await store.put('wa:profile:+40712345678', { phone: '+40712345678', role: 'passenger', lang: 'en' });
    await agent.inbound(inbound('Is the security queue long?'));
    expect(meta().filter(b => b.type === 'reaction').at(-1)?.reaction.emoji).toBe('👀');
    expect(meta().find(b => b.type === 'text')?.text.body).toBe('Security: 12 min now 🙂');
    const prompt = calls.find(c => c.url.startsWith('https://api.anthropic.com'))!.body.system[0].text;
    expect(prompt).toContain('Clarion: [react]👀');
    expect(prompt).toContain('no [react] bubble, no reactions and no emoji');
    expect(prompt).toContain("Their check-in desk group's queue has yours=true");
  });

  it('a bag button tap is saved and answered with the situation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { agent, store, meta } = harness(live);
    await store.put('wa:profile:+40712345678', { phone: '+40712345678', role: 'passenger', flight: 'W6 3751', airline: 'W6' });
    await agent.inbound(inbound('', { type: 'interactive', text: undefined, interactive: { button_reply: { id: 'bag:no', title: 'Doar de mână' } } }));
    expect((await store.get<Profile>('wa:profile:+40712345678'))!.hasCheckedBag).toBe(false);
    expect(meta().find(b => b.type === 'text')?.text.body).toContain('~18 min la cozi');
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

describe('passenger language (D23)', () => {
  // W6 3751 closes at 09:10 airport time; pin the wall clock to the morning so the flight is still ahead whenever CI runs.
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-01T06:00:00Z'), toFake: ['Date'] }); });
  afterEach(() => { vi.useRealTimers(); });
  const phone = '+40712345678';
  function languageHarness(key = '') {
    const store = new MemoryStore();
    const calls: any[] = [];
    const airport = view({ security: { waiting: 12, waitMin: 10, forecast: [{ inMin: 60, waitMin: 20 }] } });
    const agent = new WhatsAppAgent({ WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'PN1', ANTHROPIC_API_KEY: key }, store, airport, {
      pause: 0, fetcher: async (url, init) => {
        const body = JSON.parse(String(init?.body)); calls.push({ url, body });
        return Response.json(String(url).includes('anthropic') ? { content: [{ type: 'text', text: 'Your gate closes at 09:10.' }] } : {});
      },
    });
    const texts = () => calls.filter(c => c.body.type === 'text').map(c => c.body.text.body as string);
    return { agent, store, calls, texts, airport };
  }
  it.each(['English', 'eNgLiSh', 'EN', 'en'])('persists %s and switches back with Romanian aliases', async choice => {
    const { agent, texts } = languageHarness();
    await agent.inbound(inbound(choice));
    expect(await agent.profile(phone)).toMatchObject({ lang: 'en' });
    expect(texts().at(-1)).toBe('I will reply in English.');
    await agent.inbound(inbound('hello'));
    expect(texts().at(-1)).toContain('Craiova Airport');
    for (const ro of ['Română', 'rOmÂnĂ', 'RO']) {
      await agent.inbound(inbound(ro));
      expect(await agent.profile(phone)).toMatchObject({ lang: 'ro' });
      expect(texts().at(-1)).toBe('Voi răspunde în română.');
    }
  });
  it('applies an English join token before START, situation and bag replies, and rehydrates it for the page', async () => {
    const { agent, store, texts } = languageHarness();
    const token = 'e'.repeat(48);
    await store.put(joinKey(token), { flight: W6.flight, lang: 'en', expiresAt: Date.now() + JOIN_TTL_MS });
    await agent.inbound(inbound(`START ${W6.flight} ${token}`));
    expect(await agent.profile(phone)).toMatchObject({ lang: 'en', verified: true });
    expect(texts()[0]).toContain('Connected ✈️');
    expect(texts()[1]).toContain('Security: moderate queue, ~10 min now');
    expect(texts().join(' ')).not.toMatch(/simulation|simulăr|estimare|demo/i);
    const p = await agent.profile(phone);
    expect(await agent.messaging.passenger(p!.pageToken!)).toMatchObject({ lang: 'en', queues: expect.arrayContaining([expect.objectContaining({ label: 'Security', source: 'forecast' })]) });
    await agent.inbound(inbound('RO'));
    expect(await agent.messaging.passenger(p!.pageToken!)).toMatchObject({ lang: 'ro' });
  });
  it('passes the chosen language in the system prompt despite Romanian conversation history', async () => {
    const { agent, calls } = languageHarness('key');
    await agent.inbound(inbound('salut'));
    await agent.inbound(inbound('English'));
    await agent.inbound(inbound('gate?'));
    const request = calls.filter(c => String(c.url).includes('anthropic')).at(-1).body;
    expect(JSON.stringify(request.system)).toContain('Passenger language: English. You MUST answer entirely in this language');
  });
  it('localizes automatic flight changes, admin decisions, staff and evacuation', async () => {
    const { agent, store, texts, airport } = languageHarness();
    await agent.inbound(inbound('English'));
    await agent.inbound(inbound(`START ${W6.flight}`));
    airport.provisional = () => false;
    airport.flights = () => [{ ...W6, status: 'delayed', delayMin: 30 }];
    await agent.messaging.flightsChanged();
    expect(texts().at(-1)).toContain('is delayed by 30 min');
    expect(texts().at(-1)).toContain('Gate 2 closes');
    expect(agent.messaging.evacuateText(['security'], 'en')).toContain('Evacuation: Security closed');
    await store.delete(`msg:last:wa:${phone}`);
    await agent.messaging.adminChanged({ type: 'close', zone: 'security' });
    expect(texts().at(-1)).toContain('Security: the area is closed.');
    await agent.messaging.plan({ id: 'evac-en', blocked: ['security'], clearSec: 20,
      exits: [{ exit: 'exit_1', people: 10, clearSec: 20 }], routes: [{ from: 'entrance', exit: 'exit_1', nodes: ['entrance', 'exit_1'] }] });
    expect(texts().at(-1)).toContain('Exit via Exit 1: Entrance → Exit 1');
    await agent.inbound(inbound('STAFF CRAIOVA2026'));
    expect(texts().at(-1)).toContain('registered as airport staff');
    await agent.inbound(inbound('unattended bag near gate 2'));
    expect(texts().at(-1)).toContain('The response team has been notified');
  });
});

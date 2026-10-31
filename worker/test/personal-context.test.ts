import { describe, expect, it, vi } from 'vitest';
import { contextBlock, foldHistory, type HistoryEntry } from '../src/wa/agent.js';
import { extractFacts, factPatch, HISTORY_CAP, HISTORY_KEEP, SUMMARY_MAX, NOTES_MAX, type PassengerContext } from '../src/wa/context.js';
import { WhatsAppAgent, type WaStore } from '../src/wa/index.js';
import { PROVISIONAL_FLIGHTS } from '../src/wa/flights.js';
import { toolsFor, type AirportView, type Profile } from '../src/wa/tools.js';

const clock = { now: 8 * 3600 + 40 * 60, sim: true };
const view: AirportView = { clock: () => clock, flow: () => ({ security: { waiting: 20, waitMin: 12 } }), flights: () => PROVISIONAL_FLIGHTS, provisional: () => true };
const entries = (n: number): HistoryEntry[] => Array.from({ length: n }, (_, i) => [
  { role: 'user' as const, text: `question ${i}`, at: `${i}` },
  { role: 'clarion' as const, text: `answer ${i}`, at: `${i}` },
]).flat();

class Store implements WaStore {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async list<T>({ prefix }: { prefix: string }) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix))) as Map<string, T>; }
}
const phone = '+40712345678';
const webhook = (text: string, from = phone.slice(1)) => ({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: 'PN1' }, messages: [{ id: `m-${Math.random()}`, from, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: text } }],
} }] }] });

it('folds complete older turns, retaining recent turns verbatim and a bounded cumulative summary', async () => {
  const fetcher = vi.fn();
  const all = entries(HISTORY_CAP + 1);
  const folded = await foldHistory({}, fetcher, { history: all, summary: 'earlier: kids' }, []);
  expect(fetcher).not.toHaveBeenCalled();
  expect(folded.history).toEqual(all.slice(-HISTORY_KEEP * 2));
  expect(folded.summary).toContain('earlier: kids');
  expect(folded.summary).toContain('question 0');
  expect(folded.summary).not.toContain('question 12');
  const again = await foldHistory({}, fetcher, { history: all, summary: 'x'.repeat(2000) }, []);
  expect(again.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
  expect((await foldHistory({}, fetcher, { history: entries(HISTORY_CAP) }, [])).history).toHaveLength(HISTORY_CAP * 2);
});

it('uses the model only at the folding threshold and falls back on empty or failed summaries', async () => {
  const ctx = { history: entries(HISTORY_CAP + 1), summary: 'old' };
  const fetcher = vi.fn(async () => Response.json({ content: [{ type: 'text', text: 'Passenger has kids.' }] }));
  expect((await foldHistory({ ANTHROPIC_API_KEY: 'k' }, fetcher, ctx, [])).summary).toBe('Passenger has kids.');
  expect(fetcher).toHaveBeenCalledOnce();
  for (const response of [Response.json({ content: [] }), new Response('failed', { status: 500 })]) {
    expect((await foldHistory({ ANTHROPIC_API_KEY: 'k' }, async () => response, ctx, [])).summary).toContain('question 0');
  }
});

describe('self-reported facts', () => {
  it.each([
    ['Nu am bagaj de cală. Suntem 3. Vin cu doi copii.', { hasCheckedBag: false, groupSize: 3, needs: { kids: true } }],
    ['I have checked baggage. We are 4. I use a wheelchair.', { hasCheckedBag: true, groupSize: 4, needs: { reducedMobility: true } }],
    ['Am bagaj de cală. Am mobilitate redusă.', { hasCheckedBag: true, needs: { reducedMobility: true } }],
    ["I don't have checked bags.", { hasCheckedBag: false }],
    ['Nu am copii.', { needs: { kids: false } }],
    ["I'm traveling with my children.", { needs: { kids: true } }],
    ['Do I need checked baggage?', {}],
    ['Dacă vin cu copii?', {}],
    ['Nu am mobilitate redusă.', { needs: { reducedMobility: false } }],
  ])('extracts only explicit statements: %s', (text, patch) => expect(extractFacts(text)).toEqual(patch));
  it('validates model memory keys and merges corrections without losing other needs', async () => {
    let p: Profile = { phone, role: 'passenger', needs: { kids: true } };
    const tools = toolsFor({ view, profile: () => p, save: async patch => { p = { ...p, ...patch }; } });
    expect(await tools.rememberFact!({ key: 'reducedMobility', value: true })).toMatchObject({ remembered: true });
    expect(p.needs).toEqual({ kids: true, reducedMobility: true });
    await tools.rememberFact!({ key: 'kids', value: false });
    expect(p.needs?.kids).toBe(false);
    expect(await tools.rememberFact!({ key: 'flight', value: 'W6 3751' })).toMatchObject({ remembered: true });
    expect(p.flight).toBe('W6 3751');
    expect(await tools.rememberFact!({ key: 'flight', value: 'XX 9999' })).toMatchObject({ error: 'unknown_flight' });
    expect(p.flight).toBe('W6 3751');
    for (const [key, value] of [['role', 'staff'], ['groupSize', -2], ['groupSize', 1.5], ['hasCheckedBag', 'yes'], ['needs', 'x'.repeat(201)]]) expect(factPatch(key, value)).toBeUndefined();
  });
});

it('puts summary, facts, lookups and delivered urgent alerts into the language-specific prompt context', () => {
  const context = contextBlock({ phone, role: 'passenger', lang: 'en', flight: 'W6 3751', hasCheckedBag: false,
    groupSize: 3, gate: '2', needs: { kids: true }, lastWaitEstimate: { at: '08:40', totalMin: 35 } }, clock,
  { history: [], summary: 'Earlier chat', notes: [{ tool: 'queues', at: '08:40', note: 'security ~12 min' }], alerts: [{ at: '08:30', kind: 'flight', text: 'Delayed 20 min' }] });
  for (const expected of ['English', 'W6 3751', 'nu', 'Group size: 3', 'kids', '08:40', '35', 'Earlier chat', 'security ~12 min', 'Delayed 20 min', 'not live']) expect(context).toContain(expected);
});

it('persists across agent restarts, caps lookup notes, isolates passengers and clears all context on demo reset', async () => {
  const store = new Store();
  const make = () => new WhatsAppAgent({ WHATSAPP_PHONE_NUMBER_ID: 'PN1' }, store, view, { pause: 0 });
  await make().inbound(webhook('Suntem 3. Vin cu doi copii. Nu am bagaj de cală.'));
  for (let i = 0; i < NOTES_MAX + 2; i++) await make().inbound(webhook('e coada la securitate?'));
  expect(await make().profile(phone)).toMatchObject({ groupSize: 3, hasCheckedBag: false, needs: { kids: true } });
  expect((await store.get<PassengerContext>(`wa:ctx:${phone}`))?.notes).toHaveLength(NOTES_MAX);
  expect((await store.get<PassengerContext>(`wa:ctx:${phone}`))?.notes?.[0]?.note).toContain('12 min at 08:40');
  await make().inbound(webhook('hello', '40700000000'));
  expect(await make().profile('+40700000000')).not.toHaveProperty('needs');
  await store.put(`msg:alerts:wa:${phone}`, [{ kind: 'flight', at: '08:30', text: 'Delayed' }]);
  await make().inbound(webhook('cozi?'));
  expect((await store.get<PassengerContext>(`wa:ctx:${phone}`))?.alerts?.[0]?.text).toBe('Delayed');
  await make().reset();
  expect([...store.data.keys()].filter(k => /^(wa:profile:|wa:ctx:|msg:alerts:)/.test(k))).toEqual([]);
  await make().inbound(webhook('hello'));
  expect(await make().profile(phone)).not.toHaveProperty('groupSize');
});


it('retains delivered urgent alerts beyond routine page updates, forgets them on reset, and skips failed delivery', async () => {
  const store = new Store();
  const agent = new WhatsAppAgent({ WHATSAPP_PHONE_NUMBER_ID: 'PN1' }, store, view, { pause: 0 });
  await agent.inbound(webhook('W6 3751'));
  const sub = { channel: 'whatsapp' as const, phone };
  await agent.messaging.notify(sub, { kind: 'flight', text: 'Flight delayed by 20 min.' });
  // The general page list may fill with routine updates; urgent memory remains separate.
  await store.put(`msg:alerts:wa:${phone}`, Array.from({ length: 5 }, () => ({ kind: 'arrive', text: 'Routine', at: '09:00' })));
  await agent.inbound(webhook('hello'));
  expect((await store.get<PassengerContext>(`wa:ctx:${phone}`))?.alerts?.[0]?.text).toContain('delayed');
  vi.spyOn(agent.wa, 'sendText').mockResolvedValueOnce({ ok: false });
  expect(await agent.messaging.notify(sub, { kind: 'evacuate', text: 'Failed alert' })).toBe('failed');
  expect((await store.get<unknown[]>(`msg:urgent:wa:${phone}`))?.length).toBe(1);
  await agent.reset();
  expect(await store.get(`msg:urgent:wa:${phone}`)).toBeUndefined();
});

it('remembers shared estimates only after delivery and keeps flight verification on later mentions', async () => {
  const store = new Store();
  const agent = new WhatsAppAgent({ WHATSAPP_PHONE_NUMBER_ID: 'PN1' }, store, view, { pause: 0 });
  await store.put(`wa:profile:${phone}`, { phone, role: 'passenger', flight: 'W6 3751', verified: true });
  await agent.inbound(webhook('when should I arrive for W6 3751?'));
  expect(await agent.profile(phone)).toMatchObject({ verified: true, lastWaitEstimate: { at: '08:40', totalMin: expect.any(Number) } });
  await store.put(`wa:profile:${phone}`, { phone, role: 'passenger', flight: 'W6 3751' });
  const spy = vi.spyOn(agent.wa, 'sendText').mockResolvedValue({ ok: false });
  await agent.inbound(webhook('when should I arrive?'));
  expect(await agent.profile(phone)).not.toHaveProperty('lastWaitEstimate');
  spy.mockRestore();
});

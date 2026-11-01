import { WhatsAppAgent, DEFAULT_STAFF_CODE, parseStart, type WaStore } from './index.js';
import type { Flight } from './flights.js';
import type { AirportView } from './tools.js';
import { type Fetch, type WaEnv, isReaction } from './transport.js';
import { type WaEvent } from './events.js';
import { consumeJoin } from '../join.js';
import { urgentText } from './urgency.js';

interface Step { text: string; tool?: string; unknown?: boolean; evacuate?: boolean; urgent?: boolean }
// Private fixture for built-in scripts only; never inserted into the Tower schedule.
const LAB_FLIGHT: Flight = { flight: 'W6 3751', airline: 'W6', destination: 'Londra Luton',
  std: 10 * 3600, gateCloseAt: 9.5 * 3600, gate: 'gate_2', checkIn: 'check_in:1',
  checkInDesks: ['checkin_1', 'checkin_2', 'checkin_3', 'checkin_4'], status: 'scheduled', delayMin: 0, pax: 1 };
const start = { text: `START ${LAB_FLIGHT.flight}` };
function sandboxView(view: AirportView): AirportView {
  const flights = [structuredClone(LAB_FLIGHT)];
  const flow = structuredClone(view.flow());
  return { clock: () => ({ now: 8 * 3600, sim: true }), flights: () => flights,
    flow: () => flow, provisional: () => true, blocked: () => [] };
}
export const SCRIPTS: Record<string, Step[]> = {
  startFlight: [start, { text: 'Care este statusul zborului meu?', tool: 'myFlight' }],
  security: [{ text: 'Cât se așteaptă acum la securitate?', tool: 'queues' }],
  arrival: [start, { text: 'Când să plec spre aeroport?', tool: 'whenToArrive' }],
  gate: [start, { text: 'Care este poarta mea?', tool: 'myFlight' }],
  route: [start, { text: 'Cum ajung la poartă?', tool: 'routeTo' }],
  toilet: [{ text: 'Unde e toaleta? Sunt la Hol central.', tool: 'routeTo' }],
  food: [{ text: 'English' }, { text: 'Where can I eat? I am at Duty free.', tool: 'routeTo' }],
  landmarkRoute: [start, { text: 'Sunt la Hol central. Cum ajung la poartă?', tool: 'routeTo' }],
  airportInfo: [{ text: 'Cât costă parcarea la aeroport?', tool: 'airportInfo' }],
  unknownFact: [{ text: 'Care este parola Wi-Fi la aeroport?', tool: 'airportInfo', unknown: true }],
  english: [{ text: 'English' }, { text: 'How long is the security queue?', tool: 'queues' }, { text: 'When should I arrive for W6 3751?', tool: 'whenToArrive' }],
  staffIssue: [{ text: 'STAFF <code>' }, { text: 'Bagaj abandonat lângă check-in 2', tool: 'reportIssue', urgent: true }],
  languageSwitch: [start, { text: 'English' }, { text: 'What is my gate?', tool: 'myFlight' }, { text: 'Română' }, { text: 'Care este poarta mea?', tool: 'myFlight' }],
  evacuation: [start, { text: '(evacuation alert received)', evacuate: true, urgent: true }],
};
export const MAX_BUBBLES = 8;
export const MAX_BUBBLE_CHARS = 180;
export interface LabTurn { user: string; replies: string[]; tools: string[]; ms: number; lang: 'ro' | 'en'; urgent?: boolean; evacuate?: boolean; expectedTool?: string; unknown?: boolean; errors?: string[] }
export interface Violation { turn: number; rule: string; detail: string }
const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3/u;
const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const ro = /\b(iesi|iesire|adunare|este|sunt|poarta|securitate|acum|zborul|aeroport|minute|timp|pentru|spre|nu|stiu|bagaj|parcarea|parcare|informatii|la|in|cu|de|voi|raspunde|romana|lei|ore|tva)\b/giu;
const en = /\b(the|is|are|your|you|security|now|flight|airport|minutes|for|to|from|with|don't|know|gate|baggage|parking|information|i|will|reply|english)\b/giu;
/** Lexical smoke check, not a language classifier or a semantic judge. URLs and reactions are excluded. */
export function matchesLanguage(text: string, lang: 'ro' | 'en') {
  const plain = normalize(text.replace(/https?:\/\/\S+/g, ''))
    // Shared airport vocabulary is neutral, including short label-only bubbles.
    .replace(/\bboarding[ -]pass(?:-ul)?\b|\bcheck[ -]in(?:-ul)?\b|\bgate\s+(?:[a-z]?\d+[a-z]?)\b|\b[a-z]\d+[a-z]?\b/g, '');
  if (!/\p{L}/u.test(plain)) return true;
  const r = plain.match(ro)?.length ?? 0, e = plain.match(en)?.length ?? 0;
  return lang === 'ro' ? r > e : e > r;
}
export function check(transcript: LabTurn[]): Violation[] {
  const out: Violation[] = [];
  transcript.forEach((t, i) => {
    const bad = (rule: string, detail: string) => out.push({ turn: i + 1, rule, detail });
    const texts = t.replies.filter(r => !isReaction(r));
    if (!texts.some(r => r.trim())) bad('non-empty', 'No text reply');
    if (texts.length > MAX_BUBBLES) bad('bubble-count', `${texts.length} > ${MAX_BUBBLES}`);
    if (t.expectedTool && !t.tools.includes(t.expectedTool)) bad('expected-tool', t.expectedTool);
    for (const error of t.errors ?? []) bad('agent-error', error);
    if (t.unknown && !/nu (știu|stiu|am|cunosc)|don.t (know|have)|do not (know|have)|unknown|unavailable/i.test(texts.join(' '))) bad('unknown-fact', 'Missing explicit uncertainty');
    for (const r of t.replies) {
      if ((t.urgent || urgentText(t.user)) && (isReaction(r) || emoji.test(r))) bad('urgent-emoji', r);
      if (isReaction(r)) continue;
      if (!r.trim()) bad('non-empty', 'Empty bubble');
      if (r.length > MAX_BUBBLE_CHARS) bad('bubble-length', `${r.length} > ${MAX_BUBBLE_CHARS}`);
      if (!matchesLanguage(r, t.lang)) bad('language', `Expected ${t.lang}: ${r}`);
      if (/abona(?:re|t|ți|ti|ză|za)|aboneaz|abonează/i.test(r)) bad('abonare', r);
      if (!t.evacuate && /\b(plecati|vino|veniti|grabeste|mergi|mergeti|urmeaza|indreapta-te|du-te|fii|leave now|hurry|go now|go to|head to|proceed to|come early|you must|you should|trebuie sa)\b/i.test(normalize(r))) bad('orders', r);
      if (/\b(?:[GU]_[A-Z][A-Z_0-9]*|(?:check_in|bag_drop|gate|security):[\w-]+|gate_\d+)\b/.test(r)) bad('raw-id', r);
      if (/simulăr|simulation|estimare|demo/i.test(r)) bad('no-disclaimer', r);
      if (/\b(undefined|null|NaN)\b/.test(r)) bad('invalid-value', r);
    }
  });
  return out;
}

/** All writable state is isolated, including joins, reports, fan-out lists and page tokens. */
class LabStore implements WaStore {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return this.data.get(key) as T | undefined; }
  async put(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async list<T>({ prefix }: { prefix: string }) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix))) as Map<string, T>; }
}
export const labPhone = (phone: unknown): phone is string => typeof phone === 'string' && /^lab-e2e-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(phone);
export interface LabInput { script?: string; texts?: string[]; keep?: boolean; phone?: string }
export function validateInput(value: unknown): asserts value is LabInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  const v = value as LabInput;
  if (v.script !== undefined && (typeof v.script !== 'string' || !Object.hasOwn(SCRIPTS, v.script))) throw new Error('Unknown script');
  if (v.keep !== undefined && typeof v.keep !== 'boolean') throw new Error('keep must be boolean');
  if (v.texts !== undefined && (!Array.isArray(v.texts) || !v.texts.length || v.texts.length > 20 || v.texts.some(t => typeof t !== 'string' || !t.trim() || t.length > 2000))) throw new Error('texts must contain 1–20 non-empty strings, at most 2000 characters each');
  if (v.phone !== undefined && (!labPhone(v.phone) || !v.keep || !v.texts)) throw new Error('phone requires lab-e2e-UUID, keep and texts');
  if (v.script !== undefined && v.texts !== undefined) throw new Error('Use script or texts');
}
export async function runLab(env: WaEnv, view: AirportView, input: LabInput, persistent: WaStore, fetcher: Fetch = (url, init) => fetch(url, init)) {
  validateInput(input);
  const results: Record<string, Awaited<ReturnType<typeof runScript>>> = {};
  for (const name of input.texts ? ['custom'] : input.script ? [input.script] : Object.keys(SCRIPTS)) {
    results[name] = await runScript(env, input.texts ? view : sandboxView(view), input.texts?.map(text => ({ text })) ?? SCRIPTS[name]!, Boolean(input.keep), persistent, fetcher, input.phone);
  }
  const failed = Object.keys(results).filter(n => results[n]!.violations.length);
  return { pass: !failed.length, failed, results };
}
async function runScript(env: WaEnv, view: AirportView, steps: Step[], keep: boolean, persistent: WaStore, fetcher: Fetch, selectedPhone?: string) {
  const phone = selectedPhone ?? `lab-${crypto.randomUUID()}`;
  if (selectedPhone && await persistent.get(`wa:profile:${phone}`)) throw new Error('Lab phone already exists; clean it up first');
  const store = new LabStore();
  let sends: any[] = [], events: WaEvent[] = [];
  // Force the transport into its live code path, but intercept ALL Graph requests before any network call.
  const agent = new WhatsAppAgent({ ...env, WA_ALLOWLIST: undefined, WHATSAPP_TOKEN: 'lab-capture', WHATSAPP_PHONE_NUMBER_ID: 'lab' }, store, view, {
    pause: 0, evacWaitMs: 0, observe: async e => { events.push(e); },
    fetcher: async (url, init) => {
      if (url.startsWith('https://graph.facebook.com/')) {
        sends.push(JSON.parse(String(init?.body)));
        return Response.json({ messages: [{ id: 'lab-out' }] });
      }
      return fetcher(url, init);
    },
  });
  const transcript: LabTurn[] = [];
  let expectedLang: 'ro' | 'en' = 'ro';
  try {
    for (const step of steps) {
      sends = []; events = [];
      const at = Date.now();
      if (/^(English|en)$/i.test(step.text.trim())) expectedLang = 'en';
      if (/^(Română|romana|ro)$/i.test(step.text.trim())) expectedLang = 'ro';
      const text = step.text.replace('STAFF <code>', `STAFF ${env.STAFF_CODE || DEFAULT_STAFF_CODE}`);
      // Exercise a verified START with the same single-use join record as /api/join.
      let inbound = text;
      const start = parseStart(text);
      if (start?.token) {
        const join = await consumeJoin(persistent, start.token, start.flight);
        if (!join) throw new Error('START requires an active issued join token');
        await store.put(`join:${start.token}`, join);
      } else if (start) {
        const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '').slice(0, 16);
        await store.put(`join:${token}`, { flight: start.flight, lang: (await agent.profile(phone))?.lang ?? 'ro', expiresAt: at + 60000 });
        inbound += ` ${token}`;
      }
      if (step.evacuate) await agent.messaging.evacuate(['security'], `lab-${crypto.randomUUID()}`);
      else await agent.receive({ id: `lab-${crypto.randomUUID()}`, phone, name: '', type: 'text', text: inbound, replyId: null, at });
      const replies = sends.flatMap(b => b.type === 'text' ? [b.text.body] : b.type === 'interactive' ? [b.interactive.body.text] : b.type === 'reaction' ? [`[react]${b.reaction.emoji}`] : []);
      transcript.push({ user: step.text, replies, tools: events.flatMap(e => e.tools ?? []), ms: Date.now() - at,
        lang: expectedLang, urgent: step.urgent, evacuate: step.evacuate, expectedTool: step.tool, unknown: step.unknown,
        errors: events.filter(e => e.kind === 'agent-error').map(e => e.text ?? 'Agent error') });
    }
    const stored = { profile: await agent.profile(phone) };
    if (selectedPhone) {
      // Publish only this fake passenger, never the isolated reports or global messaging state.
      for (const [key, value] of store.data) {
        if (key.endsWith(`:${phone}`) || (key.startsWith('page:') && (value as { phone?: string }).phone === phone)) await persistent.put(key, value);
      }
      const subs = await persistent.get<string[]>('wa:subs') ?? [];
      if (!subs.includes(phone) && stored.profile?.flight) await persistent.put('wa:subs', [...subs, phone]);
    }
    if (keep) await persistent.put(`lab:kept:${phone}`, { at: new Date().toISOString(), state: Object.fromEntries(store.data) });
    return { phone, transcript, violations: check(transcript), stored, kept: keep };
  } finally {
    agent.messaging.cancelPending();
    store.data.clear();
  }
}

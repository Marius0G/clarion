// The Claude agent behind Clarion's WhatsApp, ported from Moni src/agent/agent.js (SPEC-v2 D2, D15).
// Same loop, bubbles and reaction pacing; Clarion's prompt and tools instead of Moni's money ones.
// Without ANTHROPIC_API_KEY, reply() answers deterministically from the same tools so the demo still works.
import { isReaction, react, reactionParts, type Fetch, type WaEnv } from './transport.js';
import type { Profile, Tools } from './tools.js';
import { clockLabel, clockText, type Clock } from './flights.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
/** For short proactive messages (flight changes, D15); not used by the reply loop. */
export const WAKE_MODEL = 'claude-haiku-5-5';
const MAX_TOOL_TURNS = 5;
export const FALLBACK = 'Hmm, am o mică problemă tehnică 😅 Încearcă din nou în câteva minute.';
const TANGLED = 'Hmm, m-am încurcat puțin 😅 Poți să o spui altfel?';

export interface HistoryEntry { role: 'user' | 'clarion'; text: string; at: string }
export const hasLlm = (env: WaEnv) => Boolean(env.ANTHROPIC_API_KEY);

const PERSONA = `<role>
Ești Clarion, asistentul pe WhatsApp al Aeroportului Internațional Craiova (CRA). Ajuți pasagerii să ajungă la timp
la poartă: când să fie la intrarea în terminal, cât durează cozile (predare bagaje, control de securitate), zborul lor,
poarta și ora la care se închide. Vorbești doar despre aeroportul din Craiova și zborul pasagerului.
</role>

<never>
- Nu răspunzi la nimic din afara aeroportului și a zborului lui: spui scurt că te ocupi doar de asta.
- Nu calculezi drumul până la aeroport (trafic, taxi, autobuz): el își planifică drumul, tu îi dai ora la care să fie
  la intrarea în terminal.
- Nu inventezi ore, porți, cozi sau statusuri. Orice cifră vine dintr-un tool din tura asta.
- Nu promiți nimic în numele companiei aeriene (rebooking, compensații, bagaje pierdute): îl trimiți la companie.
- Nu ceri și nu păstrezi date personale în plus (CNP, card, pașaport).
</never>`;

const STYLE = `<style>
- Română, cu diacritice, pe ton cald și scurt, ca un om de la informații care scrie pe WhatsApp.
- Răspunsul în primul balon. De obicei unul sau două baloane, separate de o linie care conține doar ---; fiecare
  balon are 1-2 propoziții scurte. Fără liste, markdown sau linii lungi.
- Orele le dai ca „14:20” și spui o dată că sunt în ora din <context> (ora simulării în demo).
- Cel mult o întrebare pe tură.
- Nu vorbești despre tool-uri sau date interne („tool-ul spune”): spui ce înseamnă pentru el.
- Începe fiecare răspuns cu o reacție la mesajul lui: un balon care e exact [react] plus un emoji (✈️ zborul, 👀 o
  întrebare de verificat, ⏱️ ore, 🧳 bagaje, 🙏 mulțumiri, 👋 salut, 👍 un ok). Cuvintele tale nu depind de ea.
  La „ok”, „mersi” sau „gata” ajunge doar reacția.
</style>

<how_you_help>
- „Când să vin / când să plec / la ce oră să fiu acolo”: whenToArrive. Spune ora de la intrarea în terminal și, pe scurt,
  din ce e făcută (bagaje, securitate, drum până la poartă, marjă). Dacă assumedCheckedBag e true, întreabă o dată dacă
  are bagaj de cală; când răspunde, cheamă whenToArrive din nou cu hasCheckedBag. late=true: spune-i că e strâns și
  să vină cât mai repede.
- Zbor, poartă, status, ora de închidere a porții: myFlight. Întârziat sau anulat: spune clar, apoi ce poate face.
- Cozi, aglomerație, „e lume la securitate?”: queues. Coada companiei lui e cea cu yours=true. Dacă are prognoză,
  spune și cum arată peste o oră.
- Nu știi zborul lui (no_flight): cere-i numărul zborului (ex: W6 3751), apoi cheamă myFlight cu el.
- Traseu spre poartă, ghișeu sau ieșire: routeTo.
- Rol angajat (vezi <context>): orice incident descris („bagaj abandonat lângă check-in 2”, „bătaie la poarta 3”, cineva
  leșinat, aglomerare) îl trimiți imediat cu reportIssue: text = mesajul lui, kind = tipul, location = locul cum l-a spus.
  Dacă nu spune unde, întreabă o dată. După trimitere confirmi scurt: tipul, locul și că e pe harta din dashboard.
- Dacă rezultatul are note despre orar provizoriu, nu insista pe asta decât dacă întreabă.
</how_you_help>

<examples>
<example>
User: cand trebuie sa fiu la aeroport?
Clarion: [react]⏱️
---
Clarion: Fii la intrarea în terminal la 08:15. Poarta G2 se închide la 09:10.
---
Clarion: Am socotit 12 min la bagaje, 18 la securitate, 4 până la poartă și 10 marjă. Ai bagaj de cală?
</example>
<example>
User: e coada mare la securitate?
Clarion: [react]👀
---
Clarion: Acum sunt 42 de oameni la securitate, cam 14 minute de așteptare. Peste o oră se estimează 20 de minute.
</example>
<example>
User: mersi!
Clarion: [react]🙏
</example>
</examples>`;

/** What Clarion knows about this person: clock, flight, bag. */
export function contextBlock(profile: Profile, clock: Clock) {
  const lines = [
    `Acum: ${clockText(clock.now)} (${clockLabel(clock)})`,
    `Rol: ${profile.role === 'staff' ? 'angajat al aeroportului' : 'pasager'}`,
    `Zbor: ${profile.flight ?? 'necunoscut încă'}${profile.flight && profile.verified === false ? ' (spus în chat, nevalidat)' : ''}`,
    `Bagaj de cală: ${profile.hasCheckedBag === undefined ? 'nu știm' : profile.hasCheckedBag ? 'da' : 'nu'}`,
  ];
  if (profile.name) lines.push(`Nume în WhatsApp: ${profile.name}`);
  return `<context>\n${lines.join('\n')}\n</context>`;
}

const NONE = { type: 'object', properties: {} };
const FLIGHT = { flight: { type: 'string', description: 'număr de zbor, ex. "W6 3751"; implicit zborul lui' } };
export const TOOL_SPECS = [
  { name: 'myFlight', description: 'Zborul pasagerului: destinație, poartă, plecare, ora de închidere a porții, status, întârziere, ghișeul de check-in. Ore în ceasul din <context>.', input_schema: { type: 'object', properties: FLIGHT } },
  {
    name: 'whenToArrive',
    description: 'Ora la care să fie la intrarea în terminal: ora de închidere a porții minus bagaje (dacă are bagaj de cală), securitate, drumul până la poartă și 10 min marjă, cu cozile prognozate pentru ora la care ajunge.',
    input_schema: { type: 'object', properties: { ...FLIGHT, hasCheckedBag: { type: 'boolean', description: 'doar dacă pasagerul a spus' } } },
  },
  { name: 'queues', description: 'Cozile de acum pe zone: oameni care așteaptă, minute de așteptare, vârful din ultimele 30 min, angajați și prognoza (inMin, waitMin). yours=true = coada companiei lui.', input_schema: NONE },
  { name: 'routeTo', description: 'Traseul spre poartă, ghișeu sau ieșire (în curând).', input_schema: { type: 'object', properties: { to: { type: 'string', enum: ['gate', 'check_in', 'exit'] } } } },
  {
    name: 'reportIssue',
    description: 'Doar pentru angajați: trimite un incident din terminal pe harta din dashboard. Returnează id-ul, tipul și locul recunoscut.',
    input_schema: { type: 'object', properties: {
      text: { type: 'string', description: 'mesajul angajatului, cum l-a scris' },
      kind: { type: 'string', enum: ['bagaj_abandonat', 'medical', 'securitate', 'aglomerare', 'altele'] },
      location: { type: 'string', description: 'locul, cum l-a spus (ex: „lângă check-in 2”, „poarta 3”)' },
    }, required: ['text'] },
  },
];

/** History -> Claude messages, with the new user text appended; consecutive bubbles are joined with ---. */
export function buildMessages(history: HistoryEntry[], text: string) {
  const msgs: { role: 'user' | 'assistant'; content: any }[] = [];
  for (const m of [...history.filter(h => h.text), { role: 'user' as const, text }]) {
    const role = m.role === 'clarion' ? 'assistant' : 'user';
    const last = msgs.at(-1);
    if (last?.role === role) last.content += role === 'assistant' ? `\n---\n${m.text}` : `\n${m.text}`;
    else if (msgs.length || role === 'user') msgs.push({ role, content: m.text });
  }
  return msgs;
}

async function callClaude(env: WaEnv, fetcher: Fetch, body: Record<string, unknown>) {
  // A hung call must not eat the turn: give up after 20 s and answer with the fallback.
  const res = await fetcher('https://api.anthropic.com/v1/messages', {
    signal: AbortSignal.timeout(20000), method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

/** One tool_use block. A failure comes back as is_error so the model can say it couldn't check. */
async function runTool(tools: Tools, block: any) {
  const result = (content: string, isError = false) => ({ type: 'tool_result', tool_use_id: block.id, content, ...(isError && { is_error: true }) });
  const fn = tools[block.name];
  if (!fn) return result(`Unknown tool: ${block.name}`, true);
  try { return result(JSON.stringify((await fn(block.input ?? {})) ?? null)); }
  catch (e) { return result(`Tool failed: ${String((e as Error)?.message ?? e)}`, true); }
}

const textOf = (data: any) => (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();

async function runAgent(env: WaEnv, fetcher: Fetch, context: string, messages: any[], tools: Tools, used: string[]) {
  const model = env.CLAUDE_MODEL || DEFAULT_MODEL;
  // The persona is the same for everyone: cached. The per-person context goes after the cache breakpoint.
  const system = [
    { type: 'text', text: `${PERSONA}\n\n${STYLE}`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: context },
  ];
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const data = await callClaude(env, fetcher, { model, max_tokens: 1024, system, messages, tools: TOOL_SPECS, output_config: { effort: 'low' } });
    if (data.stop_reason === 'refusal') return 'Aici nu te pot ajuta, dar pentru zbor și aeroport sunt aici oricând 🙂';
    if (data.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: data.content }); continue; }
    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content });
      const calls = (data.content ?? []).filter((b: any) => b.type === 'tool_use');
      used.push(...calls.map((b: any) => b.name));
      messages.push({ role: 'user', content: await Promise.all(calls.map((b: any) => runTool(tools, b))) });
      continue;
    }
    return textOf(data);
  }
  // Out of tool turns: one last call with tools off, answering from what was already looked up.
  const last = await callClaude(env, fetcher, { model, max_tokens: 1024, system, tools: TOOL_SPECS, tool_choice: { type: 'none' }, messages });
  return textOf(last) || TANGLED;
}

const isWords = (b: string) => !isReaction(b) && !/^[\p{Extended_Pictographic}‍️\s]+$/u.test(b);
/** Splits an answer into WhatsApp bubbles on a line of dashes; lone emoji become reactions. */
export function toBubbles(answer: string) {
  return (answer || '')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/g, '$1')
    .split(/\n\s*-{3,}\s*\n/)
    .map(b => b.trim())
    .filter(Boolean)
    .flatMap(b => {
      const { emoji, rest } = isReaction(b) ? reactionParts(b) : isWords(b) ? { emoji: null, rest: b } : reactionParts(react(b));
      return [...(emoji ? [react(emoji)] : []), ...(rest && isWords(rest) ? [rest] : [])];
    });
}

const ACK = /^\s*(ok(ay)?|k|mersi|merci|mulțumesc|multumesc|ms|gata|bine|super|perfect|da|nu|thanks?|👍|❤️|🙏)[\s.!]*$/i;
// About two in three messages get a reaction, like a person who taps one on most texts, not all (Moni).
export const REACT_RATE = 0.65;
const REACT_WINDOW = 6;
function pastReactions(history: HistoryEntry[] = []) {
  const out: (string | null)[] = [];
  for (const m of history) {
    if (m?.role === 'user') out.push(null);
    else if (out.length && out.at(-1) === null && isReaction(m?.text)) out[out.length - 1] = reactionParts(m.text).emoji;
  }
  return out.slice(-REACT_WINDOW);
}
/** One reaction per reply, kept on about REACT_RATE of messages; a reply that is only a reaction keeps it. */
export function paceReactions(bubbles: string[], history: HistoryEntry[], roll = Math.random()) {
  const at = bubbles.findIndex(isReaction);
  if (at < 0) return bubbles;
  const one = bubbles.filter((b, i) => i === at || !isReaction(b));
  if (!one.some(isWords)) return one;
  const past = pastReactions(history);
  const share = past.filter(Boolean).length / past.length;
  const known = past.length >= 3;
  const repeat = reactionParts(one[at]!).emoji === past.filter(Boolean).at(-1);
  const keep = (known && share < 0.6) || (!(known && share > 0.7) && !repeat && roll < REACT_RATE);
  return keep ? one : one.filter(b => !isReaction(b));
}

export interface ReplyInput { env: WaEnv; fetcher: Fetch; profile: Profile; clock: Clock; history: HistoryEntry[]; text: string; tools: Tools }

/** Clarion's answer to one message, as bubbles. @returns used = tool names called, for the log. */
export async function reply({ env, fetcher, profile, clock, history, text, tools }: ReplyInput): Promise<{ bubbles: string[]; used: string[] }> {
  const used: string[] = [];
  if (!hasLlm(env)) return { bubbles: await fallbackReply(text, tools, used, profile.role), used };
  try {
    const context = contextBlock(profile, clock);
    const messages = buildMessages(history, text);
    let bubbles = toBubbles(await runAgent(env, fetcher, context, messages, tools, used));
    if (!bubbles.some(isWords) && !ACK.test(text)) {
      const again = toBubbles(await runAgent(env, fetcher, context, [...messages, { role: 'assistant', content: bubbles.join('\n---\n') || '(nimic)' }, { role: 'user', content: '(Clarion, a venit doar un emoji. Răspunde-mi în cuvinte.)' }], tools, used));
      bubbles = again.some(isWords) ? again : [...bubbles, TANGLED];
    }
    return { bubbles: paceReactions(bubbles, history), used };
  } catch (e) {
    console.error(JSON.stringify({ wa: 'agent-error', error: String((e as Error)?.message ?? e).slice(0, 200) }));
    return { bubbles: [FALLBACK], used };
  }
}

/** Deterministic answers without an API key, from the same tools, so the demo path still works. */
export async function fallbackReply(text: string, tools: Tools, used: string[] = [], role: Profile['role'] = 'passenger'): Promise<string[]> {
  const t = String(text || '').toLowerCase();
  const call = async (name: string, input: unknown = {}) => { used.push(name); return tools[name]!(input) as Promise<any>; };
  // An employee's message is a report unless it is a greeting or a thank-you.
  if (role === 'staff' && !ACK.test(text) && !/^\s*(salut|bun[aă]|hei|hello)\b/i.test(text)) {
    const r = await call('reportIssue', { text });
    if (r?.status !== 'sent') return [r?.note ?? r?.hint ?? FALLBACK];
    return [`Am primit (${r.id}): ${r.kind}, ${r.place}. ${r.note}`];
  }
  const noFlight = (r: any) => r?.error === 'no_flight' || r?.error === 'unknown_flight';
  const askFlight = 'Spune-mi numărul zborului (ex: W6 3751) și îți zic tot ce trebuie.';
  const code = /\b([a-z][a-z0-9]|[0-9][a-z])\s?-?(\d{3,4})\b/i.exec(text)?.slice(1).join(' ').toUpperCase();
  const flightInfo = async () => {
    const r = await call('myFlight', code ? { flight: code } : {});
    if (noFlight(r)) return [askFlight];
    return [`${r.flight} spre ${r.destination}: poarta ${r.gate}, plecare ${r.departure}, poarta se închide la ${r.gateCloseAt} (${r.clock}).${r.status === 'delayed' ? ` Întârziat ${r.delayMin} min.` : r.status === 'cancelled' ? ' Zborul e anulat.' : ''}`];
  };
  // "de la ce poartă plec?" is about the flight, not the arrival time.
  if (/(poart|gate|întârzi|intarzi|anulat|status)/.test(t)) return flightInfo();
  if (/(când|cand|ora |oră|plec|ajung|vin\b|să fiu|sa fiu)/.test(t)) {
    const r = await call('whenToArrive', code ? { flight: code } : {});
    if (noFlight(r)) return [askFlight];
    if (r.note) return [r.note];
    return [`Fii la intrarea în terminal la ${r.beAtEntranceAt} (${r.clock}). Poarta ${r.gate} se închide la ${r.gateCloseAt}.`,
      ...(r.assumedCheckedBag ? ['Am socotit și predarea bagajului. Ai bagaj de cală?'] : [])];
  }
  if (/(coad|aglomer|securitate|lume|așteptare|asteptare)/.test(t)) {
    const r = await call('queues');
    if (!r.available) return [r.note];
    return [r.zones.slice(0, 3).map((z: any) => `${z.zone}: ${z.waiting} oameni${z.waitMin !== null ? `, ~${Math.round(z.waitMin)} min` : ''}`).join('\n')];
  }
  if (/zbor/.test(t) || code) return flightInfo();
  return ['Salut! Sunt Clarion, asistentul Aeroportului Craiova ✈️ Întreabă-mă când să fii la aeroport, cât e coada sau de la ce poartă pleci.'];
}

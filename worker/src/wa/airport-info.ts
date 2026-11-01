import { landmarks, resolveOrigin, placeQuestion, positionDescription } from './location.js';
import { terminalGraph } from '../../../backend/src/terminal.js';
import { mapNodeId } from '../../../backend/src/mapIds.js';
import guide from './airport-guide.json' with { type: 'json' };
import { normalize } from './context.js';
import type { Lang } from './texts.js';

const topics = guide.topics;
type Topic = keyof typeof topics;
const aliases: [Topic, RegExp][] = [
  ['parking', /\b(park(?:ing)?|parc(?:are|area|ari)|p[123])\b/],
  ['wizz_checkin', /\b(check[ -]?in|boarding|imbarcare)\b/],
  ['security', /\b(security|securitate|liquid\w*|lichid\w*|laptop\w*|screening|control)\b/],
  ['baggage', /\b(baggage|luggage|bagaj\w*|priority)\b/],
  ['special_assistance', /\b(assistance|asistenta|pmr)\b/],
  ['accessibility', /\b(accessibility|wheelchair|accesibilitate|rotile|mobility|mobilitate)\b/],
  ['ground_transport', /\b(bus|autobuz\w*|transport|rat|rent[ -]?a[ -]?car|transfer)\b/],
  ['contacts', /\b(contact\w*|phone|telefon\w*|email|lost|pierdut\w*)\b/],
  ['services', /\b(cafe\w*|coffee|cafea|shop\w*|magazin\w*|restaurant\w*|food|duty[ -]?free)\b/],
  ['hours', /\b(hours|program|h24|non[ -]?stop)\b/],
  ['location', /\b(address|adresa|location|locatie|coordinates|coordonate|iata|icao)\b/],
  ['passenger_numbers', /\b(statistics|statistici|passenger numbers)\b/],
  ['terminal', /\b(terminal\w*|pista|runway)\b/],
  ['airlines_destinations', /\b(destinations|destinatii|airlines|companii)\b/],
];
export function airportTopic(text: string): Topic | undefined {
  const t = normalize(text);
  return aliases.find(([, pattern]) => pattern.test(t))?.[0];
}

// Keep meaningful constraints (free, lost, price, taxi, wifi...) so a broad topic never
// turns a missing fact into an unrelated answer. Match against both curated languages.
const stop = new Set('a an the is are do does can i we my me you your it there at in on to for of and or with from about tell please through take bring use lua duc what where when how much which have get be airport craiova aeroport aeroportul la de din pe cu si sau ce cat care cum unde cand este e sunt se pot poate un o am eu imi va rog despre exista pot sa ma imi spune spuneti info information informatii'.split(' '));
const alternatives: Record<string, string[]> = {
  coffee: ['cafe', 'cafene'], cafea: ['cafe', 'cafene'],
  price: ['cost', 'lei', 'fee', 'tarif'], prices: ['cost', 'lei', 'fee', 'tarif'], cost: ['cost', 'lei', 'fee', 'tarif'],
  parcarea: ['parcar', 'parking'], parcare: ['parcar', 'parking'],
  costa: ['cost', 'lei', 'tarif'], tarif: ['lei', 'tarif'], tarife: ['lei', 'tarif'], fees: ['fee', 'lei', 'tarif'],
  liquids: ['liquid', 'lichid'], lichide: ['liquid', 'lichid'], bags: ['bag', 'luggage'],
};
const topicNames: Record<string, Topic> = {
  parking: 'parking', park: 'parking', parcare: 'parking', parcarea: 'parking', parcari: 'parking',
  security: 'security', securitate: 'security', baggage: 'baggage', luggage: 'baggage', bagaje: 'baggage',
  terminal: 'terminal', hours: 'hours', program: 'hours', contacts: 'contacts', contact: 'contacts',
  services: 'services', servicii: 'services', accessibility: 'accessibility', accesibilitate: 'accessibility',
};
const words = (text: string) => normalize(text).match(/[a-z0-9]+/g) ?? [];

export function airportInfo(input: { topic?: string; query?: string } = {}, lang?: Lang) {
  const place = placeQuestion(input.query ?? '');
  if (place && !amenityKind(input.query ?? input.topic ?? '')) return { found: true, facts: [{ text: positionDescription(place, lang), source: 'Plan T2', official: true, label: '', status: 'map' }], asOf: guide.accessed };
  const amenity = amenityKind(input.query ?? input.topic ?? '');
  if (amenity) return { found: true, asOf: guide.accessed, amenities: amenities.filter(a => a.kind === amenity), facts: amenities.filter(a => a.kind === amenity).map(a => ({
    text: amenityDescription(a, lang), source: 'Plan T2', official: true, label: '', status: 'map',
  })) };
  const notFound = () => ({ found: false, error: 'not_found', facts: [], asOf: guide.accessed,
    note: lang === 'en' ? "I don't know; the airport guide has no matching information." : 'Nu știu; ghidul aeroportului nu conține informații corespunzătoare.' });
  const rawTopic = input.topic?.trim();
  const topic = rawTopic ? (Object.hasOwn(topics, rawTopic) ? rawTopic as Topic : airportTopic(rawTopic)) : undefined;
  if (rawTopic && !topic) return notFound();
  const query = input.query?.trim() ?? '';
  if (!topic && !query) return { ...notFound(), topics: Object.keys(topics) };
  // A topic-only query ("parking", "parcare") selects that topic. Otherwise every
  // meaningful query word must match a fact, rather than silently dropping constraints.
  const queryWords = words(query).filter(w => !stop.has(w));
  const namedTopic = topicNames[queryWords.join(' ')];
  const selected = topic ?? namedTopic;
  const terms = namedTopic ? [] : queryWords;
  const candidates = Object.entries(topics).filter(([key]) => !selected || key === selected).flatMap(([key, facts]) => facts.map(f => ({ ...f, topic: key })));
  const facts = candidates.filter(f => {
    const hay = words(`${f.topic.replaceAll('_', ' ')} ${f.fact} ${f.en}`);
    return terms.every(t => (alternatives[t] ?? [t]).some(term => hay.some(w => w.startsWith(term))));
  }).slice(0, 6).map(f => ({
    ...f,
    // These are curated translations/descriptions, never runtime fabricated facts.
    text: lang === 'en' ? f.en : ('description' in f ? String(f.description) : f.fact),
    label: f.official ? (lang === 'en' ? 'Official source' : 'Sursă oficială') : (lang === 'en' ? 'Unconfirmed' : 'Neconfirmat'),
    status: f.official ? 'official' : 'unconfirmed',
  }));
  return facts.length ? { found: true, facts, asOf: guide.accessed } : notFound();
}

/** Static airport questions; queue/flight/route questions retain their live tools. */
export function isAirportQuestion(text: string) {
  const t = normalize(text), topic = airportTopic(t);
  if (/\b(wifi|wi-fi|atm|lounge|taxi|uber|bolt|kiss|lost and found|obiecte pierdute|exchange|schimb valutar)\b/.test(t)) return true;
  if (topic === 'security') return /liquid|lichid|laptop|100\s*ml|screening|rule|regul|permis|allowed|control.*manual/.test(t);
  if (topic === 'baggage') return /size|weight|dimensi|greutat|kg|priority|allowance|permis|allowed/.test(t);
  if (topic === 'wizz_checkin') return /online|wizz|rule|regul|deschid|inchid|open|close|cost|pret|fee/.test(t);
  if (/\b(queue|coada|cozi|crowd|gate|poarta|delay|status|route|traseu|ruta)\b/.test(t)) return false;
  return Boolean(topic);
}

export const amenities = landmarks.filter(l => ['G_WC','U_WC','G_CAFE','U_CAFE','kiosk_west','vending_1','atm_bcr','atm_euronet','G_INFO','U_DUTY_FREE'].includes(l.id)).map(l => ({
  ...l, kind: /WC/.test(l.id) ? 'toilet' : /atm/.test(l.id) ? 'atm' : l.id === 'G_INFO' ? 'info' : l.id === 'U_DUTY_FREE' ? 'shop' : 'food',
}));
export function amenityKind(text: string): string | undefined {
  const t = normalize(text);
  if (/\b(wc|toalet\w*|toilet\w*|restroom|bathroom)\b/.test(t)) return 'toilet';
  if (/\b(food|eat|manc\w*|mananc\w*|restaurant|cafenea|cafea|coffee|cafe|gourmet)\b/.test(t)) return 'food';
  if (/\b(atm|bancomat|bcr|euronet)\b/.test(t)) return 'atm';
  if (/\b(info|informatii|information desk)\b/.test(t)) return 'info';
  if (/duty[ -]?free/.test(t)) return 'shop';
}
export function amenityDescription(a: typeof amenities[number], lang?: Lang) {
  return positionDescription(a, lang) + ' ' + ( lang === 'en' ? `${a.name.en}: ${a.level === 'G' ? 'ground floor' : 'first floor'}, ${a.side === 'landside' ? 'before security' : 'after security'}.`
    : `${a.name.ro}: ${a.level === 'G' ? 'parter' : 'etajul 1'}, ${a.side === 'landside' ? 'înainte de securitate' : 'după securitate'}.`);
}
export interface RouteIndex {
  points: { id: string; name: { ro: string; en: string }; aliases: string[] }[];
  evac?: Record<string, { file?: string; caption?: string; exit: string; assembly?: string; assemblyPoint?: string; nodes?: string[]; steps?: string[] }>;
  routes: Record<string, { file: string; walkSec: number; steps: unknown; nodes?: string[] }>;
}
/** Per-agent cache includes absent indexes, so a missing deployment never floods the site. */
export class RouteImages {
  private cached?: { until: number; value: RouteIndex | null };
  constructor(private appUrl: string, private fetcher: import('./transport.js').Fetch, private now = Date.now) {}
  async index(): Promise<RouteIndex | null> {
    if (this.cached && this.cached.until > this.now()) return this.cached.value;
    let value: RouteIndex | null = null;
    try {
      const res = await this.fetcher(`${this.appUrl.replace(/\/$/, '')}/routes/index.json`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const json = await res.json() as RouteIndex;
        if (Array.isArray(json.points) && json.routes && typeof json.routes === 'object' && json.points.every(p => p && typeof p.id === 'string' && p.name && typeof p.name.ro === 'string' && typeof p.name.en === 'string' && Array.isArray(p.aliases) && p.aliases.every(a => typeof a === 'string'))) value = json;
      }
    } catch { /* Images are optional. */ }
    this.cached = { until: this.now() + 60000, value };
    return value;
  }
  async evacuation(zone: string) {
    const index = await this.index();
    const entry = index?.evac?.[zone] ?? Object.entries(index?.evac ?? {}).find(([id]) => mapNodeId(id) === mapNodeId(zone))?.[1];
    if (!entry || typeof entry.exit !== 'string') return null;
    const assembly = entry.assembly ?? entry.assemblyPoint;
    if (typeof assembly !== 'string') return null;
    const nodes = Array.isArray(entry.nodes) && entry.nodes.every(n => typeof n === 'string') ? entry.nodes : [zone, entry.exit, assembly];
    let link: string | undefined;
    if (typeof entry.file === 'string') {
      const root = new URL(`${this.appUrl.replace(/\/$/, '')}/routes/`);
      try { const url = new URL(entry.file, root); if (url.href.startsWith(root.href)) link = url.href; } catch { /* Optional preview. */ }
    }
    return { from: zone, exit: entry.exit, assembly, nodes, link, caption: entry.caption };
  }
  async image(from: string, to: string, live?: { nodes: string[]; rerouted?: boolean; reroute?: boolean }, blocked: readonly string[] = []) {
    const index = await this.index();
    const id = (node: string) => index?.points.find(p => p.id === node)?.id ?? index?.points.find(p => mapNodeId(p.id) === mapNodeId(node) || p.aliases.some(a => normalize(a) === normalize(node)))?.id ?? node;
    const entry = index?.routes[`${id(from)}__${id(to)}`];
    if (!entry || typeof entry.file !== 'string' || !Number.isFinite(entry.walkSec) || entry.walkSec < 0) return null;
    // A PNG is safe only when its recorded path matches the current routing response.
    // Older indexes with prose-only steps cannot establish that and stay text-only.
    const staticNodes = entry.nodes ?? (Array.isArray(entry.steps) ? entry.steps.map(step => typeof step === 'string' ? step : step && typeof step === 'object' && 'node' in step ? step.node : null) : entry.steps);
    if (!live || live.rerouted || live.reroute || !Array.isArray(staticNodes) || staticNodes.length < 2 ||
      !staticNodes.every(n => typeof n === 'string') || !Array.isArray(live.nodes)) return null;
    const canonical = (node: string) => mapNodeId(id(node));
    const expected = staticNodes.map(canonical), actual = live.nodes.map(canonical);
    if (expected.length !== actual.length || expected.some((n, i) => n !== actual[i])) return null;
    const closed = new Set(blocked.map(canonical));
    if (actual.some(n => closed.has(n) || closed.has(terminalGraph.nodes.find(p => p.id === n)?.zone ?? n) ||
      (n === 'U_SECURITY' && closed.has('U_SECURITY_QUEUE')))) return null;
    const root = new URL(`${this.appUrl.replace(/\/$/, '')}/routes/`);
    const url = new URL(entry.file, root);
    if (!url.href.startsWith(root.href)) return null;
    return { link: url.href, walkSec: entry.walkSec };
  }
}
export { LANDMARK_TTL_MS } from './location.js';
/** Compatibility signature; the route manifest never supplies place vocabulary. */
export function resolveLandmark(text: string, _index: RouteIndex | null = null): string | undefined {
  return resolveOrigin(text)?.id;
}

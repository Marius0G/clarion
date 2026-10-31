import guide from './airport-guide.json';
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

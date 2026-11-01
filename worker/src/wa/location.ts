import { landmarks, resolveLandmark as match, normalizeLandmark, landmarkRoute, type Landmark } from '../../../backend/src/landmarks.js';
import type { Lang } from './texts.js';
export { landmarks, landmarkRoute };
export const LANDMARK_TTL_MS = 600_000;
export const landmarkById = (id: string) => landmarks.find(l => l.id === id || l.sourceIds.includes(id));
/** Isolate an explicitly stated origin before matching: a destination never becomes a position. */
export function originPhrase(text: string) {
  const t = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, ' ');
  const phrase = /(?:sunt (?:la|in|langa)|ma aflu (?:la|in|langa)|de la|i am (?:at|near|by)|i m (?:at|near|by)|from)\s+(.+)/.exec(t)?.[1]
    ?.split(/[.!?,;]|\b(?:cum ajung|cum merg|how|to gate|spre|pana la|unde|where)\b/)[0];
  return phrase ? normalizeLandmark(phrase) : undefined;
}
export function resolvePlace(text: string): Landmark | null {
  return landmarkById(text) ?? match(text);
}
/** Only location questions or a bare place alias may bypass the sourced airport guide. */
export function placeQuestion(text: string) {
  const q = normalizeLandmark(text), l = resolvePlace(text);
  if (!l) return null;
  return /^(?:unde (?:e|este|sunt)|where (?:is|are)) /.test(q) || l.aliases.some(a => normalizeLandmark(a) === q) ? l : null;
}
/** Return every equally specific alias match; generic ATM names describe both machines. */
export function originCandidates(text: string) {
  const phrase = originPhrase(text);
  const raw = phrase ?? (/\b(unde|where|cum|how|ajung|nearest|closest)\b/.test(normalizeLandmark(text)) ? '' : text);
  const exact = landmarkById(raw);
  if (exact) return [exact];
  const q = normalizeLandmark(raw);
  let best = 0;
  let matches: Landmark[] = [];
  for (const l of landmarks) {
    const aliases = l.id.startsWith('atm_') ? [...l.aliases, 'atm', 'bancomat', 'cash machine', 'cash'] : l.aliases;
    const score = Math.max(0, ...aliases.map(normalizeLandmark).filter(a => a && (` ${q} `).includes(` ${a} `)).map(a => a.length));
    if (score > best) { best = score; matches = [l]; }
    else if (score && score === best) matches.push(l);
  }
  return matches;
}
export function resolveOrigin(text: string) {
  const matches = originCandidates(text);
  return matches.length === 1 ? matches[0] : undefined;
}
export function ambiguityChoices(candidates: Landmark[], lang?: Lang) {
  return candidates.slice(0, 10).map(l => ({ id: `loc:${l.id}`, title: l.name[lang === 'en' ? 'en' : 'ro'].slice(0, 24), description: positionDescription(l, lang).slice(0, 72) }));
}
export function positionDescription(l: Landmark, lang?: Lang) {
  if (lang !== 'en') return `${l.name.ro}: ${l.position}.`;
  const position = l.position.replace('Parter', 'Ground floor').replace('Etaj 1', 'First floor').replace('Exterior', 'Outside')
    .replaceAll('la est de', 'east of').replaceAll('la vest de', 'west of').replaceAll('la nord de', 'north of').replaceAll('la sud de', 'south of');
  let translated = position;
  for (const p of [...landmarks].sort((a,b) => b.name.ro.length-a.name.ro.length)) translated = translated.replaceAll(p.name.ro, p.name.en);
  return `${l.name.en}: ${translated}.`;
}
export function locationChoices(stage: string, gate: string | undefined, lang?: Lang) {
  const ids = stage === 'airside' || stage === 'gate'
    ? ['U_SECURITY', 'U_DUTY_FREE', 'U_CAFE', 'U_WC', gate ?? 'U_GATE_3', 'U_CONCOURSE']
    : ['door_departures', 'G_CHECKIN_QUEUE', 'G_CENTER', 'G_INFO', 'G_CAFE', 'G_WC', 'atm_bcr'];
  const short: Record<string,string[]> = { G_CHECKIN_QUEUE: ['Check-in','Check-in'], G_CAFE: ['Cafenea','Café'], U_CAFE: ['Cafenea etaj','Upstairs café'] };
  return [...new Set(ids)].flatMap(id => { const l = landmarkById(id); return l ? [{ id: `loc:${l.id}`, title: (short[l.id]?.[lang === 'en' ? 1 : 0] ?? l.name[lang === 'en' ? 'en' : 'ro']).slice(0,24) }] : []; })
    .concat({ id: 'loc:other', title: lang === 'en' ? 'Other' : 'Altceva' }).slice(0,10);
}
/** Ambiguous free text gets one concrete candidate, never an invented position. */
export function locationCandidate(text: string) {
  const t = normalizeLandmark(originPhrase(text) ?? text);
  return landmarks.map(l => ({ l, score: Math.max(0, ...l.aliases.filter(a => (` ${t} `).includes(` ${normalizeLandmark(a)} `)).map(a => normalizeLandmark(a).length)) })).filter(c => c.score > 0).sort((a,b) => b.score-a.score)[0]?.l;
}

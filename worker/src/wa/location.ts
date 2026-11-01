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
export function resolveOrigin(text: string) {
  const phrase = originPhrase(text);
  // Standalone landmark replies are valid, full questions are not origins.
  return resolvePlace(phrase ?? (/\b(unde|where|cum|how|ajung|nearest|closest)\b/.test(normalizeLandmark(text)) ? '' : text));
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

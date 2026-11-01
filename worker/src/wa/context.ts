// Moni's bounded personal context, stored beside the existing WA profile in the Tower.
import type { HistoryEntry } from './agent.js';
import type { Profile } from './tools.js';

export interface PassengerContext {
  history: HistoryEntry[];
  summary?: string;
  notes?: { at: string; tool: string; note: string }[];
  alerts?: { at: string; kind: string; text: string }[];
}
export const HISTORY_CAP = 12; // user turns, independent of the number of reply bubbles
export const HISTORY_KEEP = 6;
export const SUMMARY_MAX = 1500;
export const NOTES_MAX = 8;
export const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Only explicit self-reports; questions and hypothetical needs do not become facts. */
export function extractFacts(text: string): Partial<Profile> {
  const t = normalize(text), patch: Partial<Profile> = {};
  if (/[?]/.test(t) || /\b(daca|if|what if)\b/.test(t)) return patch;
  if (/\b(nu am|n-am|fara|no|without) (checked (bags?|baggage|luggage)|bagaj(?:e)?(?: de cala)?)\b|\bi (?:don't|do not) have checked (?:bags?|baggage|luggage)\b|\bi have no checked (?:bags?|baggage|luggage)\b|\b(hand luggage only|only hand luggage)\b/.test(t)) patch.hasCheckedBag = false;
  else if (/\b(am|i have|i've got|with) (?:un |a |some )?(?:checked (?:bags?|baggage|luggage)|bagaj(?:e)? de cala)\b/.test(t)) patch.hasCheckedBag = true;
  const group = /\b(?:suntem|we are|party of|group of)\s+(\d{1,2})\b/.exec(t);
  if (group && +group[1]! > 0) patch.groupSize = +group[1]!;
  const needs: Record<string, boolean> = {};
  if (/\bam (?:un |doi |\d+ )?(?:copii|copil)\b|\b(?:sunt|calatoresc|vin|am venit) cu (?:un |doi |\d+ )?(?:copii|copil)|\b(?:i|we)(?: am| are|'m|'re)? (?:travelling |traveling )?with (?:a |my |our |one |two |three |\d+ )?(?:kids|children|child|baby)\b/.test(t)) needs.kids = true;
  if (/\b(?:nu sunt|nu calatoresc|nu vin) cu copii|\b(?:nu am copii|fara copii|no kids|without children)\b/.test(t)) needs.kids = false;
  if (/\b(?:am mobilitate redusa|folosesc (?:un )?scaun rulant|i (?:use|need) a wheelchair|i have reduced mobility)\b/.test(t)) needs.reducedMobility = true;
  if (/\b(?:nu am mobilitate redusa|i do not have reduced mobility)\b/.test(t)) needs.reducedMobility = false;
  if (Object.keys(needs).length) patch.needs = needs;
  return patch;
}

/** Allowlist prevents arbitrary model-created profile keys or identity/role changes. */
export function factPatch(key: unknown, value: unknown): Partial<Profile> | undefined {
  if (key === 'hasCheckedBag' && typeof value === 'boolean') return { hasCheckedBag: value };
  if (key === 'groupSize' && Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 99) return { groupSize: Number(value) };
  if ((key === 'kids' || key === 'reducedMobility') && typeof value === 'boolean') return { needs: { [key]: value } };
  if (key === 'needs' && typeof value === 'string' && value.trim().length > 0 && value.length <= 200) return { needs: { other: value.trim() } };
  if (key === 'lang' && (value === 'ro' || value === 'en')) return { lang: value };
  return undefined;
}

export function plainSummary(previous: string, entries: HistoryEntry[]) {
  const lines = entries.filter(e => !e.text.startsWith('[react]')).map(e => `${e.role}: ${e.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  return [previous, ...lines].filter(Boolean).join(' | ').slice(-SUMMARY_MAX);
}

export function lookupNote(tool: string, result: any): string | undefined {
  if (tool === 'rememberFact' || !result || result.error) return;
  if (tool === 'queues') return result.available
    ? result.zones.map((z: any) => `${z.zone}: ${z.waitMin ?? '?'} min at ${result.now}`).join('; ').slice(0, 400)
    : String(result.note).slice(0, 400);
  if (tool === 'whenToArrive') return `${result.flight}: entrance–gate ~${result.totalMin ?? '?'} min; gate ${result.gate}, closes ${result.gateCloseAt}`;
  if (tool === 'myFlight') return `${result.flight}: ${result.status}, gate ${result.gate}, departure ${result.departure}, checked at ${result.now}`;
  if (tool === 'airportInfo') return (result.facts ?? []).map((f: any) => `${f.official ? '' : 'unconfirmed: '}${f.fact} (${f.source})`).join('; ').slice(0, 700) || 'Not found';
  return String(result.note ?? result.status ?? '').slice(0, 400) || undefined;
}

/** Conservative turn-language detection: short codes and shared airport nouns keep the previous choice. */
export function messageLanguage(text: string): 'ro' | 'en' | undefined {
  const t = normalize(text);
  const ro = t.match(/\b(sunt|unde|cum|ajung|poarta|zborul|meu|mea|pierdut|rucsac|vreau|mancare|multumesc|securitate|este|am|la|sa|ce|cand)\b/g)?.length ?? 0;
  const en = t.match(/\b(i|my|is|where|how|can|eat|something|flight|on|time|the|lost|at|please|thanks|hello|security|want|when|are)\b/g)?.length ?? 0;
  return ro > en ? 'ro' : en > ro ? 'en' : undefined;
}
export const lostItemClaim = (text: string) => /\b(am pierdut|mi-am pierdut|i lost|i have lost|i've lost)\b/i.test(normalize(text));

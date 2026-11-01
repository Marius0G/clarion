/**
 * The passenger landmark catalogue and route index (public/routes/index.json), the same data the
 * WhatsApp route pictures come from, so a route drawn here matches the picture sent on WhatsApp.
 */
import nav from '../../../../docs/contract/terminal.json' with { type: 'json' }
import { mapNodeId } from '../../../../backend/src/mapIds'
import type { Level } from '../t2/data'

export type Lang = 'ro' | 'en'
export type Named = { ro: string; en: string }
export interface Landmark {
  id: string; name: Named; aliases: string[]; area: 'landside' | 'departures' | 'arrivals'
  graphNode: string; level: Level; floor: string; side: 'landside' | 'airside'; x: number; z: number
  sourceIds?: string[]; position?: string
  nearest?: Partial<Record<'wc' | 'food' | 'info' | 'exit', { id: string; walkSec: number } | null>>
}
export interface Step { node: string; name: Named; level: Level; sec: number }
export interface RouteEntry { file: string; walkSec: number; steps: Step[] }
export interface EvacEntry extends RouteEntry { exit: string; assembly: string; caption?: string }
export interface RouteIndex {
  points: Landmark[]
  routes: Record<string, RouteEntry>
  evac: Record<string, EvacEntry>
  skipped?: { from: string; to: string; reason: string }[]
}
export interface PathNode { id: string; level: Level; x: number; z: number }

let pending: Promise<RouteIndex> | null = null
/** One fetch per page; the browser cache is shared with the report form. */
export function loadIndex(): Promise<RouteIndex> {
  pending ??= fetch('/routes/index.json').then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<RouteIndex> })
    .catch(e => { pending = null; throw e })
  return pending
}

/* ---------- Categories, tiers and chips ---------- */
export type Category = 'gate' | 'wc' | 'food' | 'shop' | 'info' | 'atm' | 'checkin' | 'security' | 'passport' | 'belt'
  | 'exit' | 'emergency' | 'transport' | 'parking' | 'vertical' | 'assembly' | 'area' | 'apron'

export function categoryOf(id: string): Category {
  if (/^U_GATE_\d+$/.test(id)) return 'gate'
  if (/^G_GATE_DOOR_/.test(id)) return 'apron'
  if (/_WC$/.test(id)) return 'wc'
  if (/_CAFE$|^kiosk_|^vending_/.test(id)) return 'food'
  if (/^shop_|DUTY_FREE/.test(id)) return 'shop'
  if (id === 'G_INFO' || id === 'lost_found') return 'info'
  if (/^atm_/.test(id)) return 'atm'
  if (/^check_in:|CHECKIN/.test(id)) return 'checkin'
  if (/SECURITY/.test(id)) return 'security'
  if (/PASSPORT/.test(id)) return 'passport'
  if (/RECLAIM/.test(id)) return 'belt'
  if (/^door_emergency/.test(id)) return 'emergency'
  if (/^door_|ARRIVALS_EXIT/.test(id)) return 'exit'
  if (/PARKING/.test(id)) return 'parking'
  if (/^X_(TAXI|BOLT|BUS|KERB)/.test(id)) return 'transport'
  if (/stairs|escalator|lift|ESCALATOR|STAIRS/.test(id)) return 'vertical'
  if (/^ASSEMBLY_/.test(id)) return 'assembly'
  return 'area'
}

/** Progressive detail: 0 always drawn, 1 from ~2× zoom, 2 only close up. */
export function tierOf(id: string): 0 | 1 | 2 {
  const c = categoryOf(id)
  if (c === 'gate' || c === 'security' || c === 'checkin' && !id.startsWith('check_in:') || c === 'info' && id === 'G_INFO' || c === 'wc' || id === 'door_departures' || c === 'belt') return 0
  if (c === 'food' || c === 'atm' || c === 'passport' || c === 'exit' || c === 'transport' || c === 'shop' && id === 'U_DUTY_FREE' || id.startsWith('check_in:') || c === 'emergency') return 1
  return 2
}
/** Higher draws first when icons collide. */
export function rankOf(id: string): number {
  const c = categoryOf(id)
  const base: Record<Category, number> = { gate: 90, security: 88, checkin: 84, wc: 80, info: 78, belt: 76, exit: 70, food: 66, passport: 64, atm: 60,
    emergency: 56, transport: 54, shop: 50, parking: 40, vertical: 34, assembly: 30, area: 20, apron: 10 }
  return base[c] - (id.startsWith('check_in:') ? 6 : 0)
}

export interface Chip { key: string; label: Named; cats: Category[] }
export const CHIPS: Chip[] = [
  { key: 'wc', label: { ro: 'Toalete', en: 'Toilets' }, cats: ['wc'] },
  { key: 'food', label: { ro: 'Mâncare', en: 'Food' }, cats: ['food'] },
  { key: 'gate', label: { ro: 'Porți', en: 'Gates' }, cats: ['gate'] },
  { key: 'info', label: { ro: 'Info', en: 'Info' }, cats: ['info'] },
  { key: 'atm', label: { ro: 'Bancomat', en: 'ATM' }, cats: ['atm'] },
  { key: 'exit', label: { ro: 'Ieșiri', en: 'Exits' }, cats: ['exit', 'emergency'] },
]

/** Floors named by use, as at Changi ("L2 (Departure)"). */
export const FLOOR_NAMES: Record<'G' | 'U', Named> = {
  G: { ro: 'Parter · Check-in și sosiri', en: 'Ground · Check-in and arrivals' },
  U: { ro: 'Etaj 1 · Plecări', en: 'Level 1 · Departures' },
}
export const floorShort = (l: Level, lang: Lang) => l === 'U' ? (lang === 'en' ? 'Level 1' : 'Etaj 1') : l === 'X' ? (lang === 'en' ? 'Outside' : 'Exterior') : (lang === 'en' ? 'Ground' : 'Parter')

/** Short name for map labels: no parentheses, no star. */
export const shortName = (l: Pick<Landmark, 'name'>, lang: Lang) => l.name[lang].replace(/\s*\(.*\)\s*$/, '').replace(/\s*\*$/, '')

/* ---------- Search ---------- */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** Best matches first: name prefix, word prefix, alias, anywhere. Empty query matches nothing. */
export function search(points: readonly Landmark[], query: string, lang: Lang, limit = 12): Landmark[] {
  const q = fold(query)
  if (!q) return []
  const scored: [number, Landmark][] = []
  for (const p of points) {
    if (categoryOf(p.id) === 'apron') continue
    const name = fold(p.name[lang]), other = fold(p.name[lang === 'en' ? 'ro' : 'en'])
    const aliases = p.aliases.map(fold)
    const score = name.startsWith(q) ? 0 : ` ${name}`.includes(` ${q}`) ? 1 : aliases.some(a => a.startsWith(q)) ? 2
      : other.startsWith(q) || aliases.some(a => ` ${a}`.includes(` ${q}`)) ? 3 : name.includes(q) || aliases.some(a => a.includes(q)) ? 4 : -1
    if (score >= 0) scored.push([score * 100 - rankOf(p.id) / 10, p])
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].name[lang].localeCompare(b[1].name[lang])).slice(0, limit).map(s => s[1])
}

/* ---------- Places and routes ---------- */
type NavNode = { id: string; x: number; y: number; level?: string }
const NODES = new Map((nav as unknown as { nodes: NavNode[] }).nodes.map(n => [n.id, n]))

/** Landmark for any id the backend speaks: landmark id, graph node, source id or alias (`security`, `gate_3`). */
export function landmarkFor(points: readonly Landmark[], id: string | null | undefined): Landmark | undefined {
  if (!id) return undefined
  const canonical = mapNodeId(id)
  return points.find(p => p.id === id) ?? points.find(p => p.id === canonical)
    ?? points.find(p => p.graphNode === canonical && p.id === p.graphNode) ?? points.find(p => p.sourceIds?.includes(id) || p.sourceIds?.includes(canonical))
    ?? points.find(p => p.graphNode === canonical)
}
/** World position of a route node: the landmark itself at the ends, graph nodes in between. */
export function nodeAt(points: readonly Landmark[], id: string): PathNode | null {
  const l = points.find(p => p.id === id)
  if (l) return { id, level: l.level, x: l.x, z: l.z }
  const n = NODES.get(id) ?? NODES.get(mapNodeId(id))
  return n ? { id, level: (n.level ?? 'G') as Level, x: n.x, z: n.y } : null
}
export const pathOf = (points: readonly Landmark[], steps: readonly Step[]): PathNode[] =>
  steps.map(s => nodeAt(points, s.node)).filter((n): n is PathNode => !!n)

export type RouteResult = { ok: true; entry: RouteEntry; path: PathNode[] } | { ok: false; reason: string }
const REASONS: Record<string, Named> = {
  after_security: { ro: 'După securitate nu se mai poate reveni în zona publică.', en: 'After security there is no way back to the public area.' },
  arrivals_only: { ro: 'Zona de sosiri se atinge doar dintr-un zbor aterizat.', en: 'Arrivals is reached only from a landed flight.' },
}
export function routeBetween(index: RouteIndex, from: string, to: string, lang: Lang): RouteResult {
  if (from === to) return { ok: false, reason: lang === 'en' ? 'You are here.' : 'Ești aici.' }
  const entry = index.routes[`${from}__${to}`]
  if (entry) return { ok: true, entry, path: pathOf(index.points, entry.steps) }
  const skip = index.skipped?.find(s => s.from === from && s.to === to)
  return { ok: false, reason: (skip && REASONS[skip.reason]?.[lang]) ?? (lang === 'en' ? 'No walking route from here.' : 'Niciun drum pe jos de aici.') }
}
/** Evacuation entry for a picture link (`/routes/evac/<zone>.png`) or a zone id. */
export function evacFor(index: RouteIndex, imageOrZone: string | undefined): EvacEntry | undefined {
  if (!imageOrZone) return undefined
  return Object.values(index.evac).find(e => e.file === imageOrZone) ?? index.evac[imageOrZone] ?? index.evac[mapNodeId(imageOrZone)]
}
export const minutes = (sec: number) => Math.max(1, Math.round(sec / 60))
const VIA: Record<string, Named> = { escalator: { ro: 'cu escalatorul', en: 'by escalator' }, stairs: { ro: 'pe scări', en: 'by the stairs' }, lift: { ro: 'cu liftul', en: 'by lift' } }
const viaOf = (id: string) => (['escalator', 'stairs', 'lift'] as const).find(k => id.startsWith(k) || id.includes(`_${k}`) || id.includes(k.toUpperCase()))
/** Floor changes along a path: where, which way, and how ("Urci la etaj 1 cu escalatorul"). */
export function floorChanges(path: readonly PathNode[], lang: Lang) {
  const plate = (l: Level) => l === 'U' ? 1 : 0
  const out: { at: PathNode; to: PathNode; up: boolean; text: string }[] = []
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!
    if (plate(a.level) === plate(b.level)) continue
    const up = plate(b.level) > plate(a.level), via = viaOf(a.id) ?? viaOf(b.id)
    const floor = up ? (lang === 'en' ? 'level 1' : 'etaj 1') : (lang === 'en' ? 'ground floor' : 'parter')
    out.push({ at: a, to: b, up, text: `${lang === 'en' ? (up ? 'Up to' : 'Down to') : (up ? 'Urci la' : 'Cobori la')} ${floor}${via ? ` ${VIA[via]![lang]}` : ''}` })
  }
  return out
}

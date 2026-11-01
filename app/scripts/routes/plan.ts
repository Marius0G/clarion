/**
 * Every ordered pair of landmarks routed with the backend's own `route()` on its terminal graph,
 * so the picture matches the WhatsApp text. Free flow (no live density), nothing blocked.
 */
import { route, FREE_SPEED, type Route } from '../../../backend/src/routing.ts'
import { terminalGraph, zones } from '../../../backend/src/terminal.ts'
import { evacuationRoute } from '../../../backend/src/evacuation.ts'
import { landmarks, type Area, type Landmark } from './landmarks.ts'

export type Level = 'G' | 'U' | 'X'
export interface PathNode { id: string; level: Level; x: number; z: number }
export interface Step { node: string; name: { ro: string; en: string }; level: Level; sec: number }
export interface PlannedRoute { from: string; to: string; walkSec: number; path: PathNode[]; steps: Step[] }
export interface Skipped { from: string; to: string; reason: SkipReason }
export type SkipReason = 'after_security' | 'arrivals_only' | 'no_route' | 'crosses_restricted_area' | 'emergency_only'
export interface Evacuation { zone: string; exit: string; assembly: string; walkSec: number; path: PathNode[]; steps: Step[] }

export const skipReasons: Record<SkipReason, string> = {
  after_security: 'After security a departing passenger cannot walk back to the public (landside) area.',
  arrivals_only: 'Baggage belts and arrivals passport control are reached only from a landed flight.',
  no_route: 'The backend graph has no normal route between the two.',
  crosses_restricted_area: 'The shortest graph path crosses an area this passenger may not enter.',
  emergency_only: 'The only path uses a crossing the backend opens for evacuations only.',
}

const nodes = new Map(terminalGraph.nodes.map(n => [n.id, n]))
/** Hops a passenger may walk in normal operation (one-way edges only forwards). */
const normalHops = new Set(terminalGraph.edges.filter(e => !e.evacuationOnly).flatMap(e => e.oneWay ? [`${e.from}>${e.to}`] : [`${e.from}>${e.to}`, `${e.to}>${e.from}`]))
const zoneSide = new Map(zones.map(z => [z.id, z.side]))
const ARRIVALS = new Set(['G_RECLAIM_1', 'G_RECLAIM_2', 'G_ARRIVALS_PASSPORT'])
/** Area of any graph node: arrivals hall zones, other airside = departures, the rest landside. */
export function areaOf(id: string): Area {
  const n = nodes.get(id)
  const zone = n?.zone ?? id
  if (ARRIVALS.has(zone) || /^G_GATE_DOOR_/.test(zone) || id === 'door_arrivals_entry') return 'arrivals'
  return zoneSide.get(zone) === 'airside' ? 'departures' : 'landside'
}

/** Which way a passenger may go in normal operation. */
export function allowed(from: Area, to: Area): SkipReason | null {
  if (from === 'departures' && to === 'landside') return 'after_security'
  if ((from === 'arrivals') !== (to === 'arrivals') && !(from === 'arrivals' && to === 'landside')) return 'arrivals_only'
  return null
}

const byId = new Map(landmarks.map(l => [l.id, l]))
const POINT_NAMES: Record<string, [string, string]> = {
  escalator: ['Escalator', 'Escalator'], lift: ['Lift', 'Lift'], stairs: ['Scări', 'Stairs'],
}
export function nameOf(id: string): { ro: string; en: string } {
  const l = byId.get(id)
  if (l) return l.name
  const z = zones.find(z => z.id === id)
  if (z) return { ro: z.name_ro.replace(/\s*\*$/, ''), en: z.name_en.replace(/\s*\*$/, '') }
  const kind = Object.keys(POINT_NAMES).find(k => id.startsWith(k) || id.includes(`_${k}`))
  if (kind) return { ro: POINT_NAMES[kind]![0], en: POINT_NAMES[kind]![1] }
  if (/^door_emergency/.test(id)) return { ro: 'Ieșire de urgență', en: 'Emergency exit' }
  if (/^door_apron_gate_(\d+)/.test(id)) { const n = /(\d+)/.exec(id)![1]; return { ro: `Ușă peron, poarta ${n}`, en: `Apron door, gate ${n}` } }
  if (/^door_/.test(id)) return { ro: 'Ușă', en: 'Door' }
  if (/^checkin_(\d+)/.test(id)) { const n = /(\d+)/.exec(id)![1]; return { ro: `Ghișeul ${n}`, en: `Desk ${n}` } }
  return { ro: id, en: id }
}

function toPath(r: Route): { path: PathNode[]; steps: Step[] } {
  const path = r.nodes.map(id => { const n = nodes.get(id)!; return { id, level: (n.level ?? 'G') as Level, x: n.x, z: n.y } })
  const steps = r.nodes.map((id, i) => ({ node: id, name: nameOf(id), level: path[i]!.level, sec: Math.round(i === 0 ? 0 : r.segments[i - 1]!.sec) }))
  return { path, steps }
}

export function planRoutes(list: Landmark[] = landmarks) {
  const routes: PlannedRoute[] = []
  const skipped: Skipped[] = []
  for (const a of list) for (const b of list) {
    if (a.id === b.id) continue
    const rule = allowed(a.area, b.area)
    if (rule) { skipped.push({ from: a.id, to: b.id, reason: rule }); continue }
    const r = route(terminalGraph, a.graphNode, b.graphNode)
    if (!r) { skipped.push({ from: a.id, to: b.id, reason: 'no_route' }); continue }
    // Every node on the way must be somewhere this passenger may be: never back through security,
    // never through the arrivals hall unless coming from it.
    const areas = r.nodes.map(areaOf)
    const bad = areas.some((x, i) => i > 0 && allowed(areas[i - 1]!, x) !== null)
      || (a.area !== 'arrivals' && areas.includes('arrivals'))
    if (bad) { skipped.push({ from: a.id, to: b.id, reason: 'crosses_restricted_area' }); continue }
    if (r.nodes.some((id, i) => i > 0 && !normalHops.has(`${r.nodes[i - 1]}>${id}`))) { skipped.push({ from: a.id, to: b.id, reason: 'emergency_only' }); continue }
    const converted = toPath(r)
    // Symbols without navigation nodes keep their real position and expose their graph anchor in index.points.
    const endpoint = (l: Landmark) => ({ id: l.id, level: l.level, x: l.x, z: l.z })
    const step = (l: Landmark) => ({ node: l.id, name: l.name, level: l.level, sec: 0 })
    if (a.id !== r.nodes[0]) { converted.path.unshift(endpoint(a)); converted.steps.unshift(step(a)) }
    if (b.id !== r.nodes.at(-1)) { converted.path.push(endpoint(b)); converted.steps.push(step(b)) }
    const startNode = nodes.get(a.graphNode)!, endNode = nodes.get(b.graphNode)!
    const startSec = a.id === a.graphNode ? 0 : Math.hypot(a.x-startNode.x, a.z-startNode.y) / FREE_SPEED
    const endSec = b.id === b.graphNode ? 0 : Math.hypot(b.x-endNode.x, b.z-endNode.y) / FREE_SPEED
    if (startSec) converted.steps[1]!.sec = Math.ceil(startSec)
    if (endSec) converted.steps.at(-1)!.sec = Math.ceil(endSec)
    const walkSec = Math.max(1, Math.ceil(r.totalSec + startSec + endSec))
    routes.push({ from: a.id, to: b.id, walkSec, ...converted })
  }
  return { routes, skipped }
}

/** Zones a person can stand in on the two floors (the apron door boxes are part of the gate stairs). */
export const evacZones = zones.filter(z => (z.level === 'G' || z.level === 'U') && !z.id.startsWith('G_GATE_DOOR_')).map(z => z.id)

/** Evacuation: the backend's own fallback rule (backend/src/evacuation.ts), so the picture matches the text. */
export function planEvacuations(ids: string[] = evacZones): Evacuation[] {
  const out: Evacuation[] = []
  for (const zone of ids) {
    const e = evacuationRoute(zone)
    if (e) out.push({ zone, exit: e.exit, assembly: e.assembly, walkSec: Math.round(e.route.totalSec), ...toPath(e.route) })
  }
  return out
}

const EXIT_PHRASE: Record<string, string> = {
  door_emergency_east: 'ieșirea de urgență est', door_emergency_west: 'ieșirea de urgență vest',
  door_departures: 'intrarea de la plecări', door_exit_west: 'ușa de la sosiri', door_arrivals_east: 'ușa de sosiri est',
  door_exit_mid: 'ieșirea spre parcare', door_arrivals_entry: 'ușa de sosiri dinspre peron',
}
const ASSEMBLY_PHRASE: Record<string, string> = {
  ASSEMBLY_LANDSIDE_WEST: 'punctul de adunare vest', ASSEMBLY_LANDSIDE_EAST: 'punctul de adunare est', ASSEMBLY_AIRSIDE: 'punctul de adunare de pe peron',
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** Caption for an evacuation picture: "Ieșirea de urgență est, apoi punctul de adunare est". */
export function evacCaption(exit: string, assembly: string): string {
  const gate = /^door_apron_gate_(\d+)$/.exec(exit)
  const door = gate ? `ușa de peron de la poarta ${gate[1]}` : EXIT_PHRASE[exit] ?? nameOf(exit).ro.toLowerCase()
  return `${cap(door)}, apoi ${ASSEMBLY_PHRASE[assembly] ?? nameOf(assembly).ro.toLowerCase()}`
}

/**
 * Every ordered pair of landmarks routed with the backend's own `route()` on its terminal graph,
 * so the picture matches the WhatsApp text. Free flow (no live density), nothing blocked.
 */
import { route, type Route } from '../../../backend/src/routing.ts'
import { terminalGraph, zones } from '../../../backend/src/terminal.ts'
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
  emergency_only: 'The only path uses a crossing the backend opens for evacuations only (route() treats a door as an exit).',
}

const nodes = new Map(terminalGraph.nodes.map(n => [n.id, n]))
const emergencyEdges = new Set(terminalGraph.edges.filter(e => e.evacuationOnly).flatMap(e => [`${e.from}>${e.to}`, `${e.to}>${e.from}`]))
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
    const r = route(terminalGraph, a.id, b.id)
    if (!r) { skipped.push({ from: a.id, to: b.id, reason: 'no_route' }); continue }
    // Every node on the way must be somewhere this passenger may be: never back through security,
    // never through the arrivals hall unless coming from it.
    const areas = r.nodes.map(areaOf)
    const bad = areas.some((x, i) => i > 0 && allowed(areas[i - 1]!, x) !== null)
      || (a.area !== 'arrivals' && areas.includes('arrivals'))
    if (bad) { skipped.push({ from: a.id, to: b.id, reason: 'crosses_restricted_area' }); continue }
    if (r.nodes.some((id, i) => i > 0 && emergencyEdges.has(`${r.nodes[i - 1]}>${id}`))) { skipped.push({ from: a.id, to: b.id, reason: 'emergency_only' }); continue }
    routes.push({ from: a.id, to: b.id, walkSec: Math.round(r.totalSec), ...toPath(r) })
  }
  return { routes, skipped }
}

const ASSEMBLY = zones.filter(z => z.id.startsWith('ASSEMBLY_'))
/** Doors the package marks as evacuation exits; the backend makes them `exit` nodes. */
const EXITS = terminalGraph.nodes.filter(n => n.kind === 'exit' && !n.id.startsWith('ASSEMBLY_')).map(n => n.id)
/** Zones a person can stand in on the two floors (the apron door boxes are part of the gate stairs). */
export const evacZones = zones.filter(z => (z.level === 'G' || z.level === 'U') && !z.id.startsWith('G_GATE_DOOR_')).map(z => z.id)

const exitSide = (exit: string) => /apron|arrivals_entry/.test(exit) ? 'airside' : 'landside'
/** Assembly point for an exit door: the nearest one on the door's side (apron doors → apron). */
export function assemblyFor(exit: string): string {
  const n = nodes.get(exit)!
  const side = exitSide(exit)
  return ASSEMBLY.filter(a => a.side === side)
    .sort((a, b) => Math.hypot(a.centre[0]! - n.x, a.centre[1]! - n.y) - Math.hypot(b.centre[0]! - n.x, b.centre[1]! - n.y))[0]!.id
}

/**
 * Evacuation: the backend's `route()` in evacuation mode (target is an exit node, so emergency-only
 * crossings are open) to every exit door; the quickest wins. Then the assembly point for that door.
 * People in the public (landside) area leave by the landside doors, never through the apron.
 */
export function planEvacuations(ids: string[] = evacZones): Evacuation[] {
  const out: Evacuation[] = []
  for (const zone of ids) {
    const doors = areaOf(zone) === 'landside' ? EXITS.filter(e => exitSide(e) === 'landside') : EXITS
    const best = doors.map(e => route(terminalGraph, zone, e)).filter((r): r is Route => !!r).sort((a, b) => a.totalSec - b.totalSec)[0]
    if (!best) continue
    const exit = best.nodes[best.nodes.length - 1]!
    out.push({ zone, exit, assembly: assemblyFor(exit), walkSec: Math.round(best.totalSec), ...toPath(best) })
  }
  return out
}

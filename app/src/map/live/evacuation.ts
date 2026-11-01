import { mapNodeId, terminalGraph, points as terminalPoints, zones } from '../../../../backend/src/terminal'
import { route } from '../../../../backend/src/routing'
import type { PassengerData } from '../../me/types'
import { evacFor, floorChanges, landmarkFor, shortName, type Lang, type PathNode, type RouteIndex } from './catalogue'
import type { RouteDraw } from './LiveMap'

// /api/me uses the contract's zone names and exit names with a direction suffix.
function graphNames(id: string): string[] {
  const zone = zones.find(z => z.id === id)
  if (zone) return [zone.name_ro, zone.name_en]
  const point = terminalPoints.find(p => p.id === id)
  if (!point) return [id]
  const direction = /_(east|west|mid)$/.exec(id)?.[1]
  return point.name.split(' / ').map((name, i) => {
    const suffix = direction && (i === 1 ? { east: 'east', west: 'west', mid: 'central' } : { east: 'est', west: 'vest', mid: 'centrală' })[direction as 'east' | 'west' | 'mid']
    return suffix ? `${name} (${suffix})` : name
  })
}

/** Resolve /api/me's translated route names as well as catalogue and graph ids. */
function resolveNode(index: RouteIndex, value: string | undefined): string | undefined {
  if (!value) return undefined
  const landmark = landmarkFor(index.points, value) ?? index.points.find(p => Object.values(p.name).includes(value))
  if (landmark) return landmark.graphNode
  return terminalGraph.nodes.find(n => n.id === mapNodeId(value) || graphNames(n.id).includes(value))?.id
}

/** Recompute both legs on the shared terminal graph; a preview URL is only a fallback for metadata. */
export function evacuationDraw(index: RouteIndex, data: Pick<PassengerData, 'evacuation' | 'routeImage' | 'assembly'>, here: string | null, blocked: readonly string[], lang: Lang): RouteDraw | null {
  const preview = evacFor(index, data.routeImage) ?? evacFor(index, here ?? undefined)
  const from = resolveNode(index, here ?? undefined) ?? resolveNode(index, data.evacuation.route?.steps[0]) ?? preview?.steps[0]?.node
  const exit = data.evacuation.route?.exit ? resolveNode(index, data.evacuation.route.exit) : preview?.exit
  const assembly = resolveNode(index, data.assembly ?? preview?.assembly)
  if (!from || !exit || !assembly) return null
  const start = terminalGraph.nodes.find(n => n.id === from)
  // As in the backend evacuation planner, the occupied zone must permit escape.
  const closed = [...data.evacuation.zones, ...blocked].map(mapNodeId).filter(id => id !== from && id !== start?.zone)
  const toExit = route(terminalGraph, from, exit, {}, closed, { evacuation: true })
  const toAssembly = route(terminalGraph, exit, assembly, {}, closed, { evacuation: true })
  if (!toExit || !toAssembly) return null
  const nodes = new Map(terminalGraph.nodes.map(n => [n.id, n]))
  const at = (id: string): PathNode => {
    const n = nodes.get(id)!
    return { id, level: (n.level ?? 'G') as PathNode['level'], x: n.x, z: n.y }
  }
  const label = (id: string) => {
    const p = landmarkFor(index.points, id)
    return p ? shortName(p, lang) : graphNames(id)[lang === 'en' ? 1 : 0] ?? id
  }
  const path = [...toExit.nodes, ...toAssembly.nodes.slice(1)].map(at)
  return { path, changes: floorChanges(path, lang), exit: { ...at(exit), name: label(exit) }, assembly: { ...at(assembly), name: label(assembly) } }
}

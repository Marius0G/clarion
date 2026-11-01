import { route } from '../../../../backend/src/routing'
import { frames, terminalGraph } from '../../../../backend/src/terminal'
import { landmarkFor, type Landmark, type PathNode } from './catalogue'

const nodes = new Map(terminalGraph.nodes.map(n => [n.id, n]))
const floorHeight = frames.etaj1.floor_height_m! - frames.parter.floor_height_m!
const plate = (n: PathNode) => n.level === 'U' ? 1 : 0

/** Same graph and shortest-path search as the passenger PNG planner; keep the staff origin. */
export function dispatchPath(points: readonly Landmark[], destination: string, blocked: readonly string[] = []): PathNode[] {
  const target = landmarkFor(points, destination)?.graphNode ?? destination
  const r = route(terminalGraph, 'G_INFO', target, {}, blocked, { evacuation: false })
  return r ? r.nodes.map(id => {
    const n = nodes.get(id)!
    return { id, level: (n.level ?? 'G') as PathNode['level'], x: n.x, z: n.y }
  }) : []
}

/** Separate plates share no drawable segment, including at a vertical connector. */
export function floorRuns(path: readonly PathNode[]): PathNode[][] {
  const runs: PathNode[][] = []
  for (const n of path) {
    const run = runs.at(-1)
    if (run && plate(run[0]!) === plate(n)) run.push(n)
    else runs.push([n])
  }
  return runs.filter(run => run.length > 1)
}

/** Interpolate on corridors only. During a floor crossing hold at its entrance, then switch plates. */
export function remainingRoute(path: readonly PathNode[], t: number) {
  if (!path.length) return null
  const lengths = path.slice(1).map((b, i) => {
    const a = path[i]!
    return Math.hypot(b.x - a.x, b.z - a.z, plate(a) === plate(b) ? 0 : floorHeight)
  })
  let distance = Math.max(0, Math.min(1, t)) * lengths.reduce((a, b) => a + b, 0)
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!, a = path[i]!, b = path[i + 1]!
    if (distance < length) {
      const k = plate(a) === plate(b) ? distance / length : 0
      const at = { ...a, x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }
      return { at, next: plate(a) === plate(b) ? b : a, path: [at, ...path.slice(i + 1)] }
    }
    distance -= length
  }
  const at = path[path.length - 1]!
  return { at, next: at, path: [at] }
}

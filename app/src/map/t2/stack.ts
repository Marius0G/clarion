import type { MapPoint, Pt } from './data'

/**
 * Flat two-floor layout, pure math. Both floors share Marius's x,z frame (10 px per metre); the upper
 * plate is the same drawing moved up by `gap`, so x stays aligned and every connector is a straight line.
 */
/** Smallest plate offset allowed. */
export const MIN_GAP = 52

/** [x, y, width, height] */
export type Box = [number, number, number, number]

/** Upper plate (i = 1) sits `gap` above the ground plate (i = 0). */
export const plateOffset = (i: number, gap: number) => -i * gap
export const onPlate = (i: number, gap: number, [x, y]: Pt): Pt => [x, y + plateOffset(i, gap)]

export function boundsOf(pts: Iterable<Pt>): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  return [x0, y0, x1 - x0, y1 - y0]
}

export const pad = ([x, y, w, h]: Box, l: number, t = l, r = l, b = t): Box => [x - l, y - t, w + l + r, h + t + b]

/** Grow a box around its centre to the given aspect ratio (width / height), so it fills a 16:9 screen. */
export function fitAspect([x, y, w, h]: Box, ratio: number): Box {
  if (w / h < ratio) { const nw = h * ratio; return [x - (nw - w) / 2, y, nw, h] }
  const nh = w / ratio
  return [x, y - (nh - h) / 2, w, nh]
}

/**
 * Offset that stacks the upper plate fully above the ground plate: its lowest point sits `clear`
 * above the ground plate's highest point, so every zone reads as one floor or the other. Never below MIN_GAP.
 */
export function stackGap(lower: Box, upper: Box, clear: number): number {
  return Math.max(MIN_GAP, Math.ceil(upper[1] + upper[3] - lower[1] + clear))
}

/** y of the line between the plates, halfway through the clear space. */
export const dividerY = (lower: Box, upper: Box, gap: number) => (upper[1] + upper[3] - gap + lower[1]) / 2

export type ConnectorType = 'stairs' | 'escalator' | 'lift'
/**
 * `core`: the east core every departing passenger uses (stairs, escalator, lift).
 * `side`: the west stairs and lift. `apron`: gate stairs down to the apron, drawn as markers only.
 */
export type ConnectorRole = 'core' | 'side' | 'apron'
export interface Connector {
  /** Shared stem of the pair, e.g. `escalator_east` for `escalator_east_G` / `escalator_east_U`. */
  id: string
  type: ConnectorType
  role: ConnectorRole
  ground: MapPoint
  upper: MapPoint
  /** Escalator: G→U only. */
  oneWay: boolean
  /** Horizontal distance between the two ends, metres (0 when the ends share x,z). */
  offsetM: number
}
const VERTICAL = new Set<string>(['stairs', 'escalator', 'lift'])

export const connectorRole = (id: string): ConnectorRole => id.startsWith('gate_') ? 'apron' : /east/.test(id) ? 'core' : 'side'

/** Pairs `<stem>_G` with `<stem>_U` among stairs, escalators and lifts; unpaired ends are dropped. */
export function connectorPairs(points: MapPoint[]): Connector[] {
  const ends = new Map<string, { G?: MapPoint; U?: MapPoint }>()
  for (const p of points) {
    if (!VERTICAL.has(p.type) || (p.level !== 'G' && p.level !== 'U')) continue
    const stem = p.id.replace(/_[GU]$/, '')
    const e = ends.get(stem) ?? {}
    e[p.level] = p
    ends.set(stem, e)
  }
  const out: Connector[] = []
  for (const [id, { G, U }] of ends) {
    if (!G || !U || G.type !== U.type) continue
    out.push({ id, type: G.type as ConnectorType, role: connectorRole(id), ground: G, upper: U, oneWay: G.type === 'escalator' || !!G.one_way, offsetM: Math.hypot(G.x - U.x, G.z - U.z) })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

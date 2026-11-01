import type { Level, Pt } from './data'
import { boundsOf, pad, type Box } from './stack'

/** One picture: a route between two landmarks, or the way out from a zone during an evacuation. */
export interface RouteSpec {
  id: string
  kind: 'route' | 'evac'
  /** Romanian names, as the passenger reads them. */
  from: string
  to: string
  walkSec: number
  path: { id: string; level: Level; x: number; z: number; via?: 'escalator' | 'stairs' | 'lift' }[]
  /** Zones lit on the map: start and destination. */
  fromZone?: string | null
  toZone?: string | null
  /** Evacuation: the assembly point outside, drawn as a direction from the exit door. */
  assembly?: { name: string; x: number; z: number } | null
  /** Evacuation subtitle, a full sentence: "Ieșirea de urgență est, apoi punctul de adunare est". */
  caption?: string
}

/**
 * View box for a route: the projected path padded on every side, at least `minW` wide,
 * with the height between `minRatio` and `maxRatio` of the width, kept inside the map when it fits.
 */
export function routeBox(pts: Pt[], map: Box, opts: { padX?: number; padTop?: number; padBottom?: number; minW?: number; minRatio?: number; maxRatio?: number } = {}): Box {
  // More room on top: the start and end tags sit above their points.
  const { padX = 170, padTop = 260, padBottom = 110, minW = 1100, minRatio = 0.5, maxRatio = 1 } = opts
  let [x, y, w, h] = pad(boundsOf(pts), padX, padTop, padX, padBottom)
  if (w < minW) { x -= (minW - w) / 2; w = minW }
  if (h < w * minRatio) { y -= (w * minRatio - h) / 2; h = w * minRatio }
  if (h > w * maxRatio) { x -= (h / maxRatio - w) / 2; w = h / maxRatio }
  // Slide inside the map where possible, so the crop does not show empty space past the building.
  const fit = (v: number, len: number, lo: number, span: number) => len >= span ? lo + (span - len) / 2 : Math.min(Math.max(v, lo), lo + span - len)
  return [fit(x, w, map[0], map[2]), fit(y, h, map[1], map[3]), w, h]
}

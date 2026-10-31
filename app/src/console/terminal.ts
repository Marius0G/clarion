// Shared provisional plan; UI helpers remain here.
import type { ZoneKind } from '../../../backend/src/terminal'
// Keep the current rendering until TerminalMap is integrated. Routing uses realPlan.
export { plan } from './displayPlan'
export { plan as realPlan, zones, points, frames, worldToPx } from '../../../backend/src/terminal'
export const floorAssets = {
  G: new URL('../../../docs/contract/map/map_parter.svg', import.meta.url).href,
  U: new URL('../../../docs/contract/map/map_etaj1.svg', import.meta.url).href,
  X: new URL('../../../docs/contract/map/map_exterior.svg', import.meta.url).href,
}
export type { ZoneKind, TerminalZone, TerminalNode, TerminalEdge, TerminalPlan } from '../../../backend/src/terminal'

/** Zones where a person works a queue, so `+1 linie` makes sense (D12 staff, counted in lanes or desks). */
export const staffedKinds: ZoneKind[] = ['check_in', 'bag_drop', 'security']

/** Ray-casting point-in-polygon, metres. */
export function inside([x, y]: [number, number], polygon: [number, number][]) {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/**
 * PROVISIONAL terminal plan (D7), until Marius exports `docs/contract/terminal.json` from Unity.
 * Same shape as that file: metres, seen from above, origin top-left, x to the right, y down.
 * Zone and node ids are the ones used by flow.report, ops.command and agent.route,
 * so replacing `plan` with the real file must not change any other code.
 */
export type ZoneKind = 'entrance' | 'check_in' | 'bag_drop' | 'security' | 'airside' | 'gate' | 'exit'
export interface TerminalZone { id: string; kind: ZoneKind; name: string; polygon: [number, number][] }
export interface TerminalNode { id: string; kind: ZoneKind | 'team_post'; x: number; y: number; zone?: string }
export interface TerminalEdge { from: string; to: string; walkSec: number }
export interface TerminalPlan {
  version: string; provisional: boolean; units: 'm'; origin: string
  width: number; height: number
  zones: TerminalZone[]; nodes: TerminalNode[]; edges: TerminalEdge[]
}

const rect = (x: number, y: number, w: number, h: number): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]

export const plan: TerminalPlan = {
  version: 'provizoriu-2026-10-31',
  provisional: true,
  units: 'm',
  origin: 'colțul din stânga sus al terminalului',
  width: 120,
  height: 60,
  zones: [
    { id: 'entrance', kind: 'entrance', name: 'Intrare', polygon: rect(0, 8, 14, 44) },
    { id: 'check_in:1', kind: 'check_in', name: 'Check-in 1', polygon: rect(16, 6, 20, 22) },
    { id: 'bag_drop:1', kind: 'bag_drop', name: 'Bagaje 1', polygon: rect(38, 6, 14, 22) },
    { id: 'check_in:2', kind: 'check_in', name: 'Check-in 2', polygon: rect(16, 32, 20, 22) },
    { id: 'bag_drop:2', kind: 'bag_drop', name: 'Bagaje 2', polygon: rect(38, 32, 14, 22) },
    { id: 'security', kind: 'security', name: 'Securitate', polygon: rect(55, 14, 14, 32) },
    { id: 'airside', kind: 'airside', name: 'Zona plecări', polygon: rect(72, 4, 28, 52) },
    { id: 'gate_1', kind: 'gate', name: 'Poarta 1', polygon: rect(102, 4, 18, 16) },
    { id: 'gate_2', kind: 'gate', name: 'Poarta 2', polygon: rect(102, 22, 18, 16) },
    { id: 'gate_3', kind: 'gate', name: 'Poarta 3', polygon: rect(102, 40, 18, 16) },
    { id: 'exit_1', kind: 'exit', name: 'Ieșire 1', polygon: rect(0, 54, 12, 6) },
    { id: 'exit_2', kind: 'exit', name: 'Ieșire 2', polygon: rect(80, 57, 12, 3) },
  ],
  nodes: [
    { id: 'entrance', kind: 'entrance', x: 7, y: 30, zone: 'entrance' },
    { id: 'check_in:1', kind: 'check_in', x: 26, y: 17, zone: 'check_in:1' },
    { id: 'bag_drop:1', kind: 'bag_drop', x: 45, y: 17, zone: 'bag_drop:1' },
    { id: 'check_in:2', kind: 'check_in', x: 26, y: 43, zone: 'check_in:2' },
    { id: 'bag_drop:2', kind: 'bag_drop', x: 45, y: 43, zone: 'bag_drop:2' },
    { id: 'security', kind: 'security', x: 62, y: 30, zone: 'security' },
    { id: 'airside', kind: 'airside', x: 86, y: 30, zone: 'airside' },
    { id: 'gate_1', kind: 'gate', x: 111, y: 12, zone: 'gate_1' },
    { id: 'gate_2', kind: 'gate', x: 111, y: 30, zone: 'gate_2' },
    { id: 'gate_3', kind: 'gate', x: 111, y: 48, zone: 'gate_3' },
    { id: 'exit_1', kind: 'exit', x: 6, y: 57, zone: 'exit_1' },
    { id: 'exit_2', kind: 'exit', x: 86, y: 58, zone: 'exit_2' },
    { id: 'team_post', kind: 'team_post', x: 60, y: 52 },
  ],
  edges: [
    { from: 'entrance', to: 'check_in:1', walkSec: 25 },
    { from: 'entrance', to: 'check_in:2', walkSec: 25 },
    { from: 'check_in:1', to: 'bag_drop:1', walkSec: 15 },
    { from: 'check_in:2', to: 'bag_drop:2', walkSec: 15 },
    { from: 'bag_drop:1', to: 'security', walkSec: 20 },
    { from: 'bag_drop:2', to: 'security', walkSec: 20 },
    { from: 'entrance', to: 'security', walkSec: 45 },
    { from: 'security', to: 'airside', walkSec: 25 },
    { from: 'airside', to: 'gate_1', walkSec: 30 },
    { from: 'airside', to: 'gate_2', walkSec: 25 },
    { from: 'airside', to: 'gate_3', walkSec: 30 },
    { from: 'entrance', to: 'exit_1', walkSec: 20 },
    { from: 'airside', to: 'exit_2', walkSec: 30 },
    { from: 'team_post', to: 'security', walkSec: 20 },
    { from: 'team_post', to: 'entrance', walkSec: 50 },
  ],
}

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

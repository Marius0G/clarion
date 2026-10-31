import type { FlowRow, FlowZone, SimSnapshot } from '../backend/sim'

/** T2 queue zones reported by Unity (flow.report), in display order. */
export const flowZones: FlowZone[] = ['check_in', 'bag_drop', 'security', 'arrivals_hall', 'taxi_rank', 'kerb']
export const flowLabels: Record<FlowZone, string> = { check_in: 'Check-in', bag_drop: 'Bagaje', security: 'Securitate', arrivals_hall: 'Sosiri', taxi_rank: 'Taxi', kerb: 'Bordură' }
export type FlowState = 'normal' | 'near' | 'full'
export const flowStateLabels: Record<FlowState, string> = { normal: 'Normal', near: 'Aproape', full: 'Plin' }

/** Normal < 80 %, Aproape 80–100 %, Plin > 100 % of capacity. No capacity → no state. */
export function flowState(waiting: number, capacity: number | null): FlowState | null {
  if (capacity == null || capacity <= 0) return null
  const load = waiting / capacity
  return load > 1 ? 'full' : load >= 0.8 ? 'near' : 'normal'
}

/** Queue rows only while Unity is connected and has reported at least one zone. */
export function liveFlow(sim: SimSnapshot | null): Partial<Record<FlowZone, FlowRow>> | null {
  return sim?.connected && sim.flow && Object.keys(sim.flow).length > 0 ? sim.flow : null
}

/** Worst full zone (by waiting / capacity) and how many other zones are full. */
export function worstFull(flow: Partial<Record<FlowZone, FlowRow>>) {
  const full = flowZones.flatMap(zone => { const row = flow[zone]; return row && flowState(row.waiting, row.capacity) === 'full' ? [{ zone, row, load: row.waiting / row.capacity! }] : [] })
  if (!full.length) return null
  const worst = full.reduce((a, b) => b.load > a.load ? b : a)
  return { zone: worst.zone, row: worst.row, others: full.length - 1 }
}

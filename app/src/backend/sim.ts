import { useEffect, useState } from 'react'
import { backend } from './config'

type Where = 'home' | 'road' | 'terminal' | 'kerb'
export interface SimSnapshot {
  /** Unity (client=twin) online. */
  connected: boolean
  /** Camera service (client=vision) online; absent on older backends. */
  vision?: boolean
  lastSeen: string | null
  run: { scenario: string | null; arm: 'A' | 'B' | null; coverage: number | null; seed: number | null }
  simTime: number | null
  counts: Record<string, Partial<Record<Where, number>>>
  phones: { unknown: number; notified: number; read: number; acting: number }
  /** Unity flow.report queues; absent on older backends. Keys also include `check_in:<IATA>` / `bag_drop:<IATA>`. */
  flow?: Partial<Record<FlowZone, FlowRow>> & Record<string, FlowRow | undefined>
  /** Contract v2 (SPEC-v2): absent until the backend has them. */
  flights?: TerminalFlight[]
  positions?: { people: Person[]; at: string } | null
  ops?: OpsRecord[]
  /** D12: lanes / desks open per zone, held by the backend. */
  lanes?: Record<string, number>
  /** Zones closed or evacuated by the backend. */
  blocked?: string[]
  /** D0: Unity's truth, only for the accuracy panel. */
  truth?: { zones: Record<string, { waiting: number; waitMin: number | null }>; at: string } | null
}
export type FlowZone = 'check_in' | 'bag_drop' | 'security' | 'arrivals_hall' | 'taxi_rank' | 'kerb'
export interface FlowRow {
  waiting: number; capacity: number | null; waitMin: number | null; peak: number; updatedAt: string
  staff?: number | null; forecast?: { inMin: number; waitMin: number }[] | null
  /** Contract v2 (vision). */
  coverage?: number | null; waitingSd?: number | null; density?: number | null; waitMinP90?: number | null
  advice?: Advice | null
  /** No report for this zone lately: unknown, not the old number. */
  stale?: boolean; source?: 'vision' | 'twin'
}
/** A7 lane advice from vision: a sentence, or `{ lanes, by, waitMinIfNot }` (by = sim time). */
export type Advice = string | { lanes?: number | null; by?: number | string | null; waitMinIfNot?: number | null; waitMin?: number | null }
/** Feet point of a detected person, terminal metres. Vision sends no kind. */
export interface Person { x: number; y: number; kind?: 'pax' | 'staff' }
export interface TerminalFlight {
  flight: string; airline: string; destination: string; std: number | string; gate: string | null; checkInDesks: string[]
  gateCloseAt: number | string | null; status: 'scheduled' | 'boarding' | 'delayed' | 'cancelled' | 'departed'; delayMin: number; pax: number | null
}
export type OpsCommand =
  | { type: 'staff'; zone: string; delta: number }
  | { type: 'redirect'; from: string; to: string }
  | { type: 'evacuate'; zones: string[] }
  | { type: 'close' | 'open'; zone: string }
export type OpsRecord = OpsCommand & { id: string; status: 'sent' | 'acked'; sentAt: string; ackedAt: string | null }

/** Unity telemetry from GET /api/sim (public, in-memory on the backend). Null until the first answer. */
export function useSim(intervalMs = 2000): SimSnapshot | null {
  const [sim, setSim] = useState<SimSnapshot | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => fetch(`${backend.http}/api/sim`)
      .then(r => r.ok ? r.json() : null)
      .then(body => { if (alive) setSim(body) })
      .catch(() => { if (alive) setSim(null) })
    load()
    const timer = setInterval(load, intervalMs)
    return () => { alive = false; clearInterval(timer) }
  }, [intervalMs])
  return sim
}

/** Agents per location, summed over roles. */
export function simWhere(sim: SimSnapshot, key: Where) {
  return Object.values(sim.counts).reduce((sum, c) => sum + (c[key] ?? 0), 0)
}

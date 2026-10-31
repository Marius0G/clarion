import { useEffect, useState } from 'react'
import { backend } from './config'

type Where = 'home' | 'road' | 'terminal' | 'kerb'
export interface SimSnapshot {
  connected: boolean
  lastSeen: string | null
  run: { scenario: string | null; arm: 'A' | 'B' | null; coverage: number | null; seed: number | null }
  simTime: number | null
  counts: Record<string, Partial<Record<Where, number>>>
  phones: { unknown: number; notified: number; read: number; acting: number }
  /** Unity flow.report queues; absent on older backends. */
  flow?: Partial<Record<FlowZone, FlowRow>>
}
export type FlowZone = 'check_in' | 'bag_drop' | 'security' | 'arrivals_hall' | 'taxi_rank' | 'kerb'
export interface FlowRow { waiting: number; capacity: number | null; waitMin: number | null; peak: number; updatedAt: string }

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

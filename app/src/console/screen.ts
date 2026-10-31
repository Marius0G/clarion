import type { FlowRow, OpsCommand, SimSnapshot } from '../backend/sim'
import { liveRow, WAIT_TARGETS, type ZoneStat } from './opsZones'

export const waitTarget = (zone: ZoneStat) => zone.kind in WAIT_TARGETS ? WAIT_TARGETS[zone.kind as keyof typeof WAIT_TARGETS] : null
const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
export function breach(zone: ZoneStat, row: FlowRow | null): number {
  const target = waitTarget(zone)
  if (target == null) return zone.state === 'near' || zone.state === 'full' ? 0 : Infinity
  if (zone.waitMin != null && zone.waitMin > target) return 0
  return Math.min(Infinity, ...(row?.forecast ?? []).filter(p => valid(p.inMin) && p.inMin <= 60 && valid(p.waitMin) && p.waitMin > target).map(p => p.inMin))
}
export interface ZoneOrder { ids: string[]; at: number; observed: boolean }
/** Wall-clock hysteresis keeps the operator's pointing target still, independent of simulation speed. */
export function orderZones(zones: ZoneStat[], sim: SimSnapshot | null, now: number, previous?: ZoneOrder): ZoneOrder {
  const observed = !!sim?.vision
  if (previous && previous.observed === observed && now >= previous.at && now - previous.at < 75_000) {
    const existing = new Set(zones.map(z => z.id))
    return { at: previous.at, observed, ids: [...previous.ids.filter(id => existing.has(id)), ...zones.filter(z => !previous.ids.includes(z.id)).map(z => z.id)] }
  }
  return { at: now, observed, ids: [...zones].sort((a, b) => breach(a, liveRow(sim, a.id)) - breach(b, liveRow(sim, b.id)) || (b.waitMin ?? b.people ?? -1) - (a.waitMin ?? a.people ?? -1) || a.id.localeCompare(b.id)).map(z => z.id) }
}
/** A shared scale contains all marks, with explicit 30/60 samples only; no invented extrapolation. */
export function bulletScale(wait: number | null, target: number, row: FlowRow | null) {
  const sample = (at: number) => row?.forecast?.find(p => p.inMin === at && valid(p.waitMin))?.waitMin ?? null
  const next30 = sample(30), next60 = sample(60)
  const max = Math.max(target * 2, valid(wait) ? wait : 0, next30 ?? 0, next60 ?? 0)
  const pct = (n: number | null) => n == null || !valid(n) ? null : Math.min(100, n / max * 100)
  return { max, wait: pct(wait), target: pct(target)!, next30: pct(next30), next60: pct(next60) }
}
export function topMetrics(zones: ZoneStat[], sim: SimSnapshot | null) {
  const waits = zones.flatMap(z => valid(z.waitMin) ? [z.waitMin] : [])
  const first = Math.min(Infinity, ...zones.filter(z => waitTarget(z) != null).map(z => breach(z, liveRow(sim, z.id))))
  const densities = zones.flatMap(z => { const d = liveRow(sim, z.id)?.density; return valid(d) ? [d] : [] })
  // Current contract has neither day history nor per-flight pre-security camera counts.
  return { worst: waits.length ? Math.max(...waits) : null, first: Number.isFinite(first) && sim?.simTime != null ? sim.simTime + first * 60 : null, underTarget: null, flightsAtRisk: null, density: densities.length ? Math.max(...densities) : null }
}
export const executor = (command: OpsCommand) => command.type === 'staff' ? 'Supervizor securitate' : command.type === 'redirect' ? 'Agent pe hol · ecrane · mesaj zboruri' : 'Incident commander'
export interface TaskEvidence { before: FlowRow; simTime: number | null }
export function taskState(command: OpsCommand, status: string, sim: SimSnapshot | null, evidence?: TaskEvidence, previous?: string): string {
  if (previous === 'done') return 'done'
  if (status !== 'acked') return status
  if (!evidence) return 'acked'
  const ids = command.type === 'evacuate' ? command.zones : [command.type === 'redirect' ? command.from : command.zone]
  const rows = ids.map(id => liveRow(sim, id))
  if (!rows.every(r => r && Date.parse(r.updatedAt) > Date.parse(evidence.before.updatedAt))) return 'acked'
  // Configuration/ack alone is never evidence. Only a later camera observation can complete a task.
  if (command.type === 'evacuate' && rows.every(r => r!.waiting === 0)) return 'done'
  if (command.type === 'staff' && valid(evidence.before.staff) && rows[0]?.staff === evidence.before.staff + command.delta) return 'done'
  if (command.type === 'staff' && command.delta > 0 && rows[0]?.waitMin != null && evidence.before.waitMin != null && rows[0].waitMin < evidence.before.waitMin) return 'done'
  if (command.type === 'redirect' && rows[0]!.waiting < evidence.before.waiting) return 'done'
  return 'acked'
}
export function noActionWait(evidence: TaskEvidence | undefined, simTime: number | null | undefined): number | null {
  if (evidence?.simTime == null || simTime == null) return null
  const elapsed = (simTime - evidence.simTime) / 60
  const points = [{ inMin: 0, waitMin: evidence.before.waitMin }, ...(evidence.before.forecast ?? [])].filter((p): p is { inMin: number; waitMin: number } => valid(p.inMin) && valid(p.waitMin)).sort((a, b) => a.inMin - b.inMin)
  const exact = points.find(p => p.inMin === elapsed)
  if (exact) return exact.waitMin
  const right = points.findIndex(p => p.inMin > elapsed)
  if (right <= 0) return null
  const a = points[right - 1], b = points[right]
  return a.waitMin + (b.waitMin - a.waitMin) * (elapsed - a.inMin) / (b.inMin - a.inMin)
}
export function flightTime(value: string | number | null): string {
  if (typeof value === 'string') return /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : '—'
  if (value == null || !Number.isFinite(value)) return '—'
  return [Math.floor(value / 3600) % 24, Math.floor(value / 60) % 60].map(n => String(n).padStart(2, '0')).join(':')
}

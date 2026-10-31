import type { Advice, FlowRow, OpsCommand, Person, SimSnapshot } from '../backend/sim'
import { flowState, type FlowState } from './flow'
import { staffedKinds, type TerminalPlan, type ZoneKind } from './terminal'

export interface ZoneStat {
  id: string; name: string; kind: ZoneKind; staffed: boolean; closed: boolean
  /** Camera estimate (flow.report `waiting`); null = unknown: never seen, stale, or no feed. Never guessed from dots. */
  people: number | null
  /** Lanes / desks open, held by the backend (D12); null when it has no number for the zone. */
  lanes: number | null
  waitMin: number | null; state: FlowState | null
  /** A7 lane advice, formatted; null when vision gave none. */
  advice: string | null
}

/** Load colour from the camera wait: under 10 min Normal, 10–20 Aproape, 20+ Plin. Legacy Unity rows fall back to capacity. */
export const WAIT_NEAR_MIN = 10, WAIT_FULL_MIN = 20
export function loadState(row: Pick<FlowRow, 'waiting' | 'waitMin' | 'capacity'>): FlowState | null {
  if (row.waitMin != null) return row.waitMin >= WAIT_FULL_MIN ? 'full' : row.waitMin >= WAIT_NEAR_MIN ? 'near' : 'normal'
  return flowState(row.waiting, row.capacity ?? null)
}

/** Camera data counts only while a feed (vision, or a legacy Unity) is online, and only fresh rows. */
export function liveRow(sim: SimSnapshot | null, zone: string): FlowRow | null {
  if (!sim || !(sim.vision || sim.connected)) return null
  const row = sim.flow?.[zone]
  return row && !row.stale ? row : null
}

/** Dots from the cameras (crowd.positions) while a feed is online. */
export function liveDots(sim: SimSnapshot | null): Person[] {
  return sim && (sim.vision || sim.connected) ? sim.positions?.people ?? [] : []
}

export function zoneStats(plan: TerminalPlan, sim: SimSnapshot | null): ZoneStat[] {
  return plan.zones.map(zone => {
    const row = liveRow(sim, zone.id)
    return {
      id: zone.id, name: zone.name, kind: zone.kind, closed: sim?.blocked?.includes(zone.id) ?? false, staffed: staffedKinds.includes(zone.kind),
      people: row ? row.waiting : null, lanes: sim?.lanes?.[zone.id] ?? null,
      waitMin: row?.waitMin ?? null, state: row ? loadState(row) : null,
      advice: row?.advice == null ? null : adviceText(row.advice, sim?.lanes?.[zone.id] ?? null),
    }
  })
}

/** Sim time as HH:MM: seconds become a clock, a string is shown as sent. */
const hhmm = (by: number | string) => typeof by === 'number' ? simClock(by).slice(0, 5) : by
const lanesWord = (n: number) => n === 1 ? 'o linie' : `${n} linii`

/**
 * A7 advice as one line. A sentence from vision is shown as given; `{ lanes, by, waitMinIfNot }` becomes
 * „Deschide o linie până la 14:05, altfel 18 min”, with missing parts left out.
 */
export function adviceText(advice: Advice, lanesNow: number | null): string | null {
  if (typeof advice === 'string') return advice.trim() || null
  if (!advice || typeof advice !== 'object') return null
  const target = Number.isFinite(advice.lanes) ? advice.lanes! : null
  const wait = [advice.waitMinIfNot, advice.waitMin].find(v => typeof v === 'number' && Number.isFinite(v)) ?? null
  const by = typeof advice.by === 'number' && Number.isFinite(advice.by) || (typeof advice.by === 'string' && advice.by) ? advice.by! : null
  const extra = target != null && lanesNow != null ? target - lanesNow : null
  const head = extra != null && extra > 0 ? `Deschide ${lanesWord(extra)}` : target != null ? `${target} ${target === 1 ? 'linie' : 'linii'}` : 'Deschide o linie'
  const parts = [`${head}${by != null ? ` până la ${hhmm(by)}` : ''}`, wait != null ? `altfel ${Math.round(wait)} min` : null]
  return parts.filter(Boolean).join(', ')
}

export type CommandStatus = 'sent' | 'acked' | 'offline' | 'auth' | 'invalid' | 'network'
export const commandStatusLabels: Record<CommandStatus, string> = {
  sent: 'Trimis', acked: 'Confirmat', offline: 'Unity offline', auth: 'Fără token', invalid: 'Respins', network: 'Fără conexiune',
}

/** Short noun label for a D12 command, with zone names from the plan. */
export function commandLabel(command: OpsCommand, plan: TerminalPlan) {
  const name = (id: string) => plan.zones.find(z => z.id === id)?.name ?? id
  switch (command.type) {
    case 'staff': return `${name(command.zone)} ${command.delta > 0 ? '+' : '−'}${Math.abs(command.delta)} ${Math.abs(command.delta) === 1 ? 'linie' : 'linii'}`
    case 'evacuate': return `Evacuare ${command.zones.map(name).join(', ')}`
    case 'redirect': return `Redirecționare ${name(command.from)} → ${name(command.to)}`
    case 'close': return `Închidere ${name(command.zone)}`
    case 'open': return `Deschidere ${name(command.zone)}`
  }
}

/** Camera estimate next to Unity's truth (D0, D16), for zones the truth covers. */
export interface AccuracyRow { id: string; name: string; camPeople: number | null; truePeople: number; camWait: number | null; trueWait: number | null }
export function accuracyRows(plan: TerminalPlan, sim: SimSnapshot | null): AccuracyRow[] {
  const truth = sim?.truth?.zones
  if (!truth) return []
  const order = new Map(plan.zones.map((z, i) => [z.id, i]))
  return Object.entries(truth)
    .sort(([a], [b]) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b))
    .map(([id, t]) => {
      const row = liveRow(sim, id)
      return { id, name: plan.zones.find(z => z.id === id)?.name ?? id, camPeople: row?.waiting ?? null, truePeople: t.waiting, camWait: row?.waitMin ?? null, trueWait: t.waitMin }
    })
}

/** D13: Unity simTime (seconds) as a clock, HH:MM:SS. */
export function simClock(simTime: number | null | undefined) {
  if (simTime == null || !Number.isFinite(simTime)) return '—'
  const s = Math.floor(simTime) % 86400
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':')
}

/** Only other open zones of the same kind can receive redirected passengers. */
export function redirectTargets(zones: ZoneStat[], source: ZoneStat): ZoneStat[] {
  return zones.filter(z => z.id !== source.id && z.kind === source.kind && !z.closed)
}

export function commandTouchesZone(command: OpsCommand, id: string): boolean {
  if (command.type === 'redirect') return command.from === id || command.to === id
  if (command.type === 'evacuate') return command.zones.includes(id)
  return command.zone === id
}

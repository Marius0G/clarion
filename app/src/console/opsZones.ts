import type { FlowRow, OpsCommand, Person, SimSnapshot } from '../backend/sim'
import type { FlowState } from './flow'
import { staffedKinds, type TerminalPlan, type ZoneKind } from './terminal'

export interface ZoneStat {
  id: string; name: string; kind: ZoneKind; staffed: boolean; closed: boolean
  /** Camera estimate (flow.report `waiting`); null = unknown: never seen, stale, or no feed. Never guessed from dots. */
  people: number | null
  /** Lanes / desks open, held by the backend (D12); null when it has no number for the zone. */
  lanes: number | null
  waitMin: number | null; state: FlowState | null
  line: ZoneLine
}

/** D20 / A7 queue wait targets, in minutes. */
export const WAIT_TARGETS = { security: 10, check_in: 15, bag_drop: 15 } as const
export const zoneStateLabels = { normal: 'Normal', near: 'Ocupat', full: 'Plin' } as const
const targetFor = (id: string): number | null => {
  const kind = id.split(':')[0]
  return Object.hasOwn(WAIT_TARGETS, kind) ? WAIT_TARGETS[kind as keyof typeof WAIT_TARGETS] : null
}
const measured = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n >= 0
const observed = (row: FlowRow | null): row is FlowRow => row != null && !row.stale && row.coverage !== 0
const nextHour = (row: FlowRow) => (row.forecast ?? []).filter(p => measured(p.inMin) && p.inMin <= 60 && measured(p.waitMin))

/** D20: no capacity fallback; forecast alone can make a queue busy, never full. */
export function loadState(id: string, row: FlowRow | null): FlowState | null {
  if (!observed(row)) return null
  const target = targetFor(id)
  if (target != null) {
    if (!measured(row.waitMin)) return null
    if (row.waitMin >= 2 * target) return 'full'
    return row.waitMin > target || nextHour(row).some(p => p.waitMin > target) ? 'near' : 'normal'
  }
  if (!measured(row.density)) return null
  return row.density > 2 ? 'full' : row.density >= 1 ? 'near' : 'normal'
}

export interface ZoneLine { numbers: string; action: { label: string; delta: number } | null }

/** One numeric line plus the exact staff delta its action sends. All clocks use simulation time. */
export function zoneLine(id: string, row: FlowRow | null, lanes: number | null, simTime: number | null): ZoneLine {
  const state = loadState(id, row)
  if (state == null || !row) return { numbers: 'Necunoscut', action: null }
  const target = targetFor(id)
  if (target == null) return { numbers: `${row.density} oameni/m²`, action: null }
  const wait = row.waitMin!
  const peak = nextHour(row).filter(p => p.waitMin > target).sort((a, b) => b.waitMin - a.waitMin || a.inMin - b.inMin)[0]
  const forecastOnly = wait <= target && peak != null
  const at = forecastOnly && measured(simTime) ? simClock(simTime + peak.inMin * 60).slice(0, 5) : null
  const numbers = forecastOnly
    ? `${Math.round(wait)} min → ${Math.round(peak.waitMin)} min ${at ? `la ${at}` : `în ${peak.inMin} min`}`
    : `${Math.round(wait)} min · țintă ${target}`
  if (state === 'normal') return { numbers, action: null }
  const advice = typeof row.advice === 'object' ? row.advice : null
  const fallback = Math.max(1, Math.ceil((lanes ?? 0) * (forecastOnly ? peak.waitMin : wait) / target) - (lanes ?? 0))
  // A7 lanes is the total required, whereas D12 staff.delta is the extra lanes.
  const delta = measured(advice?.lanes) && measured(lanes) ? Math.max(1, Math.ceil(advice.lanes - lanes)) : fallback
  const by = advice?.by
  const deadline = typeof by === 'number' && measured(by) ? simClock(by).slice(0, 5)
    : typeof by === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(by) ? by.slice(0, 5) : null
  return { numbers, action: { label: `Deschide ${delta} ${delta === 1 ? 'linie' : 'linii'}${deadline ? ` până la ${deadline}` : ''}`, delta } }
}

/** D0: only fresh camera data while vision is online; Unity connectivity is independent. */
export function liveRow(sim: SimSnapshot | null, zone: string): FlowRow | null {
  if (!sim || !sim.vision) return null
  const row = sim.flow?.[zone] ?? null
  return observed(row) ? row : null
}

/** Dots from the cameras (crowd.positions) while a feed is online. */
export function liveDots(sim: SimSnapshot | null): Person[] {
  return sim && sim.vision ? sim.positions?.people ?? [] : []
}

export function zoneStats(plan: TerminalPlan, sim: SimSnapshot | null): ZoneStat[] {
  return plan.zones.map(zone => {
    const row = liveRow(sim, zone.id)
    return {
      id: zone.id, name: zone.name, kind: zone.kind, closed: sim?.blocked?.includes(zone.id) ?? false, staffed: staffedKinds.includes(zone.kind),
      people: row ? row.waiting : null, lanes: sim?.lanes?.[zone.id] ?? null,
      waitMin: row?.waitMin ?? null, state: loadState(zone.id, row),
      line: zoneLine(zone.id, row, sim?.lanes?.[zone.id] ?? null, sim?.simTime ?? null),
    }
  })
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

import type { FlowRow, OpsCommand, Person, SimSnapshot } from '../backend/sim'
import { flowState, type FlowState } from './flow'
import { inside, staffedKinds, type TerminalPlan, type ZoneKind } from './terminal'

export interface ZoneStat {
  id: string; name: string; kind: ZoneKind; staffed: boolean
  /** flow.report `waiting`, else passenger dots inside the zone; null = unknown. */
  people: number | null
  /** flow.report `staff`, else staff dots inside the zone; null = unknown. */
  staff: number | null
  waitMin: number | null; capacity: number | null; state: FlowState | null
}

/** Live Unity data only: a disconnected sim shows the plan with no numbers. */
export function zoneStats(plan: TerminalPlan, sim: SimSnapshot | null): ZoneStat[] {
  const live = sim?.connected ? sim : null
  const people: Person[] | null = live?.positions?.people ?? null
  return plan.zones.map(zone => {
    const row: FlowRow | undefined = live?.flow?.[zone.id]
    const dots = people && people.filter(p => inside([p.x, p.y], zone.polygon))
    const count = (kind: Person['kind']) => dots ? dots.filter(p => p.kind === kind).length : null
    const waiting = row ? row.waiting : count('pax')
    const capacity = row?.capacity ?? null
    return {
      id: zone.id, name: zone.name, kind: zone.kind, staffed: staffedKinds.includes(zone.kind),
      people: waiting, staff: row?.staff ?? count('staff'), waitMin: row?.waitMin ?? null, capacity,
      state: waiting == null ? null : flowState(waiting, capacity),
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
    case 'staff': return `${name(command.zone)} ${command.delta > 0 ? '+' : '−'}${Math.abs(command.delta)} angajat`
    case 'evacuate': return `Evacuare ${command.zones.map(name).join(', ')}`
    case 'redirect': return `Redirecționare ${name(command.from)} → ${name(command.to)}`
    case 'close': return `Închidere ${name(command.zone)}`
    case 'open': return `Deschidere ${name(command.zone)}`
  }
}

/** D13: Unity simTime (seconds) as a clock, HH:MM:SS. */
export function simClock(simTime: number | null | undefined) {
  if (simTime == null || !Number.isFinite(simTime)) return '—'
  const s = Math.floor(simTime) % 86400
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':')
}

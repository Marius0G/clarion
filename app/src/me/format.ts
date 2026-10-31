import type { PassengerData } from './types'

export function simTimeLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 'necunoscut'
  const minutes = Math.floor(seconds / 60) % (24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export function statusLabel(status?: PassengerData['flight']['status'], delayMin?: number): string {
  switch (status) {
    case 'scheduled': return 'Programat'
    case 'boarding': return 'Îmbarcare'
    case 'delayed': return typeof delayMin === 'number' && Number.isFinite(delayMin) && delayMin >= 0
      ? `Întârziat +${Math.round(delayMin)} min` : 'Întârziat'
    case 'cancelled': return 'Anulat'
    case 'departed': return 'Plecat'
    default: return 'necunoscut'
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' && value.trim() ? value : 'necunoscut'
const nonnegative = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

// Treat absent fields as unknown; never fill gaps in live data with invented demo values.
export type PassengerViewData = Omit<PassengerData, 'flight'> & {
  flight: Omit<PassengerData['flight'], 'status' | 'delayMin'> & {
    status?: PassengerData['flight']['status']; delayMin?: number
  }
}

export function normalizePassenger(value: unknown): PassengerViewData {
  const data = record(value)
  const flight = record(data.flight)
  const evacuation = record(data.evacuation)
  const statuses = ['scheduled', 'boarding', 'delayed', 'cancelled', 'departed']
  const kinds = ['arrive', 'flight', 'route', 'evacuate', 'admin']
  return {
    simTime: nonnegative(data.simTime),
    arriveBy: text(data.arriveBy),
    entranceToGateMin: nonnegative(data.entranceToGateMin),
    queues: (Array.isArray(data.queues) ? data.queues : []).map(value => {
      const queue = record(value)
      return { zone: text(queue.zone), label: text(queue.label), nowMin: nonnegative(queue.nowMin),
        forecastMin: nonnegative(queue.forecastMin), forecastAt: text(queue.forecastAt), source: text(queue.source) }
    }),
    flight: {
      flight: text(flight.flight), destination: text(flight.destination), std: text(flight.std),
      gate: text(flight.gate), gateCloseAt: text(flight.gateCloseAt),
      status: (statuses.includes(String(flight.status)) ? flight.status : undefined) as PassengerData['flight']['status'] | undefined,
      delayMin: nonnegative(flight.delayMin) ?? undefined,
    },
    steps: (Array.isArray(data.steps) ? data.steps : []).map(value => {
      const step = record(value)
      return { zone: text(step.zone), label: text(step.label), waitMin: nonnegative(step.waitMin) }
    }),
    alerts: (Array.isArray(data.alerts) ? data.alerts : []).map(value => {
      const alert = record(value)
      return { at: text(alert.at), text: text(alert.text), kind: (kinds.includes(String(alert.kind)) ? alert.kind : 'admin') as PassengerData['alerts'][number]['kind'] }
    }),
    evacuation: {
      active: evacuation.active === true,
      zones: Array.isArray(evacuation.zones) ? evacuation.zones.filter((zone): zone is string => typeof zone === 'string') : [],
    },
  }
}

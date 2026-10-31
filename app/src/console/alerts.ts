import type { ZoneView } from '../map/t2/TerminalMap'
import type { Alert, AlertCommand } from '../../../backend/src/alerts'
import { mapNodeId } from '../../../backend/src/mapIds'
import { backend } from '../backend/config'
export type { Alert, AlertCommand }

export const alertSymbols = { P1: '■', P2: '▲', P3: '●' } as const
export const alertStateLabels = { unacked: 'Neconfirmată', acked: 'Confirmată', 'cleared-unacked': 'Revenită · Neconfirmată', shelved: 'Amânată' } as const

/** Presentation follows the server lifecycle; the browser never expires a shelf itself. */
export function alertPresentation(alert: Alert, simTime: number | null) {
  const needsAck = alert.state === 'unacked' || alert.state === 'cleared-unacked'
  return {
    needsAck,
    blink: needsAck && alert.priority !== 'P3',
    visible: alert.active || alert.state !== 'acked',
    label: alertStateLabels[alert.state],
    remainingSec: alert.state === 'shelved' && alert.shelvedUntil !== null && simTime !== null ? Math.max(0, Math.ceil(alert.shelvedUntil - simTime)) : null,
  }
}

/** D32 priority for the map badge, using the map-owned type. */
export type ZoneAlertView = NonNullable<ZoneView['alert']>
export function toZoneAlert(alert: Alert): ZoneAlertView {
  return ({ P1: 1, P2: 2, P3: 3 } as const)[alert.priority]
}
export function alertMapZone(id: string): string {
  if (id.startsWith('bag_drop:')) return 'G_CHECKIN_DESKS'
  if (id.startsWith('check_in:')) return 'G_CHECKIN_QUEUE'
  return mapNodeId(id)
}
export function topZoneAlerts(alerts: readonly Alert[]): Record<string, ZoneAlertView> {
  const result: Record<string, ZoneAlertView> = {}
  const ordered = alerts.filter(a => a.zoneId && alertPresentation(a, null).visible)
    .slice().sort((a, b) => a.priority.localeCompare(b.priority) || Number(b.state === 'unacked' || b.state === 'cleared-unacked') - Number(a.state === 'unacked' || a.state === 'cleared-unacked') || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  for (const a of ordered) {
    const zone = alertMapZone(a.zoneId!)
    result[zone] ??= toZoneAlert(a)
  }
  return result
}

/** Server numbers carry their own meanings; no derived passenger positions. */
export function alertNumbers(a: Alert): string {
  const n = a.numbers
  const value = (key: string) => Number.isFinite(n[key]) ? new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 1 }).format(n[key]!) : '—'
  switch (a.kind) {
    case 'zone-target': return `${value('waitMin')} min · țintă ${value('targetMin')} min`
    case 'forecast-target': return `+${value('inMin')} min: ${value('waitMin')} min · țintă ${value('targetMin')} min`
    case 'density': return `${value('density')} /m² · prag ${value('threshold')} /m²`
    case 'staff-security': case 'staff-report': return `${value('reports')} rapoarte`
    case 'flight-risk': return `Închidere în ${value('minutesToClose')} min · cozi ${value('waitMin')} min`
    case 'camera-loss': return 'Cameră pierdută'
  }
}

export async function sendAlertCommand(command: AlertCommand): Promise<Alert[]> {
  const response = await fetch(`${backend.http}/api/alerts/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(backend.token ? { Authorization: `Bearer ${backend.token}` } : {}) },
    body: JSON.stringify(command),
  })
  if (!response.ok) throw new Error(response.status === 401 ? 'Acces refuzat' : 'Comandă nereușită')
  return (await response.json() as { alerts: Alert[] }).alerts
}

/**
 * "Dispecerat" notices for a staff member: the admin's decisions (ops log in /api/sim) that touch his zone,
 * written as information, never as an order to him (D30, D34).
 */
import { laneKey, mapNodeId } from '../../../../backend/src/mapIds'
import type { Lang } from './catalogue'

export type OpsRecord =
  | { id: string; type: 'staff'; zone: string; delta: number; sentAt: string; status?: string }
  | { id: string; type: 'redirect'; from: string; to: string; sentAt: string; status?: string }
  | { id: string; type: 'evacuate'; zones: string[]; sentAt: string; status?: string }
  | { id: string; type: 'close' | 'open'; zone: string; sentAt: string; status?: string }

const same = (a: string, b: string) => mapNodeId(a) === mapNodeId(b) || laneKey(a) === laneKey(b)
export function touches(op: OpsRecord, zone: string): boolean {
  switch (op.type) {
    case 'staff': case 'close': case 'open': return same(op.zone, zone)
    case 'redirect': return same(op.from, zone) || same(op.to, zone)
    case 'evacuate': return op.zones.some(z => same(z, zone))
    default: return false
  }
}
const clock = (iso: string) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '' }

export function noticeText(op: OpsRecord, name: (id: string) => string, lang: Lang): string {
  const en = lang === 'en'
  const lines = (n: number) => en ? `${n} ${n === 1 ? 'lane' : 'lanes'}` : n === 1 ? 'o linie' : `${n} linii`
  switch (op.type) {
    case 'staff': return op.delta > 0
      ? en ? `Dispatch opened ${lines(op.delta)} more at ${name(op.zone)}` : `Dispeceratul a deschis ${lines(op.delta)} în plus la ${name(op.zone)}`
      : en ? `Dispatch closed ${lines(-op.delta)} at ${name(op.zone)}` : `Dispeceratul a închis ${lines(-op.delta)} la ${name(op.zone)}`
    case 'redirect': return en ? `Dispatch is sending passengers from ${name(op.from)} to ${name(op.to)}` : `Dispeceratul trimite pasagerii de la ${name(op.from)} la ${name(op.to)}`
    case 'evacuate': return en ? `Dispatch started an evacuation: ${op.zones.map(name).join(', ')}` : `Dispeceratul a pornit evacuarea: ${op.zones.map(name).join(', ')}`
    case 'close': return en ? `Dispatch closed ${name(op.zone)}` : `Dispeceratul a închis ${name(op.zone)}`
    case 'open': return en ? `Dispatch reopened ${name(op.zone)}` : `Dispeceratul a redeschis ${name(op.zone)}`
  }
}

/** Newest first, at most `limit`. */
export function notices(ops: readonly OpsRecord[], zone: string, name: (id: string) => string, lang: Lang, limit = 5) {
  return [...ops].filter(o => o && typeof o.sentAt === 'string' && touches(o, zone))
    .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt)).slice(0, limit)
    .map(o => ({ id: o.id, text: noticeText(o, name, lang), at: clock(o.sentAt) }))
}

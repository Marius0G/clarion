/**
 * Live crowding from the cameras (flow.report via /api/sim), pure functions.
 * D0: only camera rows count; a zone no camera reports is unknown, never invented.
 * D20: queues against the wait target, other zones by people per m².
 */
import { flowRow, logicalKind } from '../../../../backend/src/mapIds'
import type { Lang } from './catalogue'

export interface FlowRow {
  waiting: number; waitMin: number | null; density?: number | null; coverage?: number | null
  forecast?: { inMin: number; waitMin: number }[] | null; updatedAt: string; stale?: boolean; source?: 'vision' | 'twin'
}
export type Flow = Record<string, FlowRow>
export type Level = 'free' | 'busy' | 'very' | 'unknown'

/** Older than this, a reading is "Fără date" (hatched), not the last number. */
export const STALE_MS = 120_000

export const ageMs = (row: Pick<FlowRow, 'updatedAt'>, now: number) => Math.max(0, now - Date.parse(row.updatedAt))
export const isStale = (row: Pick<FlowRow, 'updatedAt'>, now: number) => !Number.isFinite(Date.parse(row.updatedAt)) || ageMs(row, now) > STALE_MS

/** D20 wait target in minutes for queues; null for zones measured by density. */
export function waitTarget(id: string): number | null {
  const kind = logicalKind(id)
  return kind === 'security' ? 10 : kind === 'check_in' || kind === 'bag_drop' ? 15 : null
}
export const isQueue = (id: string) => waitTarget(id) !== null

/** Camera row for a map id (exact, alias or physical anchor), or undefined. */
export function rowFor(flow: Flow, id: string): FlowRow | undefined {
  const row = flowRow(flow, id)
  return row && row.source !== 'twin' && row.coverage !== 0 ? row : undefined
}

/** D20 level. `areaM2` turns a head count into density when the camera did not send one. */
export function crowdLevel(row: FlowRow | undefined, id: string, now: number, areaM2?: number): Level {
  if (!row || isStale(row, now)) return 'unknown'
  const target = waitTarget(id)
  if (target !== null) {
    if (row.waitMin == null) return 'unknown'
    if (row.waitMin >= 2 * target) return 'very'
    if (row.waitMin > target || (row.forecast ?? []).some(p => p.inMin > 0 && p.inMin <= 60 && p.waitMin > target)) return 'busy'
    return 'free'
  }
  const density = row.density ?? (areaM2 && areaM2 > 0 ? row.waiting / areaM2 : null)
  if (density == null) return 'unknown'
  return density > 2 ? 'very' : density >= 1 ? 'busy' : 'free'
}

const WORDS: Record<Level, [string, string]> = {
  free: ['Liber', 'Not busy'], busy: ['Aglomerat', 'Busy'], very: ['Foarte aglomerat', 'Very busy'], unknown: ['Fără date', 'No data'],
}
/** Passenger words (Google / TfL style). */
export const crowdWords = (level: Level, lang: Lang) => WORDS[level][lang === 'en' ? 1 : 0]
/** Filled person icons out of three. */
export const people = (level: Level) => level === 'free' ? 1 : level === 'busy' ? 2 : level === 'very' ? 3 : 0
/** Staff words, D20 names. */
export const stateWords = (level: Level, lang: Lang) => ({ free: ['Normal', 'Normal'], busy: ['Ocupat', 'Busy'], very: ['Plin', 'Full'], unknown: ['Necunoscut', 'Unknown'] } as const)[level][lang === 'en' ? 1 : 0]

/** Hamburg-style band for queue minutes (D33). */
export function waitBand(min: number | null | undefined): string | null {
  if (min == null || !Number.isFinite(min)) return null
  const m = Math.ceil(min)
  return m <= 3 ? '0–3 min' : m <= 10 ? '4–10 min' : m <= 20 ? '11–20 min' : m <= 30 ? '21–30 min' : '>30 min'
}

/** Direction of the head count over the recent samples (oldest first): ±10 % and at least 3 people. */
export function trend(samples: readonly number[]): 'up' | 'down' | 'flat' {
  if (samples.length < 2) return 'flat'
  const a = samples[0]!, b = samples[samples.length - 1]!
  const d = b - a
  if (Math.abs(d) < Math.max(3, a * 0.1)) return 'flat'
  return d > 0 ? 'up' : 'down'
}
export const TREND_MARK = { up: '↑', down: '↓', flat: '→' } as const

export function ageLabel(ms: number, lang: Lang): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : lang === 'en' ? `${Math.round(m / 60)} h` : `${Math.round(m / 60)} h`
}

/** Rolling head-count history per zone, for the staff trend. Keeps `keepMs` of samples. */
export function pushHistory(history: Map<string, { t: number; n: number }[]>, flow: Flow, now: number, keepMs = 90_000) {
  for (const [id, row] of Object.entries(flow)) {
    const list = (history.get(id) ?? []).filter(s => now - s.t <= keepMs)
    const t = Date.parse(row.updatedAt)
    if (Number.isFinite(t) && list[list.length - 1]?.t !== t) list.push({ t, n: row.waiting })
    history.set(id, list)
  }
  return history
}

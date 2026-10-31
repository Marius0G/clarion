/**
 * D29 encodings and label placement for the T2 map, pure functions.
 * Colour appears only over a threshold, always with a shape and a number: P1 ■, P2 ▲, P3 ●.
 */
export type Priority = 1 | 2 | 3
export const SHAPE: Record<Priority, string> = { 1: '■', 2: '▲', 3: '●' }

/**
 * Alert priority of a zone. An explicit `alert` from the backend (D32) wins; otherwise
 * over target now (`full`) is P2 and approaching it (`near`) is P3. Never computed from truth data (D0).
 */
export function alertOf(v?: { alert?: Priority | null; state?: string | null; closed?: boolean } | null): Priority | null {
  if (!v) return null
  if (v.alert) return v.alert
  if (v.state === 'full') return 2
  if (v.state === 'near') return 3
  return null
}

/** People per m² that start each step of the grey ramp (step 0 is below the first). */
export const DENSITY_STEPS = [0.2, 0.5, 1, 2] as const

/** Grey ramp step 0..4 from the camera count and the zone area; null without a count. */
export function densityStep(people: number | null | undefined, areaM2: number): number | null {
  if (people == null || !(areaM2 > 0)) return null
  const d = people / areaM2
  let step = 0
  for (const s of DENSITY_STEPS) if (d >= s) step++
  return step
}

export interface LabelItem {
  id: string
  /** Anchor (label centre), in map units. */
  x: number; y: number
  w: number; h: number
  /** Higher places first. */
  priority: number
  /** Always drawn, even when every slot collides (alerts). */
  force?: boolean
}
export interface Placed { id: string; x: number; y: number; w: number; h: number }
type Rect = { x: number; y: number; w: number; h: number }

const hit = (a: Rect, b: Rect, m: number) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w + m * 2 && Math.abs(a.y - b.y) * 2 < a.h + b.h + m * 2

/**
 * Greedy placement: by priority, each label tries its anchor, then just above, below, right and left.
 * A label that fits nowhere is dropped, unless forced. `margin` is the clear space between labels.
 */
export function placeLabels(items: LabelItem[], margin = 0, obstacles: Rect[] = []): Placed[] {
  const taken: Rect[] = [...obstacles]
  const out: Placed[] = []
  const order = [...items].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  for (const it of order) {
    const slots: [number, number][] = [[0, 0], [0, -(it.h + margin)], [0, it.h + margin], [it.w * 0.6, 0], [-it.w * 0.6, 0]]
    let at: Rect | null = null
    for (const [dx, dy] of slots) {
      const r = { x: it.x + dx, y: it.y + dy, w: it.w, h: it.h }
      if (!taken.some(t => hit(r, t, margin))) { at = r; break }
    }
    if (!at && it.force) at = { x: it.x, y: it.y, w: it.w, h: it.h }
    if (!at) continue
    taken.push(at)
    out.push({ id: it.id, ...at })
  }
  return out
}

/** Rough text width for the map font (IBM Plex Sans, semibold): good enough to keep labels apart. */
export const textWidth = (s: string, size: number) => {
  let w = 0
  for (const ch of s) w += /[ .,:·il1|]/.test(ch) ? 0.3 : /[mwMW■▲●]/.test(ch) ? 0.85 : /[A-ZĂÂÎȘȚ0-9]/.test(ch) ? 0.64 : 0.55
  return w * size
}

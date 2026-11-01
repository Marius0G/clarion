/**
 * Collision-free icons and labels for the live map, pure. Everything is in screen pixels.
 * Greedy by rank (Mappedin label tiers): an icon that overlaps a higher one is dropped,
 * a label tries right, left, below, above its icon and is dropped where none fits.
 */
export interface PlaceItem { id: string; x: number; y: number; r: number; w: number; h: number; rank: number; force?: boolean }
export interface Placed { id: string; label: { x: number; y: number; anchor: 'start' | 'middle' | 'end' } | null }
export type Rect = [number, number, number, number]

const overlaps = (a: Rect, b: Rect, m: number) => a[0] < b[2] + m && b[0] < a[2] + m && a[1] < b[3] + m && b[1] < a[3] + m

/** `view` is the screen [w, h]; items further than `edge` px outside it are skipped. */
/** `obstacles`: screen rects [x0, y0, x1, y1] already taken (markers, tags) that icons and labels avoid. */
export function placeItems(items: readonly PlaceItem[], view: [number, number], margin = 4, edge = 40, obstacles: readonly Rect[] = []): Placed[] {
  const order = [...items].filter(i => i.x > -edge && i.y > -edge && i.x < view[0] + edge && i.y < view[1] + edge)
    .sort((a, b) => Number(!!b.force) - Number(!!a.force) || b.rank - a.rank || a.id.localeCompare(b.id))
  const icons: Rect[] = [], labels: Rect[] = [...obstacles]
  const kept: PlaceItem[] = []
  for (const it of order) {
    const box: Rect = [it.x - it.r, it.y - it.r, it.x + it.r, it.y + it.r]
    if (!it.force && icons.some(o => overlaps(box, o, margin / 2))) continue
    icons.push(box); kept.push(it)
  }
  const out: Placed[] = []
  for (const it of kept) {
    if (!it.w) { out.push({ id: it.id, label: null }); continue }
    const gap = 4, half = it.h / 2
    const slots: [Rect, Placed['label']][] = [
      [[it.x + it.r + gap, it.y - half, it.x + it.r + gap + it.w, it.y + half], { x: it.x + it.r + gap, y: it.y, anchor: 'start' }],
      [[it.x - it.r - gap - it.w, it.y - half, it.x - it.r - gap, it.y + half], { x: it.x - it.r - gap, y: it.y, anchor: 'end' }],
      [[it.x - it.w / 2, it.y + it.r + gap, it.x + it.w / 2, it.y + it.r + gap + it.h], { x: it.x, y: it.y + it.r + gap + half, anchor: 'middle' }],
      [[it.x - it.w / 2, it.y - it.r - gap - it.h, it.x + it.w / 2, it.y - it.r - gap], { x: it.x, y: it.y - it.r - gap - half, anchor: 'middle' }],
    ]
    const fit = slots.find(([r]) => r[0] >= 0 && r[2] <= view[0] && !icons.some(o => overlaps(r, o, 1)) && !labels.some(o => overlaps(r, o, margin)))
      ?? (it.force ? slots[0] : undefined)
    if (fit) labels.push(fit[0])
    out.push({ id: it.id, label: fit ? fit[1] : null })
  }
  return out
}

/** Rough label width for IBM Plex Sans semibold. */
export function textWidth(s: string, size: number) {
  let w = 0
  for (const ch of s) w += /[ .,:·il1|ţţ]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.85 : /[A-ZĂÂÎȘȚ0-9]/.test(ch) ? 0.64 : 0.55
  return w * size
}

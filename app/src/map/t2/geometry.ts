import type { Pt, Ring } from './data'

/** SVG path for a ring with holes (use fill-rule evenodd). */
export function ringPath(ring: Ring) {
  const loop = (pts: Pt[]) => `M${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}Z`
  return [loop(ring.outer), ...ring.holes.map(loop)].join('')
}

/** Ray-casting point-in-polygon, pixels, holes respected. */
export function inRing([x, y]: Pt, ring: Ring) {
  const hit = (poly: Pt[]) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  return hit(ring.outer) && !ring.holes.some(hit)
}

/**
 * Minimum-area oriented box of a polygon, long side on local x.
 * Draw in local coordinates inside `translate(cx cy) rotate(angle)`.
 */
export interface LocalFrame { cx: number; cy: number; angle: number; w: number; h: number; toLocal: (p: Pt) => Pt }

export function frameOf(poly: Pt[]): LocalFrame {
  const px = poly.reduce((s, p) => s + p[0], 0) / poly.length
  const py = poly.reduce((s, p) => s + p[1], 0) / poly.length
  const box = (a: number) => {
    const c = Math.cos(a), s = Math.sin(a)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const [x, y] of poly) {
      const dx = x - px, dy = y - py
      const lx = dx * c + dy * s, ly = -dx * s + dy * c
      minX = Math.min(minX, lx); maxX = Math.max(maxX, lx); minY = Math.min(minY, ly); maxY = Math.max(maxY, ly)
    }
    return { minX, maxX, minY, maxY }
  }
  let best = 0, bestArea = Infinity
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!, [x2, y2] = poly[(i + 1) % poly.length]!
    if (Math.hypot(x2 - x1, y2 - y1) < 1e-6) continue
    const a = Math.atan2(y2 - y1, x2 - x1)
    const b = box(a), area = (b.maxX - b.minX) * (b.maxY - b.minY)
    if (area < bestArea - 1e-6) { bestArea = area; best = a }
  }
  let b = box(best)
  if (b.maxY - b.minY > b.maxX - b.minX) best += Math.PI / 2
  // Keep text upright: angle in (-90°, 90°].
  while (best > Math.PI / 2) best -= Math.PI
  while (best <= -Math.PI / 2) best += Math.PI
  b = box(best)
  const c = Math.cos(best), s = Math.sin(best)
  const ox = (b.minX + b.maxX) / 2, oy = (b.minY + b.maxY) / 2
  const cx = px + ox * c - oy * s, cy = py + ox * s + oy * c
  return {
    cx, cy, angle: (best * 180) / Math.PI, w: b.maxX - b.minX, h: b.maxY - b.minY,
    toLocal: ([x, y]) => { const dx = x - cx, dy = y - cy; return [dx * c + dy * s, -dx * s + dy * c] },
  }
}

export const fmt = (n: number) => Number(n.toFixed(1))

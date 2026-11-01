/** Pan / zoom maths for the live map, pure. A view is a centre in map units and a scale in CSS px per map unit. */
import type { Pt } from '../t2/data'
import type { Box } from '../t2/stack'

export interface View { cx: number; cy: number; s: number }
export type Size = [number, number]

/** Scale that fits `box` inside a `size` screen with `pad` px around it. */
export function fitScale(box: Box, [w, h]: Size, pad = 16) {
  return Math.min((w - 2 * pad) / Math.max(box[2], 1), (h - 2 * pad) / Math.max(box[3], 1))
}
export function fitView(box: Box, size: Size, pad = 16): View {
  return { cx: box[0] + box[2] / 2, cy: box[1] + box[3] / 2, s: Math.max(fitScale(box, size, pad), 1e-6) }
}
export interface Limits { bounds: Box; min: number; max: number }
/** Building limits: never zoom out past the whole building, never pan its centre off screen. */
export function limitsFor(bounds: Box, size: Size, maxZoom = 14): Limits {
  const min = fitScale(bounds, size, 8) * 0.9
  return { bounds, min, max: min * maxZoom }
}
/** `inset`: screen px covered at the bottom (the sheet); the building may scroll up above it. */
export function clampView(v: View, size: Size, { bounds: b, min, max }: Limits, inset = 0): View {
  const s = Math.min(max, Math.max(min, v.s))
  const bounds: Box = [b[0], b[1], b[2], b[3] + inset / s]
  // Half the screen in map units: the building edge may reach the screen centre, not beyond.
  const hw = size[0] / 2 / s, hh = size[1] / 2 / s
  const clamp = (c: number, lo: number, len: number, half: number) => len <= 2 * half ? Math.min(Math.max(c, lo + len - half), lo + half) : Math.min(Math.max(c, lo), lo + len)
  return { s, cx: clamp(v.cx, bounds[0], bounds[2], hw), cy: clamp(v.cy, bounds[1], bounds[3], hh) }
}
export const viewBox = (v: View, [w, h]: Size): Box => [v.cx - w / 2 / v.s, v.cy - h / 2 / v.s, w / v.s, h / v.s]
/** Screen px (relative to the map element) to map units. */
export const toMap = (v: View, [w, h]: Size, px: number, py: number): Pt => [v.cx + (px - w / 2) / v.s, v.cy + (py - h / 2) / v.s]
/** Zoom by `k` keeping the map point under (px, py) in place. */
export function zoomAt(v: View, k: number, size: Size, px: number, py: number): View {
  const [mx, my] = toMap(v, size, px, py)
  const s = v.s * k
  return { s, cx: mx - (px - size[0] / 2) / s, cy: my - (py - size[1] / 2) / s }
}
export const lerpView = (a: View, b: View, t: number): View => {
  // Interpolate the scale geometrically, so zooming feels even.
  const s = a.s * Math.pow(b.s / a.s, t)
  return { s, cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t }
}
/** Box around points with a minimum size, in map units. */
export function boxAround(pts: readonly Pt[], minW: number, minH = minW * 0.6): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  const w = Math.max(x1 - x0, minW), h = Math.max(y1 - y0, minH), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  return [cx - w / 2, cy - h / 2, w, h]
}

/* ---------- Moving team marker ---------- */
/** Point and heading (radians) at fraction `t` (0..1) of a polyline's length. */
export function along(pts: readonly Pt[], t: number): { at: Pt; heading: number; index: number } {
  if (!pts.length) return { at: [0, 0], heading: 0, index: 0 }
  if (pts.length === 1) return { at: pts[0]!, heading: 0, index: 0 }
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]))
  const total = lens.reduce((a, b) => a + b, 0)
  let d = Math.min(1, Math.max(0, t)) * total
  for (let i = 0; i < lens.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!, len = lens[i]!
    if (d <= len || i === lens.length - 1) {
      const k = len > 0 ? Math.min(1, d / len) : 0
      return { at: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], heading: Math.atan2(b[1] - a[1], b[0] - a[0]), index: i }
    }
    d -= len
  }
  return { at: pts[pts.length - 1]!, heading: 0, index: lens.length - 1 }
}
/**
 * Team progress from the report lifecycle: it left when the report became `en_route` and needs `etaMin`.
 * Held at 95 % until the report is resolved, so the marker never claims to have arrived.
 */
export function teamProgress(enRouteAt: string | undefined, etaMin: number | null | undefined, now: number): { t: number; leftMin: number } | null {
  const start = enRouteAt ? Date.parse(enRouteAt) : NaN
  if (!Number.isFinite(start) || etaMin == null || !(etaMin > 0)) return null
  const t = Math.min(0.95, Math.max(0, (now - start) / (etaMin * 60_000)))
  return { t, leftMin: Math.max(1, Math.ceil(etaMin - (now - start) / 60_000)) }
}

import type { Pt } from './data'

/**
 * Flat two-floor layout, pure math. Both floors share Marius's x,z frame (10 px per metre); the upper
 * plate is the same drawing moved up by `gap`, so x stays aligned between the floors.
 */
/** Smallest plate offset allowed. */
export const MIN_GAP = 52

/** [x, y, width, height] */
export type Box = [number, number, number, number]

/** Upper plate (i = 1) sits `gap` above the ground plate (i = 0). */
export const plateOffset = (i: number, gap: number) => -i * gap
export const onPlate = (i: number, gap: number, [x, y]: Pt): Pt => [x, y + plateOffset(i, gap)]

export function boundsOf(pts: Iterable<Pt>): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  return [x0, y0, x1 - x0, y1 - y0]
}

export const pad = ([x, y, w, h]: Box, l: number, t = l, r = l, b = t): Box => [x - l, y - t, w + l + r, h + t + b]

/** Grow a box around its centre to the given aspect ratio (width / height), so it fills a 16:9 screen. */
export function fitAspect([x, y, w, h]: Box, ratio: number): Box {
  if (w / h < ratio) { const nw = h * ratio; return [x - (nw - w) / 2, y, nw, h] }
  const nh = w / ratio
  return [x, y - (nh - h) / 2, w, nh]
}

/**
 * Offset that stacks the upper plate fully above the ground plate: its lowest point sits `clear`
 * above the ground plate's highest point, so every zone reads as one floor or the other. Never below MIN_GAP.
 */
export function stackGap(lower: Box, upper: Box, clear: number): number {
  return Math.max(MIN_GAP, Math.ceil(upper[1] + upper[3] - lower[1] + clear))
}

/** y of the line between the plates, halfway through the clear space. */
export const dividerY = (lower: Box, upper: Box, gap: number) => (upper[1] + upper[3] - gap + lower[1]) / 2

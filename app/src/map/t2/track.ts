/** A dot that keeps its key from one update to the next, so the map glides it instead of re-dealing positions. */
export interface Tracked<T> { key: string; dot: T; leaving: boolean }
export interface TrackState<T> { sig: string; items: Tracked<T>[]; next: number }
type Dot = { x: number; z: number; level: string; id?: string | number }

/** Content signature of a dot list: a new list with the same people in the same places is not an update. */
export const dotSig = (dots: readonly Dot[]) => dots.map(d => `${d.id ?? ''}|${d.level}|${d.x.toFixed(2)}|${d.z.toFixed(2)}`).join(';')

/**
 * Matches the new dots to the previous ones: by `id` when the cameras send one, otherwise nearest neighbour on the same
 * level within `radius` metres (closest pairs first). Unmatched dots are new; previous dots with no match stay one update
 * as `leaving`, so they can fade out.
 */
export function trackDots<T extends Dot>(prev: TrackState<T> | null, dots: readonly T[], radius = 4): TrackState<T> {
  const live = (prev?.items ?? []).filter(i => !i.leaving)
  let next = prev?.next ?? 0
  const keys: (string | null)[] = dots.map(d => d.id != null ? `i:${d.id}` : null)
  const taken = new Set(keys.filter((k): k is string => k != null))
  const free = live.filter(i => i.dot.id == null && !taken.has(i.key))
  const pairs: [number, number, number][] = []
  dots.forEach((d, a) => {
    if (keys[a] != null) return
    free.forEach((p, b) => {
      if (p.dot.level !== d.level) return
      const dist = Math.hypot(p.dot.x - d.x, p.dot.z - d.z)
      if (dist <= radius) pairs.push([dist, a, b])
    })
  })
  pairs.sort((p, q) => p[0] - q[0])
  const usedPrev = new Set<number>()
  for (const [, a, b] of pairs) {
    if (keys[a] != null || usedPrev.has(b)) continue
    keys[a] = free[b]!.key
    usedPrev.add(b)
  }
  const items: Tracked<T>[] = dots.map((dot, a) => ({ key: keys[a] ?? `n:${next++}`, dot, leaving: false }))
  const present = new Set(items.map(i => i.key))
  for (const old of live) if (!present.has(old.key)) items.push({ ...old, leaving: true })
  return { sig: dotSig(dots), items, next }
}

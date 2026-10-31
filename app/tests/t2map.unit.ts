import { it, expect } from 'vitest'
import { frames, points, worldToPx, zones } from '../src/map/t2/data'
import { frameOf, inRing } from '../src/map/t2/geometry'

it('has the 52 zones from the package, on three levels', () => {
  expect(zones).toHaveLength(52)
  expect(new Set(zones.map(z => z.level))).toEqual(new Set(['G', 'U', 'X']))
  expect(new Set(zones.map(z => z.id)).size).toBe(52)
})

it('converts world metres to the same pixels Marius exported', () => {
  for (const p of points) {
    const [x, y] = worldToPx(p.x, p.z, p.level)
    expect(Math.abs(x - p.px[0])).toBeLessThan(0.2)
    expect(Math.abs(y - p.px[1])).toBeLessThan(0.2)
  }
  expect(frames.G.width).toBe(3000)
  expect(frames.X.ppm).toBe(4)
})

it('puts each check-in desk inside the check-in desk zone', () => {
  const desks = zones.find(z => z.id === 'G_CHECKIN_DESKS')!
  const inside = points.filter(p => p.type === 'checkin_desk').filter(p => desks.polygons_px.some(r => inRing(p.px, r)))
  expect(inside.length).toBeGreaterThanOrEqual(10)
})

it('orients each zone with its long side on local x and keeps text upright', () => {
  for (const z of zones) {
    const f = frameOf(z.polygons_px[0]!.outer)
    expect(f.w).toBeGreaterThanOrEqual(f.h - 1e-6)
    expect(f.angle).toBeGreaterThan(-90.0001)
    expect(f.angle).toBeLessThanOrEqual(90.0001)
    // Every vertex lands inside the local box.
    for (const p of z.polygons_px[0]!.outer) {
      const [lx, ly] = f.toLocal(p)
      expect(Math.abs(lx)).toBeLessThanOrEqual(f.w / 2 + 0.5)
      expect(Math.abs(ly)).toBeLessThanOrEqual(f.h / 2 + 0.5)
    }
  }
})

it('respects holes when testing points', () => {
  const ring = { outer: [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][], holes: [[[4, 4], [6, 4], [6, 6], [4, 6]] as [number, number][]] }
  expect(inRing([1, 1], ring)).toBe(true)
  expect(inRing([5, 5], ring)).toBe(false)
  expect(inRing([11, 5], ring)).toBe(false)
})

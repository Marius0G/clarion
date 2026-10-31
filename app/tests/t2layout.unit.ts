import { it, expect, describe } from 'vitest'
import { zones } from '../src/map/t2/data'
import { boundsOf, dividerY, fitAspect, MIN_GAP, onPlate, stackGap, type Box } from '../src/map/t2/stack'
import { alertOf, densityStep, placeLabels, textWidth } from '../src/map/t2/layout'

const plateBox = (level: 'G' | 'U'): Box => boundsOf(zones.filter(z => z.level === level).flatMap(z => z.polygons_px.flatMap(r => r.outer)))

describe('plates', () => {
  it('moves the upper plate straight up, keeping x', () => {
    expect(onPlate(0, 900, [120, 340])).toEqual([120, 340])
    expect(onPlate(1, 900, [120, 340])).toEqual([120, -560])
  })

  it('puts the whole upper floor above the whole ground floor, with clear space between', () => {
    const g = plateBox('G'), u = plateBox('U')
    const gap = stackGap(g, u, 90)
    expect(gap).toBeGreaterThanOrEqual(MIN_GAP)
    expect(u[1] + u[3] - gap + 90).toBeLessThanOrEqual(g[1] + 1e-9)
    const line = dividerY(g, u, gap)
    expect(line).toBeGreaterThan(u[1] + u[3] - gap)
    expect(line).toBeLessThan(g[1])
  })

  it('never offsets less than the minimum', () => {
    expect(stackGap([0, 100, 10, 10], [0, 0, 10, 10], 0)).toBe(MIN_GAP)
  })

  it('grows a box to 16:9 around its centre', () => {
    const wide = fitAspect([0, 0, 3200, 900], 16 / 9)
    expect(wide[2] / wide[3]).toBeCloseTo(16 / 9)
    expect(wide[0]).toBe(0)
    expect(wide[1] + wide[3] / 2).toBeCloseTo(450)
    const tall = fitAspect([0, 0, 1000, 1000], 16 / 9)
    expect(tall[2] / tall[3]).toBeCloseTo(16 / 9)
    expect(tall[0] + tall[2] / 2).toBeCloseTo(500)
  })
})

describe('encodings', () => {
  it('maps zone state to D32 priorities, an explicit alert wins', () => {
    expect(alertOf(null)).toBeNull()
    expect(alertOf({ state: 'normal' })).toBeNull()
    expect(alertOf({ state: 'near' })).toBe(3)
    expect(alertOf({ state: 'full' })).toBe(2)
    expect(alertOf({ state: 'near', alert: 1 })).toBe(1)
  })

  it('steps the grey ramp by people per m²', () => {
    expect(densityStep(null, 100)).toBeNull()
    expect(densityStep(5, 0)).toBeNull()
    expect(densityStep(0, 100)).toBe(0)
    expect(densityStep(30, 100)).toBe(1)
    expect(densityStep(88, 128.9)).toBe(2)
    expect(densityStep(150, 100)).toBe(3)
    expect(densityStep(500, 100)).toBe(4)
  })
})

describe('label placement', () => {
  const box = (id: string, x: number, priority: number, force = false) => ({ id, x, y: 0, w: 100, h: 20, priority, force })
  it('keeps the higher priority label where it is and moves the other', () => {
    const out = placeLabels([box('low', 10, 1), box('high', 0, 9)])
    expect(out[0]).toMatchObject({ id: 'high', x: 0, y: 0 })
    const low = out.find(p => p.id === 'low')!
    expect(Math.abs(low.y) >= 20 || Math.abs(low.x - 0) >= 100).toBe(true)
  })

  it('never overlaps placed labels', () => {
    const items = Array.from({ length: 12 }, (_, i) => box(`l${i}`, i * 15, i))
    const out = placeLabels(items, 2)
    for (const a of out) for (const b of out) if (a !== b)
      expect(Math.abs(a.x - b.x) * 2 >= a.w + b.w + 4 - 1e-9 || Math.abs(a.y - b.y) * 2 >= a.h + b.h + 4 - 1e-9).toBe(true)
    expect(out.length).toBeLessThan(items.length)
  })

  it('always draws a forced label (alerts)', () => {
    const items = [box('a', 0, 9), box('b', 0, 8), box('c', 0, 7), box('d', 0, 6), box('e', 0, 5), box('f', 0, 4), box('alert', 0, 1, true)]
    expect(placeLabels(items).map(p => p.id)).toContain('alert')
  })

  it('measures wider text wider', () => {
    expect(textWidth('Coadă securitate', 15)).toBeGreaterThan(textWidth('WC', 15))
  })
})

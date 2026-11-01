import { describe, expect, it } from 'vitest'
import { trackDots } from '../src/map/t2/track'

const dot = (x: number, z: number, id?: string) => ({ x, z, level: 'G', ...(id && { id }) })
describe('map dots keep their key across updates', () => {
  it('matches by id, whatever the order', () => {
    const a = trackDots(null, [dot(0, 0, 'c:1'), dot(10, 0, 'c:2')])
    const b = trackDots(a, [dot(11, 0, 'c:2'), dot(1, 0, 'c:1')])
    expect(b.items.map(i => i.key)).toEqual(['i:c:2', 'i:c:1'])
  })
  it('matches by nearest neighbour without ids, fades out the ones that left, and gives newcomers new keys', () => {
    const a = trackDots(null, [dot(0, 0), dot(10, 0)])
    const b = trackDots(a, [dot(10.5, 0), dot(30, 0)])
    expect(b.items.find(i => i.dot.x === 10.5)!.key).toBe(a.items[1]!.key)
    expect(b.items.find(i => i.dot.x === 30)!.key).not.toBe(a.items[0]!.key)
    expect(b.items.filter(i => i.leaving).map(i => i.key)).toEqual([a.items[0]!.key])
    const c = trackDots(b, [dot(10.6, 0)])
    expect(c.items.some(i => i.key === a.items[0]!.key)).toBe(false)
  })
  it('does not glide a dot whose id jumped or changed floor: the old one fades, the new one appears in place', () => {
    const a = trackDots(null, [dot(0, 0, 'c:1')])
    const b = trackDots(a, [dot(9, 0, 'c:1')])
    expect(b.items.find(i => !i.leaving)!.key).not.toBe('i:c:1')
    expect(b.items.filter(i => i.leaving).map(i => i.key)).toEqual(['i:c:1'])
    const c = trackDots(b, [dot(9.5, 0, 'c:1')])
    expect(c.items[0]!.key).toBe(b.items.find(i => !i.leaving)!.key)
  })
})

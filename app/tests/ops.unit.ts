import { it, expect } from 'vitest'
import { commandLabel, simClock, zoneStats } from '../src/console/opsZones'
import { inside, plan } from '../src/console/terminal'
import type { SimSnapshot } from '../src/backend/sim'

const sim = (patch: Partial<SimSnapshot>) => ({ connected: true, lastSeen: null, run: { scenario: null, arm: null, coverage: null, seed: null }, simTime: null, counts: {}, phones: { unknown: 0, notified: 0, read: 0, acting: 0 }, flow: {}, ...patch }) as SimSnapshot
const row = (waiting: number, capacity: number | null, extra = {}) => ({ waiting, capacity, waitMin: null, peak: waiting, updatedAt: '', ...extra })

it('provisional plan has unique ids, nodes inside their zones and edges between known nodes', () => {
  const zones = new Set(plan.zones.map(z => z.id)), nodes = new Set(plan.nodes.map(n => n.id))
  expect(zones.size).toBe(plan.zones.length)
  expect(nodes.size).toBe(plan.nodes.length)
  for (const n of plan.nodes) if (n.zone) expect(inside([n.x, n.y], plan.zones.find(z => z.id === n.zone)!.polygon)).toBe(true)
  for (const e of plan.edges) { expect(nodes.has(e.from) && nodes.has(e.to)).toBe(true); expect(e.walkSec).toBeGreaterThan(0) }
  for (const id of ['entrance', 'check_in:W6', 'bag_drop:W6', 'security', 'airside', 'gate_1']) expect(zones.has(id)).toBe(true)
})

it('shows nothing without a connected Unity', () => {
  for (const s of [null, sim({ connected: false, flow: { security: row(10, 20) } })])
    expect(zoneStats(plan, s).every(z => z.people == null && z.staff == null && z.state == null)).toBe(true)
})

it('uses flow.report first and counts dots inside zones otherwise', () => {
  const stats = zoneStats(plan, sim({
    flow: { security: row(90, 100, { staff: 4, waitMin: 11.6 }), 'check_in:W6': row(31, 30) },
    positions: { at: '', people: [{ x: 110, y: 10, kind: 'pax' }, { x: 111, y: 11, kind: 'pax' }, { x: 112, y: 12, kind: 'staff' }, { x: 62, y: 30, kind: 'staff' }] },
  }))
  const z = (id: string) => stats.find(s => s.id === id)!
  expect(z('security')).toMatchObject({ people: 90, staff: 4, waitMin: 11.6, state: 'near', staffed: true })
  expect(z('check_in:W6')).toMatchObject({ people: 31, state: 'full' })
  expect(z('gate_1')).toMatchObject({ people: 2, staff: 1, state: null, staffed: false })
  expect(z('airside')).toMatchObject({ people: 0, staff: 0 })
})

it('labels commands with short nouns and formats sim time', () => {
  expect(commandLabel({ type: 'staff', zone: 'bag_drop:W6', delta: 1 }, plan)).toBe('Bagaje W6 +1 angajat')
  expect(commandLabel({ type: 'staff', zone: 'security', delta: -1 }, plan)).toBe('Securitate −1 angajat')
  expect(commandLabel({ type: 'evacuate', zones: ['gate_1', 'gate_2'] }, plan)).toBe('Evacuare Poarta 1, Poarta 2')
  expect(simClock(52200)).toBe('14:30:00')
  expect(simClock(86400 + 61)).toBe('00:01:01')
  expect(simClock(null)).toBe('—')
})

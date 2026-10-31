import { it, expect } from 'vitest'
import { accuracyRows, adviceText, commandLabel, commandTouchesZone, redirectTargets, liveDots, loadState, simClock, zoneStats } from '../src/console/opsZones'
import { inside, plan } from '../src/console/terminal'
import { openReports } from '../src/backend/reports'
import type { SimSnapshot } from '../src/backend/sim'

const sim = (patch: Partial<SimSnapshot>) => ({ connected: false, vision: true, lastSeen: null, run: { scenario: null, arm: null, coverage: null, seed: null }, simTime: null, counts: {}, phones: { unknown: 0, notified: 0, read: 0, acting: 0 }, flow: {}, ...patch }) as SimSnapshot
const row = (waiting: number, extra = {}) => ({ waiting, capacity: null, waitMin: null, peak: waiting, updatedAt: '', stale: false, ...extra })

it('provisional plan has unique ids, nodes inside their zones and edges between known nodes', () => {
  const zones = new Set(plan.zones.map(z => z.id)), nodes = new Set(plan.nodes.map(n => n.id))
  expect(zones.size).toBe(plan.zones.length)
  expect(nodes.size).toBe(plan.nodes.length)
  for (const n of plan.nodes) if (n.zone) expect(inside([n.x, n.y], plan.zones.find(z => z.id === n.zone)!.polygon)).toBe(true)
  for (const e of plan.edges) { expect(nodes.has(e.from) && nodes.has(e.to)).toBe(true); expect(e.walkSec).toBeGreaterThan(0) }
  // D8: desk groups, same ids as the backend's initial lanes.
  for (const id of ['entrance', 'check_in:1', 'bag_drop:1', 'check_in:2', 'bag_drop:2', 'security', 'airside', 'gate_1']) expect(zones.has(id)).toBe(true)
})

it('shows unknown without a camera feed, and never turns stale or missing rows into numbers', () => {
  for (const s of [null, sim({ vision: false, flow: { security: row(10) } })])
    expect(zoneStats(plan, s).every(z => z.people == null && z.waitMin == null && z.state == null)).toBe(true)
  const stats = zoneStats(plan, sim({
    flow: { security: row(0, { waitMin: 0 }), 'check_in:1': row(30, { stale: true, waitMin: 9 }) },
    // Dots inside gate_1 must not become a count.
    positions: { at: '', people: [{ x: 110, y: 10 }, { x: 111, y: 11 }] },
  }))
  const z = (id: string) => stats.find(s => s.id === id)!
  expect(z('security')).toMatchObject({ people: 0, waitMin: 0, state: 'normal' })
  expect(z('check_in:1')).toMatchObject({ people: null, waitMin: null, state: null })
  expect(z('gate_1')).toMatchObject({ people: null, state: null, staffed: false })
})

it('takes people and wait from the cameras and lanes from the backend', () => {
  const stats = zoneStats(plan, sim({
    flow: { security: row(90, { waitMin: 21.6 }), 'check_in:2': row(31, { waitMin: 12 }) },
    lanes: { security: 3, 'check_in:2': 0 },
  }))
  const z = (id: string) => stats.find(s => s.id === id)!
  expect(z('security')).toMatchObject({ people: 90, lanes: 3, waitMin: 21.6, state: 'full', staffed: true })
  expect(z('check_in:2')).toMatchObject({ people: 31, lanes: 0, state: 'near' })
  expect(z('bag_drop:1')).toMatchObject({ people: null, lanes: null })
  // A legacy Unity (no vision) still counts as a feed.
  expect(zoneStats(plan, sim({ vision: false, connected: true, flow: { security: row(5) } })).find(s => s.id === 'security')!.people).toBe(5)
})

it('colours load by camera wait, falling back to legacy capacity', () => {
  expect(loadState({ waiting: 1, waitMin: 9.9, capacity: null })).toBe('normal')
  expect(loadState({ waiting: 1, waitMin: 10, capacity: null })).toBe('near')
  expect(loadState({ waiting: 1, waitMin: 20, capacity: null })).toBe('full')
  expect(loadState({ waiting: 31, waitMin: null, capacity: 30 })).toBe('full')
  expect(loadState({ waiting: 31, waitMin: null, capacity: null })).toBeNull()
})

it('formats A7 advice as one short line, defensively', () => {
  expect(adviceText('Deschide o linie până la 14:05, altfel 18 min la 14:30', 2)).toBe('Deschide o linie până la 14:05, altfel 18 min la 14:30')
  expect(adviceText({ lanes: 3, by: 50700, waitMinIfNot: 18.4 }, 2)).toBe('Deschide o linie până la 14:05, altfel 18 min')
  expect(adviceText({ lanes: 4, by: '14:05', waitMin: 9 }, 2)).toBe('Deschide 2 linii până la 14:05, altfel 9 min')
  expect(adviceText({ lanes: 3 }, null)).toBe('3 linii')
  expect(adviceText({ waitMinIfNot: 12 }, 1)).toBe('Deschide o linie, altfel 12 min')
  expect(adviceText('  ', 1)).toBeNull()
  expect(adviceText({ lanes: Number.NaN, by: null, waitMinIfNot: Number.POSITIVE_INFINITY }, 1)).toBe('Deschide o linie')
})

it('puts camera estimates next to Unity truth, only for zones the truth covers', () => {
  expect(accuracyRows(plan, sim({}))).toEqual([])
  const rows = accuracyRows(plan, sim({
    flow: { security: row(40, { waitMin: 11 }) },
    truth: { at: '', zones: { gate_9: { waiting: 1, waitMin: null }, 'check_in:1': { waiting: 12, waitMin: 5 }, security: { waiting: 44, waitMin: 12.5 } } },
  }))
  expect(rows).toEqual([
    { id: 'check_in:1', name: 'Check-in 1', camPeople: null, truePeople: 12, camWait: null, trueWait: 5 },
    { id: 'security', name: 'Securitate', camPeople: 40, truePeople: 44, camWait: 11, trueWait: 12.5 },
    { id: 'gate_9', name: 'gate_9', camPeople: null, truePeople: 1, camWait: null, trueWait: null },
  ])
})

it('shows camera dots only while a feed is online', () => {
  const people = [{ x: 1, y: 2 }]
  expect(liveDots(sim({ positions: { at: '', people } }))).toEqual(people)
  expect(liveDots(sim({ vision: false, positions: { at: '', people } }))).toEqual([])
  expect(liveDots(null)).toEqual([])
})

it('keeps only well-formed open staff reports', () => {
  const r = { id: 'r1', at: '', kind: 'bagaj', node: 'gate_3', text: 'Bagaj abandonat', status: 'open' }
  expect(openReports([r, { ...r, id: 'r2', status: 'closed' }, { ...r, id: 'r3', status: 'resolved' }, { ...r, id: 4 }, null])).toEqual([r])
  expect(openReports({ error: 'Not found' })).toEqual([])
})

it('labels commands with short nouns and formats sim time', () => {
  expect(commandLabel({ type: 'staff', zone: 'bag_drop:1', delta: 1 }, plan)).toBe('Bagaje 1 +1 linie')
  expect(commandLabel({ type: 'staff', zone: 'security', delta: -1 }, plan)).toBe('Securitate −1 linie')
  expect(commandLabel({ type: 'staff', zone: 'security', delta: 2 }, plan)).toBe('Securitate +2 linii')
  expect(commandLabel({ type: 'evacuate', zones: ['gate_1', 'gate_2'] }, plan)).toBe('Evacuare Poarta 1, Poarta 2')
  expect(simClock(52200)).toBe('14:30:00')
  expect(simClock(86400 + 61)).toBe('00:01:01')
  expect(simClock(null)).toBe('—')
})

it('reads blocked zones independently of camera state and only redirects to open peers', () => {
  const stats = zoneStats(plan, sim({ vision: false, blocked: ['check_in:2', 'security'] }))
  const source = stats.find(z => z.id === 'check_in:1')!
  expect(source.closed).toBe(false)
  expect(stats.find(z => z.id === 'security')).toMatchObject({ closed: true, people: null })
  expect(redirectTargets(stats, source)).toEqual([])
  const open = zoneStats(plan, sim({}))
  expect(redirectTargets(open, open.find(z => z.id === 'check_in:1')!).map(z => z.id)).toEqual(['check_in:2'])
  expect(redirectTargets(open, open.find(z => z.id === 'security')!)).toEqual([])
  expect(redirectTargets(open, open.find(z => z.id === 'bag_drop:1')!).map(z => z.id)).toEqual(['bag_drop:2'])
})

it('associates each decision with its zones and labels redirect, close and open', () => {
  expect(commandTouchesZone({ type: 'redirect', from: 'check_in:1', to: 'check_in:2' }, 'check_in:2')).toBe(true)
  expect(commandTouchesZone({ type: 'evacuate', zones: ['security', 'gate_1'] }, 'gate_1')).toBe(true)
  expect(commandTouchesZone({ type: 'close', zone: 'security' }, 'gate_1')).toBe(false)
  expect(commandTouchesZone({ type: 'staff', zone: 'security', delta: 1 }, 'security')).toBe(true)
  expect(commandLabel({ type: 'redirect', from: 'check_in:1', to: 'check_in:2' }, plan)).toBe('Redirecționare Check-in 1 → Check-in 2')
  expect(commandLabel({ type: 'close', zone: 'security' }, plan)).toBe('Închidere Securitate')
  expect(commandLabel({ type: 'open', zone: 'security' }, plan)).toBe('Deschidere Securitate')
})

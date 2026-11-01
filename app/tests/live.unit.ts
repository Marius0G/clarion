import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ageLabel, crowdLevel, crowdWords, isStale, people, rowFor, STALE_MS, trend, waitBand, type FlowRow } from '../src/map/live/crowd'
import { placeItems } from '../src/map/live/placement'
import { along, clampView, fitView, limitsFor, teamProgress, toMap, zoomAt } from '../src/map/live/view'
import { resolveHere, stagePlace, FRESH_MS } from '../src/map/live/here'
import { notices, type OpsRecord } from '../src/map/live/notices'
import { categoryOf, floorChanges, landmarkFor, routeBetween, search, tierOf, type RouteIndex } from '../src/map/live/catalogue'
import { backoff, mergeEntries, personSocketUrl, type ChatEntry } from '../src/chat/channel'

const now = Date.parse('2026-11-01T12:00:00Z')
const row = (extra: Partial<FlowRow> = {}, ago = 2): FlowRow => ({ waiting: 10, waitMin: null, density: null, coverage: 1, updatedAt: new Date(now - ago * 1000).toISOString(), source: 'vision', ...extra })

describe('crowding levels (D20)', () => {
  it('queues follow the wait target, forecast included', () => {
    expect(crowdLevel(row({ waitMin: 8 }), 'security', now)).toBe('free')
    expect(crowdLevel(row({ waitMin: 10 }), 'security', now)).toBe('free')
    expect(crowdLevel(row({ waitMin: 11 }), 'security', now)).toBe('busy')
    expect(crowdLevel(row({ waitMin: 6, forecast: [{ inMin: 30, waitMin: 12 }] }), 'security', now)).toBe('busy')
    expect(crowdLevel(row({ waitMin: 6, forecast: [{ inMin: 90, waitMin: 40 }] }), 'security', now)).toBe('free')
    expect(crowdLevel(row({ waitMin: 20 }), 'security', now)).toBe('very')
    expect(crowdLevel(row({ waitMin: 16 }), 'check_in:2', now)).toBe('busy')
    expect(crowdLevel(row({ waitMin: null }), 'U_SECURITY_QUEUE', now)).toBe('unknown')
  })
  it('other zones follow density, from the count when the camera sends none', () => {
    expect(crowdLevel(row({ density: 0.4 }), 'U_GATE_3', now)).toBe('free')
    expect(crowdLevel(row({ density: 1 }), 'U_GATE_3', now)).toBe('busy')
    expect(crowdLevel(row({ density: 2.1 }), 'U_GATE_3', now)).toBe('very')
    expect(crowdLevel(row({ waiting: 300 }), 'G_CENTER', now, 100)).toBe('very')
    expect(crowdLevel(row({ waiting: 30 }), 'G_CENTER', now)).toBe('unknown')
  })
  it('old or missing readings are "Fără date", never the last number', () => {
    expect(isStale(row({}, 119), now)).toBe(false)
    expect(isStale(row({}, 121), now)).toBe(true)
    expect(isStale({ updatedAt: 'nope' }, now)).toBe(true)
    expect(crowdLevel(row({ density: 3 }, STALE_MS / 1000 + 1), 'U_GATE_3', now)).toBe('unknown')
    expect(crowdLevel(undefined, 'U_GATE_3', now)).toBe('unknown')
    expect(crowdWords('unknown', 'ro')).toBe('Fără date')
    expect([people('free'), people('busy'), people('very'), people('unknown')]).toEqual([1, 2, 3, 0])
  })
  it('reads camera rows by alias and ignores Unity rows and blind cameras (D0)', () => {
    const flow = { security: row({ waitMin: 5 }), gate_3: row({ density: 1 }), U_CAFE: row({ source: 'twin' }), G_WC: row({ coverage: 0 }) }
    expect(rowFor(flow, 'U_SECURITY_QUEUE')).toBe(flow.security)
    expect(rowFor(flow, 'U_GATE_3')).toBe(flow.gate_3)
    expect(rowFor(flow, 'U_CAFE')).toBeUndefined()
    expect(rowFor(flow, 'G_WC')).toBeUndefined()
  })
  it('bands, trend and age labels', () => {
    expect([null, 2, 4, 10, 11, 25, 45].map(waitBand)).toEqual([null, '0–3 min', '4–10 min', '4–10 min', '11–20 min', '21–30 min', '>30 min'])
    expect(trend([40, 41, 42])).toBe('flat')
    expect(trend([40, 50])).toBe('up')
    expect(trend([40, 30])).toBe('down')
    expect(trend([2, 4])).toBe('flat')
    expect(ageLabel(12_000, 'ro')).toBe('12 s')
    expect(ageLabel(180_000, 'ro')).toBe('3 min')
  })
})

describe('label placement', () => {
  it('drops the lower icon on overlap and keeps labels off icons, other labels and obstacles', () => {
    const items = [
      { id: 'a', x: 100, y: 100, r: 10, w: 60, h: 16, rank: 90 },
      { id: 'b', x: 104, y: 102, r: 10, w: 60, h: 16, rank: 20 },
      { id: 'c', x: 100, y: 140, r: 10, w: 60, h: 16, rank: 50 },
      { id: 'off', x: 900, y: 100, r: 10, w: 60, h: 16, rank: 99 },
    ]
    const out = placeItems(items, [400, 400])
    expect(out.map(o => o.id).sort()).toEqual(['a', 'c'])
    const a = out.find(o => o.id === 'a')!.label!
    expect(a.anchor).toBe('start')
    expect(a.x).toBeGreaterThan(110)
    // An obstacle right of `a` pushes its label to the left.
    const blocked = placeItems(items.slice(0, 1), [400, 400], 4, 40, [[112, 80, 200, 120]])
    expect(blocked[0]!.label!.anchor).toBe('end')
  })
  it('keeps a forced (selected) item even when it collides', () => {
    const out = placeItems([{ id: 'a', x: 50, y: 50, r: 10, w: 40, h: 16, rank: 90 }, { id: 'sel', x: 52, y: 50, r: 10, w: 40, h: 16, rank: 1, force: true }], [200, 200])
    expect(out.map(o => o.id)).toContain('sel')
  })
})

describe('view and moving team', () => {
  const size: [number, number] = [390, 600]
  const bounds: [number, number, number, number] = [0, 0, 3000, 2000]
  it('zooms about a point and clamps to the building', () => {
    const v = fitView(bounds, size)
    const z = zoomAt(v, 2, size, 100, 100)
    expect(toMap(z, size, 100, 100).map(n => Math.round(n))).toEqual(toMap(v, size, 100, 100).map(n => Math.round(n)))
    const limits = limitsFor(bounds, size)
    const far = clampView({ cx: -5000, cy: 9000, s: limits.max * 3 }, size, limits)
    expect(far.s).toBe(limits.max)
    expect(far.cx).toBe(0)
    expect(far.cy).toBe(2000)
    // The sheet covers 300 px: the building may scroll that far up.
    expect(clampView({ cx: 0, cy: 9000, s: limits.max }, size, limits, 300).cy).toBeCloseTo(2000 + 300 / limits.max)
  })
  it('interpolates along the path and holds before arrival', () => {
    const path: [number, number][] = [[0, 0], [10, 0], [10, 10]]
    expect(along(path, 0).at).toEqual([0, 0])
    expect(along(path, 0.5).at).toEqual([10, 0])
    expect(along(path, 0.75).at).toEqual([10, 5])
    expect(along(path, 1).at).toEqual([10, 10])
    expect(along(path, 0.75).heading).toBeCloseTo(Math.PI / 2)
    const start = new Date(now - 60_000).toISOString()
    expect(teamProgress(start, 4, now)).toEqual({ t: 0.25, leftMin: 3 })
    expect(teamProgress(start, 0.5, now)!.t).toBe(0.95)
    expect(teamProgress(undefined, 4, now)).toBeNull()
    expect(teamProgress(start, null, now)).toBeNull()
  })
})

describe('you are here (D9)', () => {
  it('prefers the newest fresh pick, then the stage, then an old pick in grey', () => {
    expect(stagePlace('gate', '3')).toBe('U_GATE_3')
    expect(stagePlace('airside')).toBe('U_CORRIDOR_EAST')
    expect(stagePlace('public')).toBe('door_departures')
    expect(resolveHere({ picked: { id: 'U_CAFE', at: now - 60_000 }, told: { id: 'G_WC', ageSec: 30 }, stage: 'door_departures', now })).toEqual({ id: 'G_WC', source: 'whatsapp', fresh: true })
    expect(resolveHere({ picked: { id: 'U_CAFE', at: now - 10_000 }, told: { id: 'G_WC', ageSec: 30 }, stage: null, now })!.id).toBe('U_CAFE')
    expect(resolveHere({ picked: { id: 'U_CAFE', at: now - FRESH_MS - 1 }, stage: 'door_departures', now })).toEqual({ id: 'door_departures', source: 'stage', fresh: true })
    expect(resolveHere({ picked: { id: 'U_CAFE', at: now - FRESH_MS - 1 }, stage: null, now })).toEqual({ id: 'U_CAFE', source: 'picked', fresh: false })
    expect(resolveHere({ now })).toBeNull()
  })
})

describe('dispatch notices', () => {
  const ops: OpsRecord[] = [
    { id: '1', type: 'staff', zone: 'U_SECURITY_QUEUE', delta: 1, sentAt: '2026-11-01T12:10:00Z' },
    { id: '2', type: 'staff', zone: 'check_in:2', delta: -2, sentAt: '2026-11-01T12:11:00Z' },
    { id: '3', type: 'redirect', from: 'security', to: 'check_in:1', sentAt: '2026-11-01T12:12:00Z' },
    { id: '4', type: 'evacuate', zones: ['U_GATE_3'], sentAt: '2026-11-01T12:13:00Z' },
  ]
  it('keeps only decisions for the zone, newest first, as information', () => {
    const list = notices(ops, 'security', id => id === 'U_SECURITY_QUEUE' || id === 'security' ? 'securitate' : id, 'ro')
    expect(list.map(n => n.id)).toEqual(['3', '1'])
    expect(list[1]!.text).toBe('Dispeceratul a deschis o linie în plus la securitate')
    expect(list.every(n => !/trebuie|te rog|mergi/i.test(n.text))).toBe(true)
    expect(notices(ops, 'check_in:2', id => id, 'en')[0]!.text).toBe('Dispatch closed 2 lanes at check_in:2')
  })
})

describe('catalogue and routes', () => {
  const index = JSON.parse(readFileSync(new URL('../public/routes/index.json', import.meta.url), 'utf8')) as RouteIndex
  it('categorises and tiers all 90 landmarks', () => {
    expect(index.points).toHaveLength(90)
    expect(categoryOf('U_GATE_3')).toBe('gate')
    expect(categoryOf('atm_bcr')).toBe('atm')
    expect(categoryOf('door_emergency_east')).toBe('emergency')
    expect(categoryOf('kiosk_west')).toBe('food')
    expect(tierOf('U_GATE_3')).toBe(0)
    expect(tierOf('atm_bcr')).toBe(1)
    expect(tierOf('stairs_east_G')).toBe(2)
  })
  it('searches names and aliases without diacritics', () => {
    expect(search(index.points, 'poarta 3', 'ro')[0]!.id).toBe('U_GATE_3')
    expect(search(index.points, 'toaleta', 'ro').map(p => p.id)).toContain('G_WC')
    expect(search(index.points, 'bancomat', 'ro').map(p => p.id).sort()).toEqual(['atm_bcr', 'atm_euronet'])
    expect(search(index.points, '', 'ro')).toEqual([])
  })
  it('resolves backend ids and reads the same route as the WhatsApp picture', () => {
    expect(landmarkFor(index.points, 'security')!.id).toBe('U_SECURITY_QUEUE')
    expect(landmarkFor(index.points, 'gate_3')!.id).toBe('U_GATE_3')
    const r = routeBetween(index, 'door_departures', 'U_GATE_3', 'ro')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entry.file).toBe('/routes/door_departures__U_GATE_3.png')
    expect(r.path[0]!.id).toBe('door_departures')
    expect(r.path[r.path.length - 1]!.id).toBe('U_GATE_3')
    const changes = floorChanges(r.path, 'ro')
    expect(changes).toHaveLength(1)
    expect(changes[0]!.up).toBe(true)
    expect(changes[0]!.text).toMatch(/^Urci la etaj 1/)
    const back = routeBetween(index, 'U_GATE_3', 'door_departures', 'ro')
    expect(back.ok).toBe(false)
    if (!back.ok) expect(back.reason).toMatch(/securitate/)
  })
})

describe('chat channel', () => {
  it('dedupes by id, falls back to content without one', () => {
    const a: ChatEntry = { id: '1', role: 'user', text: 'Hi', at: '14:00', channel: 'whatsapp' }
    const b: ChatEntry = { role: 'clarion', text: 'Salut', at: '14:00', channel: 'web' }
    expect(mergeEntries([a], [a, b, { ...b }])).toEqual([a, b])
  })
  it('reconnects with growing delay and opens a person socket with the ticket', () => {
    expect(backoff(0, 0.5)).toBe(1000)
    expect(backoff(3, 0.5)).toBe(8000)
    expect(backoff(20, 0.5)).toBe(30000)
    const url = new URL(personSocketUrl('t-1', 'wss://example.test/ws?client=console&token=secret'))
    expect(url.pathname).toBe('/ws')
    expect(url.searchParams.get('client')).toBe('person')
    expect(url.searchParams.get('ticket')).toBe('t-1')
    expect(url.searchParams.has('token')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { breach, bulletScale, noActionWait, orderZones, taskState, topMetrics } from '../src/console/screen'
import type { FlowRow, SimSnapshot } from '../src/backend/sim'
import type { ZoneStat } from '../src/console/opsZones'
const row: FlowRow = { waiting: 80, capacity: null, waitMin: 8, peak: 80, updatedAt: '2026-11-01T10:00:00Z', source: 'vision', forecast: [{ inMin: 30, waitMin: 12 }, { inMin: 60, waitMin: 24 }] }
const zone = (id: string, waitMin = 8): ZoneStat => ({ id, name: id, kind: 'security', staffed: true, closed: false, people: 80, lanes: 2, waitMin, state: 'near', line: { numbers: '', action: null } })
const sim = { vision: true, simTime: 36000, flow: { security: row } } as SimSnapshot

describe('D28 bullet scales and stable urgency', () => {
  it('fits every marker, target and normal band on one scale', () => {
    expect(bulletScale(8, 10, row)).toEqual({ max: 24, wait: 8 / 24 * 100, target: 10 / 24 * 100, next30: 50, next60: 100 })
    expect(bulletScale(null, 10, null).wait).toBeNull()
    expect(bulletScale(45, 10, row).max).toBe(45)
  })
  it('does not invent missing horizons or use invalid numbers', () => {
    expect(bulletScale(5, 10, { ...row, forecast: [{ inMin: 48, waitMin: 18 }, { inMin: 30, waitMin: NaN }] }).next30).toBeNull()
  })
  it('ranks the earliest breach, then magnitude, with deterministic ties', () => {
    expect(breach(zone('security'), row)).toBe(30)
    const zones = [zone('security'), zone('b', 25), zone('a', 25)]
    expect(orderZones(zones, sim, 0).ids).toEqual(['a', 'b', 'security'])
  })
  it('sorts on the first camera observation instead of freezing the offline list', () => {
    const zones = [zone('security'), zone('b', 25)]
    const offline = orderZones(zones, null, 0)
    expect(orderZones(zones, sim, 1000, offline).ids).toEqual(['b', 'security'])
  })
  it('holds order for 75 seconds, appends newcomers and removes missing zones', () => {
    const first = orderZones([zone('security'), zone('b', 25)], sim, 0)
    const changed = [zone('security', 40), zone('b', 11), zone('new')]
    expect(orderZones(changed, sim, 74999, first).ids).toEqual(['b', 'security', 'new'])
    expect(orderZones(changed, sim, 75000, first).ids[0]).toBe('security')
    expect(orderZones([zone('security')], sim, 100, first).ids).toEqual(['security'])
  })
})
describe('D0 top band', () => {
  it('uses camera observations and exposes unavailable denominators', () => {
    expect(topMetrics([zone('security')], sim)).toEqual({ worst: 8, first: 37800, underTarget: null, flightsAtRisk: null, density: null })
    expect(topMetrics([], null).worst).toBeNull()
    expect(topMetrics([zone('security')], { ...sim, flow: { security: { ...row, density: 1.8 } } }).density).toBe(1.8)
    expect(topMetrics([zone('security')], { ...sim, vision: false }).density).toBeNull()
  })
})
describe('D30 camera evidence', () => {
  const command = { type: 'staff', zone: 'security', delta: 1 } as const
  const evidence = { before: row, simTime: 36000 }
  it('never equates ack or lane configuration to completion', () => {
    expect(taskState(command, 'sent', sim, evidence)).toBe('sent')
    expect(taskState(command, 'acked', sim, evidence)).toBe('acked')
    expect(taskState(command, 'acked', sim)).toBe('acked')
    expect(taskState(command, 'acked', sim, evidence, 'done')).toBe('done')
  })
  it('requires a later, fresh camera report and observed improvement', () => {
    const after = { ...sim, flow: { security: { ...row, waitMin: 5, updatedAt: '2026-11-01T10:01:00Z' } } }
    expect(taskState(command, 'acked', after, evidence)).toBe('done')
    expect(taskState(command, 'acked', { ...after, vision: false }, evidence)).toBe('acked')
    expect(taskState(command, 'acked', { ...after, flow: { security: { ...after.flow.security, stale: true } } }, evidence)).toBe('acked')
    expect(taskState({ type: 'close', zone: 'security' }, 'acked', after, evidence)).toBe('acked')
  })
  it('requires every evacuated zone to be empty in a new observation', () => {
    const evacuation = { type: 'evacuate', zones: ['security', 'other'] } as const
    const after = { ...sim, flow: { security: { ...row, waiting: 0, updatedAt: '2026-11-01T10:01:00Z' } } }
    expect(taskState({ ...evacuation, zones: [...evacuation.zones] }, 'acked', after, evidence)).toBe('acked')
    expect(taskState({ type: 'evacuate', zones: ['security'] }, 'acked', after, evidence)).toBe('done')
  })
  it('compares with the frozen no-action forecast only inside its horizon', () => {
    expect(noActionWait(evidence, 36000 + 30 * 60)).toBe(12)
    expect(noActionWait(evidence, 36000 + 45 * 60)).toBe(18)
    expect(noActionWait(evidence, 36000 + 61 * 60)).toBeNull()
    expect(noActionWait(undefined, 36000)).toBeNull()
  })
})

it('rejects explicit Unity flow even while cameras are online', async () => {
  const { liveRow } = await import('../src/console/opsZones')
  expect(liveRow({ ...sim, flow: { security: { ...row, source: 'twin' } } }, 'security')).toBeNull()
})

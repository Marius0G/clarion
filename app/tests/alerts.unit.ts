import { describe, expect, it, vi, afterEach } from 'vitest'
import { alertMapZone, alertNumbers, alertPresentation, sendAlertCommand, topZoneAlerts, toZoneAlert, type Alert } from '../src/console/alerts'

const alarm = (changes: Partial<Alert> = {}): Alert => ({ id: 'zone-target:U_SECURITY_QUEUE', priority: 'P2', kind: 'zone-target', zoneId: 'security', flight: null, text: 'Țintă depășită', numbers: { waitMin: 12, targetMin: 10 }, createdAt: 54000, updatedAt: 54000, state: 'unacked', active: true, adviceId: null, shelvedUntil: null, shelveReason: null, ...changes })
afterEach(() => vi.unstubAllGlobals())
describe('alert lifecycle presentation', () => {
  it.each(['P1', 'P2'] as const)('blinks only unacknowledged %s alarms', priority => {
    expect(alertPresentation(alarm({ priority }), 54000)).toMatchObject({ blink: true, needsAck: true, visible: true })
    expect(alertPresentation(alarm({ priority, state: 'acked' }), 54000)).toMatchObject({ blink: false, needsAck: false, visible: true })
  })
  it('keeps P3 steady and cleared alarms actionable until acknowledged', () => {
    expect(alertPresentation(alarm({ priority: 'P3' }), 54000).blink).toBe(false)
    expect(alertPresentation(alarm({ state: 'cleared-unacked', active: false }), 54000)).toMatchObject({ needsAck: true, visible: true, blink: true })
    expect(alertPresentation(alarm({ state: 'acked', active: false }), 54000).visible).toBe(false)
  })
  it('shows simulation seconds remaining without locally expiring shelves', () => {
    const a = alarm({ state: 'shelved', shelvedUntil: 54600, shelveReason: 'Verificare cameră' })
    expect(alertPresentation(a, 54001)).toMatchObject({ remainingSec: 599, blink: false, needsAck: false })
    expect(alertPresentation(a, 55000)).toMatchObject({ remainingSec: 0, label: 'Amânată' })
    expect(alertPresentation(a, null).remainingSec).toBeNull()
  })
})
describe('zone alarm adapter', () => {
  it('preserves priority with canonical map aliases', () => {
    expect(toZoneAlert(alarm())).toBe(2)
    expect(alertMapZone('security')).toBe('U_SECURITY_QUEUE')
    expect(alertMapZone('check_in:2')).toBe('G_CHECKIN_QUEUE')
    expect(alertMapZone('bag_drop:2')).toBe('G_CHECKIN_DESKS')
    expect(alertMapZone('gate_3')).toBe('U_GATE_3')
  })
  it('chooses the highest priority per shared zone, then unacknowledged, deterministically', () => {
    const p1 = alarm({ id: 'density', priority: 'P1', state: 'acked' })
    expect(topZoneAlerts([alarm(), p1])).toEqual({ U_SECURITY_QUEUE: 1 })
    expect(topZoneAlerts([p1, alarm({ priority: 'P1' })])).toEqual({ U_SECURITY_QUEUE: 1 })
    expect(topZoneAlerts([alarm({ state: 'acked', active: false }), alarm({ zoneId: null })])).toEqual({})
  })
  it('retains shelved and cleared-unacknowledged alarms and merges desk groups', () => {
    expect(topZoneAlerts([alarm({ zoneId: 'check_in:1', priority: 'P3', state: 'shelved' }), alarm({ zoneId: 'check_in:2', state: 'cleared-unacked', active: false })])).toEqual({ G_CHECKIN_QUEUE: 2 })
  })
  it('does not present inferred passenger counts as per-flight positions', () => {
    expect(alertNumbers(alarm({ kind: 'flight-risk', numbers: { estimatedBeforeSecurity: 90, minutesToClose: 8, waitMin: 12, estimated: 1 } }))).toBe('Închidere în 8 min · cozi 12 min')
  })
})
describe('alert commands', () => {
  it('posts the documented commands and returns the server snapshot', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ alerts: [alarm({ state: 'acked' })] }) })
    vi.stubGlobal('fetch', fetcher)
    expect((await sendAlertCommand({ type: 'ack', id: 'a' }))[0]!.state).toBe('acked')
    await sendAlertCommand({ type: 'shelve', id: 'a', durationSec: 600, reason: 'Verificare' })
    expect(fetcher.mock.calls.map(call => [new URL(call[0]).pathname, JSON.parse(call[1].body)])).toEqual([
      ['/api/alerts/command', { type: 'ack', id: 'a' }], ['/api/alerts/command', { type: 'shelve', id: 'a', durationSec: 600, reason: 'Verificare' }],
    ])
  })
  it('keeps failed commands actionable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    await expect(sendAlertCommand({ type: 'ack', id: 'a' })).rejects.toThrow('Acces refuzat')
  })
})

import { createElement } from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { waitBand } from '../src/me/Me'
import { ReportAttribution, reporterLabel, ReportList, stateLabel } from '../src/reports/Reports'
import Staff, { staffAlertLabel } from '../src/staff/Staff'
import { normalizePassenger } from '../src/me/format'

describe('personal pages', () => {
  it.each([[0, '0–3'], [3, '0–3'], [3.1, '4–10'], [4, '4–10'], [10, '4–10'], [10.1, '>10'], [11, '>10'], [null, '—']] as const)('bands %s minutes as %s', (n, band) => expect(waitBand(n)).toBe(band))
  it('normalizes timeline to 50 and discards unsafe route schemes', () => {
    const data = normalizePassenger({ routeImage: 'javascript:alert(1)', timeline: [...Array.from({ length: 55 }, (_, i) => ({ at: `${i}`, text: `Message ${i}` })), null] })
    expect(data.routeImage).toBeUndefined()
    expect(data.timeline).toHaveLength(50)
    expect(data.timeline![0].text).toBe('Message 5')
  })
  it('renders report state, landmark, priority and ETA in both languages', () => {
    const reports = [{ id: 'R1', at: '14:00', type: 'medical', source: 'staff' as const, priority: 'P1' as const, state: 'en_route' as const, text: 'Incident', place: { node: 'gate_2', name: 'Poarta 2' }, etaMin: 3 }]
    const ro = renderToStaticMarkup(ReportList({ reports }))
    expect(ro).toContain('Echipa vine'); expect(ro).toContain('Poarta 2'); expect(ro).toContain('· ~3 min')
    expect(renderToStaticMarkup(ReportList({ reports, en: true }))).toContain('Team en route')
    expect(['sent', 'taken', 'en_route', 'resolved'].map(s => stateLabel(s))).toEqual(['Neconfirmat', 'Confirmat', 'Echipa vine', 'Rezolvat'])
    expect(['sent', 'taken', 'en_route', 'resolved'].map(s => stateLabel(s, true))).toEqual(['Unconfirmed', 'Confirmed', 'Team en route', 'Resolved'])
    expect(renderToStaticMarkup(ReportList({ reports: [] }))).toContain('Niciun raport')
  })
  it('requires a session on staff page', () => {
    expect(renderToStaticMarkup(createElement(Staff))).toContain('Conectează-te cu WhatsApp')
  })
})

it('describes excess wait above target rather than the full wait', () => {
  const alert = { id: 'A1', priority: 'P2', text: 'Țintă depășită', kind: 'zone-target', zoneId: 'security', numbers: { waitMin: 22, targetMin: 10 } }
  expect(staffAlertLabel(alert, 'security')).toBe('Securitate · 12 min peste țintă')
  expect(staffAlertLabel(alert, 'security', true)).toBe('Security · 12 min over target')
  expect(staffAlertLabel({ ...alert, numbers: { waitMin: 5, targetMin: 10 } }, 'security')).toBe('Securitate · 0 min peste țintă')
  expect(staffAlertLabel({ id: 'A2', priority: 'P1', text: 'Evacuare' }, 'security')).toBe('Evacuare')
})

it('preserves only string crowd observations on passenger queue tiles', () => {
  const queues = normalizePassenger({ queues: [{ zone: 'security', staffCrowd: 'Personalul semnalează aglomerație la securitate.' }, { zone: 'check_in:1', staffCrowd: { text: 'invalid' } }] }).queues!
  expect(queues[0].staffCrowd).toBe('Personalul semnalează aglomerație la securitate.')
  expect(queues[1].staffCrowd).toBeUndefined()
})

it('attributes reporters and only renders valid confirmation times', () => {
  const report = { id: 'R1', at: '', type: 'medical', text: '', source: 'staff' as const, state: 'taken' as const, priority: 'P1' as const, place: { node: 'security', name: 'Securitate' }, isOwn: false, reporterRole: 'hall_agent' }
  expect(reporterLabel(report)).toBe('Agent hol')
  expect(reporterLabel({ ...report, isOwn: true })).toBe('Trimis de tine')
  expect(reporterLabel({ ...report, reporterRole: 'security_supervisor' })).toBe('Supervizor securitate')
  expect(reporterLabel({ ...report, reporterRole: 'passenger' }, true)).toBe('Passenger')
  const markup = renderToStaticMarkup(ReportAttribution({ report: { ...report, timestamps: { taken: '2026-11-01T12:30:00Z' } } }))
  expect(markup).toContain('Confirmat de dispecerat')
  expect(markup).toContain('dateTime="2026-11-01T12:30:00Z"')
  expect(renderToStaticMarkup(ReportAttribution({ report: { ...report, timestamps: { taken: 'invalid' } } }))).not.toContain('dispecerat')
})

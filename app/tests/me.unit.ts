import { describe, expect, it } from 'vitest'
import { normalizePassenger, simTimeLabel, statusLabel } from '../src/me/format'

describe('passenger formatting', () => {
  it.each([
    [0, '00:00'], [59, '00:00'], [60, '00:01'], [14 * 3600 + 20 * 60, '14:20'],
    [86399, '23:59'], [86400, '00:00'], [null, 'necunoscut'],
    [undefined, 'necunoscut'], [NaN, 'necunoscut'], [Infinity, 'necunoscut'], [-1, 'necunoscut'],
  ])('formats simulation seconds %s as %s', (seconds, label) => {
    expect(simTimeLabel(seconds)).toBe(label)
  })

  it('translates every flight status and handles missing delay/status', () => {
    expect(statusLabel('scheduled')).toBe('Programat')
    expect(statusLabel('boarding')).toBe('Îmbarcare')
    expect(statusLabel('delayed', 25)).toBe('Întârziat +25 min')
    expect(statusLabel('delayed', 0)).toBe('Întârziat +0 min')
    expect(statusLabel('delayed')).toBe('Întârziat')
    expect(statusLabel('delayed', -1)).toBe('Întârziat')
    expect(statusLabel('cancelled')).toBe('Anulat')
    expect(statusLabel('departed')).toBe('Plecat')
    expect(statusLabel()).toBe('necunoscut')
  })

  it('keeps missing fields unknown and tolerates malformed collections', () => {
    expect(normalizePassenger(null).arriveBy).toBe('necunoscut')
    expect(normalizePassenger(null).entranceToGateMin).toBeNull()
    const forecast = normalizePassenger({ entranceToGateMin: -1, queues: [null, { nowMin: -1, forecastMin: Infinity }] })
    expect(forecast.entranceToGateMin).toBeNull()
    expect(forecast.queues?.every(q => q.nowMin === null && q.forecastMin === null)).toBe(true)
    const data = normalizePassenger({ flight: null, steps: [null, { waitMin: -3 }], alerts: [null], evacuation: { active: true, zones: [null, 'security'] } })
    expect(data.flight.gate).toBe('necunoscut')
    expect(data.flight.status).toBeUndefined()
    expect(data.steps.every(step => step.waitMin === null)).toBe(true)
    expect(data.evacuation.zones).toEqual(['security'])
    expect(normalizePassenger({ steps: {}, alerts: null }).steps).toEqual([])
  })
})

it('defaults absent/invalid language to Romanian and keeps missing English data in English', () => {
  expect(normalizePassenger({}).lang).toBe('ro')
  expect(normalizePassenger({ lang: 'fr' }).lang).toBe('ro')
  expect(normalizePassenger({ lang: 'en' })).toMatchObject({ lang: 'en', flight: { gate: 'unknown' } })
  expect(statusLabel('delayed', 15, 'en')).toBe('Delayed +15 min')
})

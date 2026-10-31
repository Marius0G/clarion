import { it, expect } from 'vitest'
import { flowState, liveFlow, worstFull } from '../src/console/flow'
import type { SimSnapshot } from '../src/backend/sim'

it('classifies queues at the 0.8 and 1.0 load boundaries', () => {
  expect(flowState(79, 100)).toBe('normal')
  expect(flowState(80, 100)).toBe('near')
  expect(flowState(100, 100)).toBe('near')
  expect(flowState(101, 100)).toBe('full')
  expect(flowState(0, 10)).toBe('normal')
})

it('gives no state without a capacity', () => {
  expect(flowState(500, null)).toBeNull()
})

it('picks the worst full zone and counts the rest', () => {
  const row = (waiting: number, capacity: number | null) => ({ waiting, capacity, waitMin: null, peak: waiting, updatedAt: '' })
  expect(worstFull({ security: row(140, 60), check_in: row(130, 100), kerb: row(100, 40), taxi_rank: row(500, null) })).toMatchObject({ zone: 'kerb', others: 2 })
  expect(worstFull({ security: row(60, 60) })).toBeNull()
})

it('shows flow only from a connected sim with rows', () => {
  const sim = { connected: true, flow: { kerb: { waiting: 1, capacity: 2, waitMin: null, peak: 1, updatedAt: '' } } } as unknown as SimSnapshot
  expect(liveFlow(sim)).not.toBeNull()
  expect(liveFlow({ ...sim, connected: false })).toBeNull()
  expect(liveFlow({ ...sim, flow: {} })).toBeNull()
  expect(liveFlow(null)).toBeNull()
})

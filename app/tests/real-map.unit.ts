import { it, expect } from 'vitest'
import { realPlan, zones, points, frames, worldToPx, floorAssets } from '../src/console/terminal'
import { loadState, zoneStats } from '../src/console/opsZones'
it('exports the real map contract and SVG assets for TerminalMap without changing rendering', () => {
  expect(zones).toHaveLength(52)
  expect(points.length).toBeGreaterThan(100)
  expect(realPlan.realMap).toBe(true)
  expect(frames.parter.level).toBe('G')
  expect(worldToPx(6161, -441, 'G')).toEqual([10, 10])
  expect(Object.keys(floorAssets)).toEqual(['G', 'U', 'X'])
  expect(loadState('U_SECURITY_QUEUE', { waiting: 10, waitMin: 21, stale: false } as never)).toBe('full')
  expect(zoneStats(realPlan, null)).toHaveLength(52)
})

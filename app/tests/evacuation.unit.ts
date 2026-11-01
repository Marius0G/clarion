import { describe, expect, it } from 'vitest'
import indexData from '../public/routes/index.json'
import { fixture } from '../src/me/fixture'
import { evacuationDraw } from '../src/map/live/evacuation'
import { floorRuns } from '../src/map/live/team'
import type { RouteIndex } from '../src/map/live/catalogue'
import { terminalGraph } from '../../backend/src/terminal'

const index = indexData as RouteIndex
const data = { ...fixture, routeImage: '/routes/evac/current.png', assembly: 'ASSEMBLY_LANDSIDE_EAST',
  evacuation: { active: true, zones: ['security', 'G_WEST'], route: { exit: 'Ieșire de urgență (est)', steps: ['Coadă securitate', 'Ieșire de urgență (est)'] } } }

describe('passenger evacuation routing', () => {
  it('routes from here through the named exit to assembly, avoiding closed zones and splitting floors', () => {
    const draw = evacuationDraw(index, data, 'U_SECURITY_QUEUE', ['G_CENTER'], 'ro')!
    expect(draw).not.toBeNull()
    expect(draw.path[0]!.id).toBe('U_SECURITY_QUEUE')
    expect(draw.path.at(-1)!.id).toBe(data.assembly)
    expect(draw.path.map(n => n.id)).toContain('door_emergency_east')
    expect(draw.path.map(n => n.id)).not.toContain('G_WEST')
    expect(draw.path.map(n => n.id)).not.toContain('G_CENTER')
    expect(draw.changes.length).toBeGreaterThan(0)
    expect(floorRuns(draw.path).length).toBeGreaterThan(1)
    for (const run of floorRuns(draw.path)) expect(new Set(run.map(n => n.level === 'U')).size).toBe(1)
    for (let i = 1; i < draw.path.length; i++) {
      const a = draw.path[i - 1]!.id, b = draw.path[i]!.id
      expect(terminalGraph.edges.some(e => e.from === a && e.to === b || !e.oneWay && e.from === b && e.to === a)).toBe(true)
    }
  })
  it('avoids a jammed zone using the same live crowding as the backend planner', () => {
    const free = evacuationDraw(index, data, 'U_SECURITY_QUEUE', ['G_CENTER'], 'ro')!
    const zoneOf = (id: string) => terminalGraph.nodes.find(n => n.id === id)?.zone
    const jammed = free.path.slice(1, -2).map(n => zoneOf(n.id)).find(z => z && z !== 'U_SECURITY_QUEUE' && z.startsWith('U_') || z?.startsWith('G_'))!
    expect(jammed).toBeTruthy()
    const draw = evacuationDraw(index, data, 'U_SECURITY_QUEUE', ['G_CENTER'], 'ro', { [jammed]: { waiting: 5000, density: 9 } })
    expect(draw === null || draw.path.map(n => n.id).join() !== free.path.map(n => n.id).join()).toBe(true)
  })
  it('uses named steps if no position is known and supports an absolute preview URL', () => {
    const draw = evacuationDraw(index, { ...data, routeImage: 'https://airport.test/routes/evac/current.png' }, null, [], 'en')!
    expect(draw.path[0]!.id).toBe('U_SECURITY_QUEUE')
    expect(draw.exit?.id).toBe('door_emergency_east')
  })
  it('never draws an unchecked line when the exit or assembly is blocked', () => {
    expect(evacuationDraw(index, data, 'U_SECURITY_QUEUE', ['door_emergency_east'], 'ro')).toBeNull()
    expect(evacuationDraw(index, data, 'U_SECURITY_QUEUE', [data.assembly], 'ro')).toBeNull()
  })
  it('does not replace an unknown assigned exit with the static preview exit', () => {
    expect(evacuationDraw(index, { ...data, evacuation: { ...data.evacuation, route: { exit: 'Unknown exit', steps: [] } } }, 'U_SECURITY_QUEUE', [], 'ro')).toBeNull()
  })
  it('uses the current place ahead of the preview origin', () => {
    const draw = evacuationDraw(index, { ...data, routeImage: '/routes/evac/U_SECURITY_QUEUE.png' }, 'G_INFO', [], 'ro')!
    expect(draw.path[0]!.id).toBe('G_INFO')
    expect(draw.exit?.id).toBe('door_emergency_east')
  })
})

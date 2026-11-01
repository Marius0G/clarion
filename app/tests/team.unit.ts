import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { terminalGraph } from '../../backend/src/terminal'
import { floorChanges, routeBetween, type PathNode, type RouteIndex } from '../src/map/live/catalogue'
import { dispatchPath, floorRuns, remainingRoute } from '../src/map/live/team'
import { teamMark } from '../src/map/live/LiveMap'

const index = JSON.parse(readFileSync(new URL('../public/routes/index.json', import.meta.url), 'utf8')) as RouteIndex
const path = dispatchPath(index.points, 'gate_3')
const length = (p: readonly PathNode[]) => floorRuns(p).reduce((sum, run) => sum + run.slice(1).reduce((s, n, i) => s + Math.hypot(n.x - run[i]!.x, n.z - run[i]!.z), 0), 0)

describe('dispatch routing', () => {
  it('uses the passenger PNG route and only adjacent graph nodes', () => {
    const passenger = routeBetween(index, 'G_INFO', 'U_GATE_3', 'ro')
    expect(passenger.ok).toBe(true)
    if (!passenger.ok) throw new Error('Missing passenger route')
    expect(path.map(n => n.id)).toEqual(passenger.path.map(n => n.id))
    expect(path.length).toBeGreaterThan(2)
    for (const [i, b] of path.slice(1).entries()) {
      const a = path[i]!
      expect(terminalGraph.edges.some(e => !e.evacuationOnly && (e.from === a.id && e.to === b.id || !e.oneWay && e.from === b.id && e.to === a.id))).toBe(true)
    }
  })

  it('routes to graph nodes missing from the passenger picture destinations', () => {
    const p = dispatchPath(index.points, 'U_SECURITY_QUEUE')
    expect(p[0]!.id).toBe('G_INFO')
    expect(p.at(-1)!.id).toBe('U_SECURITY_QUEUE')
  })

  it('avoids blocked zones and never falls back to a direct line', () => {
    expect(dispatchPath(index.points, 'gate_3', ['security'])).toEqual([])
    const p = dispatchPath(index.points, 'gate_3', ['U_CAFE'])
    expect(p.length).toBeGreaterThan(1)
    expect(p.some(n => n.id === 'U_CAFE')).toBe(false)
    expect(dispatchPath(index.points, 'missing')).toEqual([])
    expect(teamMark([], 0.5, 'Echipa', 'U', 'R2', 'ro')).toBeNull()
  })

  it('shrinks the remaining route from the marker and keeps its destination', () => {
    const lengths = [0, 0.2, 0.5, 0.8, 1].map(t => {
      const remaining = remainingRoute(path, t)!
      expect(remaining.path[0]).toEqual(remaining.at)
      expect(remaining.path.at(-1)).toEqual(path.at(-1))
      return length(remaining.path)
    })
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeLessThan(lengths[i - 1]!)
    expect(lengths.at(-1)).toBe(0)
  })

  it('splits both floors and keeps the connector arrows until the crossing is complete', () => {
    const p: PathNode[] = [
      { id: 'start', level: 'G', x: 0, z: 0 }, { id: 'stairs_G', level: 'G', x: 10, z: 0 },
      { id: 'stairs_U', level: 'U', x: 10, z: 0 }, { id: 'end', level: 'U', x: 20, z: 0 },
    ]
    expect(floorRuns(p).map(run => run.map(n => n.level))).toEqual([['G', 'G'], ['U', 'U']])
    const crossing = remainingRoute(p, 0.5)!
    expect(crossing.at).toEqual(p[1])
    expect(floorChanges(crossing.path, 'ro')[0]!.text).toContain('pe scări')
    const upstairs = remainingRoute(p, 0.9)!
    expect(upstairs.at.level).toBe('U')
    expect(floorChanges(upstairs.path, 'ro')).toEqual([])
    for (const t of [0.1, 0.5, 0.9]) {
      const r = remainingRoute(p, t)!
      expect(floorRuns(r.path).every(run => run.every(n => n.level === run[0]!.level))).toBe(true)
    }
  })

  it('turns the marker with the current corridor segment', () => {
    const p: PathNode[] = [{ id: 'a', level: 'G', x: 0, z: 0 }, { id: 'b', level: 'G', x: 10, z: 0 }, { id: 'c', level: 'G', x: 10, z: 10 }]
    const a = teamMark(p, 0.25, 'Echipa · ~3 min', 'G', 'R2', 'ro')!
    const b = teamMark(p, 0.75, a.label, 'G', 'R2', 'ro')!
    expect(a.at).toMatchObject({ x: 5, z: 0 })
    expect(b.at).toMatchObject({ x: 10, z: 5 })
    expect(Math.abs(a.heading - b.heading)).toBeCloseTo(Math.PI / 2)
    expect(b.label).toBe(a.label)
  })
})

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** public/routes/index.json and the pictures it names (scripts/routes/render.ts). */
const root = join(__dirname, '../public')
const index = JSON.parse(readFileSync(join(root, 'routes/index.json'), 'utf8')) as {
  points: { id: string; name: { ro: string; en: string }; aliases: string[] }[]
  routes: Record<string, { file: string; walkSec: number; steps: { node: string; name: { ro: string; en: string }; level: string; sec: number }[] }>
  evac: Record<string, { file: string; exit: string; assembly: string; walkSec: number; steps: { node: string }[] }>
  skipped: { from: string; to: string; reason: string }[]
  skipReasons: Record<string, string>
}
const ids = new Set(index.points.map(p => p.id))
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

describe('route index', () => {
  it('names every point in both languages, with aliases', () => {
    expect(index.points.length).toBeGreaterThanOrEqual(25)
    expect(ids.size).toBe(index.points.length)
    for (const p of index.points) {
      expect(p.name.ro && p.name.en).toBeTruthy()
      expect(p.aliases.length).toBeGreaterThan(0)
      for (const a of p.aliases) expect(a).toBe(a.toLowerCase())
    }
  })

  it('routes only between known points, and every picture exists as a small PNG', () => {
    for (const [key, r] of Object.entries(index.routes)) {
      const [from, to] = key.split('__')
      expect(ids.has(from!), from).toBe(true)
      expect(ids.has(to!), to).toBe(true)
      expect(r.steps[0]!.node).toBe(from)
      expect(r.steps[r.steps.length - 1]!.node).toBe(to)
      expect(r.walkSec).toBeGreaterThan(0)
      const file = join(root, r.file)
      expect(existsSync(file), r.file).toBe(true)
      expect(readFileSync(file).subarray(0, 8).equals(PNG)).toBe(true)
      expect(statSync(file).size).toBeLessThan(150_000)
    }
  })

  it('covers every ordered pair exactly once, as a route or as a skip with a known reason', () => {
    const n = index.points.length
    expect(Object.keys(index.routes).length + index.skipped.length).toBe(n * (n - 1))
    for (const s of index.skipped) {
      expect(index.skipReasons[s.reason], s.reason).toBeTruthy()
      expect(index.routes[`${s.from}__${s.to}`]).toBeUndefined()
    }
  })

  it('has a way out from every zone, ending at an exit with an assembly point', () => {
    expect(Object.keys(index.evac).length).toBeGreaterThanOrEqual(30)
    for (const [zone, e] of Object.entries(index.evac)) {
      expect(e.steps[0]!.node).toBe(zone)
      expect(e.steps[e.steps.length - 1]!.node).toBe(e.exit)
      expect(e.assembly).toMatch(/^ASSEMBLY_/)
      expect(existsSync(join(root, e.file)), e.file).toBe(true)
    }
  })

  it('stays under 40 MB in total', () => {
    const files = [...Object.values(index.routes), ...Object.values(index.evac)].map(r => statSync(join(root, r.file)).size)
    expect(files.reduce((a, b) => a + b, 0)).toBeLessThan(40e6)
  })
})

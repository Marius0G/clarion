import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** public/routes/index.json and the pictures it names (scripts/routes/render.ts). */
const root = join(__dirname, '../public')
const index = JSON.parse(readFileSync(join(root, 'routes/index.json'), 'utf8')) as {
  origins: string[]
  destinations: string[]
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
    expect(index.points.length).toBe(90)
    expect(index.origins).toEqual(index.points.map(p => p.id))
    expect(new Set(index.destinations).size).toBe(index.destinations.length)
    for (const id of index.destinations) {
      expect(ids.has(id), id).toBe(true)
      expect(id).not.toMatch(/stairs|escalator|lift|emergency|ASSEMBLY|G_GATE_DOOR|shop_offices|shop_glazed|shop_frosted/)
    }
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
      expect(index.destinations).toContain(to)
      expect(r.steps[0]!.node).toBe(from)
      expect(r.steps[r.steps.length - 1]!.node).toBe(to)
      expect(r.walkSec).toBeGreaterThan(0)
      const file = join(root, r.file)
      expect(existsSync(file), r.file).toBe(true)
      expect(readFileSync(file).subarray(0, 8).equals(PNG)).toBe(true)
      expect(statSync(file).size).toBeLessThan(150_000)
    }
  })

  it('covers every origin/passenger-destination pair exactly once, as a route or as a skip with a known reason', () => {
    expect(Object.keys(index.routes).length + index.skipped.length).toBe(index.origins.length * index.destinations.length - index.destinations.length)
    const skips = new Set(index.skipped.map(s => `${s.from}__${s.to}`))
    expect(skips.size).toBe(index.skipped.length)
    for (const from of index.origins) for (const to of index.destinations) {
      if (from === to) continue
      expect(Number(Boolean(index.routes[`${from}__${to}`])) + Number(skips.has(`${from}__${to}`))).toBe(1)
    }
    for (const s of index.skipped) {
      expect(index.origins).toContain(s.from)
      expect(index.destinations).toContain(s.to)
      expect(s.from).not.toBe(s.to)
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

  it('has only indexed pictures, all 1080px wide and below 150 KB, under 90 MB including index', () => {
    const folder = join(root, 'routes')
    const files = readdirSync(folder, { recursive: true }).map(String).filter(f => statSync(join(folder, f)).isFile())
    const expected = [...Object.values(index.routes), ...Object.values(index.evac)].map(r => r.file.replace('/routes/', ''))
    expect(files.sort()).toEqual([...expected, 'index.json'].sort())
    let total = 0
    for (const file of files) {
      const bytes = readFileSync(join(folder, file))
      total += bytes.length
      if (file === 'index.json') continue
      expect(bytes.subarray(0, 8).equals(PNG), file).toBe(true)
      expect(bytes.readUInt32BE(16), file).toBe(1080)
      expect(bytes.length, file).toBeLessThan(150_000)
    }
    expect(total).toBeLessThan(90e6)
  })
})

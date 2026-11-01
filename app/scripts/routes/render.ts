/**
 * Pre-renders the route pictures sent on WhatsApp: every allowed pair of landmarks and the way out
 * of every zone during an evacuation, on the flat two-floor T2 map (D27/D29).
 *
 *   cd app && ../backend/node_modules/.bin/tsx scripts/routes/render.ts [--only from__to,...] [--limit N]
 *
 * Writes public/routes/<from>__<to>.png, public/routes/evac/<zone>.png and public/routes/index.json.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { terminalGraph } from '../../../backend/src/terminal.ts'
import { landmarks } from './landmarks.ts'
import { landmarkCoverage } from '../../../backend/src/landmarks.ts'
import { destinationIds, evacCaption, nameOf, planEvacuations, planRoutes, skipReasons } from './plan.ts'
import { toIndexedPng } from './png.ts'
import type { RouteSpec } from '../../src/map/t2/routeSpec.ts'

declare global { interface Window { __route?: (spec: RouteSpec) => void } }

const app = join(dirname(fileURLToPath(import.meta.url)), '../..')
const out = join(app, 'public/routes')
const args = process.argv.slice(2)
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1]!.split(',')) : null
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity
const indexOnly = args.includes('--index-only')
const PORT = 4198
const COLOURS = 16
/** D29 colours that must survive the palette: P1 red, route navy, white, ink. */
const KEEP = [0xd40000, 0x0e2f57, 0xffffff, 0x161616]

/** File-safe key: `check_in:1` → `check_in-1`. */
export const fileKey = (id: string) => id.replace(/:/g, '-')
const nodes = new Map(terminalGraph.nodes.map(n => [n.id, n]))
const zoneOf = (id: string) => nodes.get(landmarks.find(l => l.id === id)?.graphNode ?? id)?.zone ?? null
const viaOf = (id: string) => (['escalator', 'stairs', 'lift'] as const).find(k => id.startsWith(k) || id.includes(`_${k}`))

const { routes, skipped } = planRoutes()
const evacs = planEvacuations()
const assemblies = new Map(terminalGraph.nodes.filter(n => n.id.startsWith('ASSEMBLY_')).map(n => [n.id, n]))

type Job = { spec: RouteSpec; file: string }
const jobs: Job[] = []
for (const r of routes) {
  const key = `${r.from}__${r.to}`
  jobs.push({ file: `${fileKey(r.from)}__${fileKey(r.to)}.png`, spec: {
    id: key, kind: 'route', from: nameOf(r.from).ro, to: nameOf(r.to).ro, walkSec: r.walkSec,
    path: r.path.map(p => ({ ...p, ...(viaOf(p.id) && { via: viaOf(p.id) }) })), fromZone: zoneOf(r.from), toZone: zoneOf(r.to),
  } })
}
for (const e of evacs) {
  const a = assemblies.get(e.assembly)!
  jobs.push({ file: `evac/${fileKey(e.zone)}.png`, spec: {
    id: `evac:${e.zone}`, kind: 'evac', from: nameOf(e.zone).ro, to: nameOf(e.exit).ro, walkSec: e.walkSec,
    path: e.path, fromZone: e.zone, toZone: null, assembly: { name: nameOf(e.assembly).ro, x: a.x, z: a.y }, caption: evacCaption(e.exit, e.assembly),
  } })
}
const todo = jobs.filter(j => !only || only.has(j.spec.id)).slice(0, limit)

async function waitFor(url: string, ms = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if ((await fetch(url)).ok) return } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 300)) }
  throw new Error(`${url} did not start`)
}

if (!indexOnly) {
const vite = spawn(join(app, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: app, stdio: 'ignore' })
try {
  await waitFor(`http://127.0.0.1:${PORT}/harta/ruta`)
  const browser = await chromium.launch()
  if (!only) rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'evac'), { recursive: true })
  let bytes = 0, n = 0, next = 0
  // Independent cards share one browser; four pages avoid serial screenshot round trips.
  await Promise.all(Array.from({ length: 4 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1400 }, deviceScaleFactor: 1 })
    await page.goto(`http://127.0.0.1:${PORT}/harta/ruta`)
    await page.waitForFunction(() => typeof window.__route === 'function')
    for (;;) {
      const job = todo[next++]
      if (!job) break
      await page.evaluate(spec => { delete document.body.dataset.ready; window.__route!(spec) }, job.spec)
      await page.waitForFunction(id => document.body.dataset.ready === id, job.spec.id)
      // Verify actual browser text geometry, including origins at a floor transition.
      await page.evaluate(() => {
        const start = document.querySelector('.r-start')!.getBoundingClientRect()
        for (const tag of document.querySelectorAll('.r-floor .r-tag, .r-end .r-tag')) {
          const b = tag.getBoundingClientRect()
          if (b.left < start.right && b.right > start.left && b.top < start.bottom && b.bottom > start.top)
            throw new Error('Step/destination label overlaps Ești aici marker')
        }
      })
      const png = toIndexedPng(await page.locator('#route-card').screenshot({ animations: 'disabled' }), COLOURS, KEEP)
      if (png.length >= 150_000) throw new Error(`${job.file} exceeds 150 KB: ${png.length} bytes`)
      writeFileSync(join(out, job.file), png)
      bytes += png.length
      if (++n % 100 === 0) console.log(`${n}/${todo.length} · ${(bytes / 1e6).toFixed(1)} MB`)
    }
    await page.close()
  }))
  await browser.close()
  console.log(`${n} pictures · ${(bytes / 1e6).toFixed(1)} MB · ${n ? Math.round(bytes / n / 1000) : 0} KB average`)
} finally {
  vite.kill()
}
}

if (!only && (indexOnly || todo.length === jobs.length)) {
  const fileOf = new Map(jobs.map(j => [j.spec.id, `/routes/${j.file}`]))
  const index = {
    about: 'T2 route pictures. Routes come from backend route() on terminalGraph at free flow (no density, nothing blocked), evacuations from backend evacuationRoute(); a live route can differ when queues are dense.',
    graph: terminalGraph.version,
    points: landmarks,
    origins: landmarks.map(l => l.id),
    destinations: destinationIds,
    coverage: landmarkCoverage,
    routes: Object.fromEntries(routes.map(r => [`${r.from}__${r.to}`, { file: fileOf.get(`${r.from}__${r.to}`)!, walkSec: r.walkSec, steps: r.steps }])),
    evac: Object.fromEntries(evacs.map(e => [e.zone, { file: fileOf.get(`evac:${e.zone}`)!, exit: e.exit, assembly: e.assembly, caption: evacCaption(e.exit, e.assembly), walkSec: e.walkSec, steps: e.steps }])),
    skipped: skipped.map(s => ({ ...s })),
    skipReasons,
  }
  writeFileSync(join(out, 'index.json'), JSON.stringify(index) + '\n')
  const total = jobs.reduce((s, j) => s + statSync(join(out, j.file)).size, 0)
  if (total + statSync(join(out, 'index.json')).size >= 90e6) throw new Error('Route assets including index exceed 90 MB')
  console.log(`index.json: ${landmarks.length} points, ${routes.length} routes, ${skipped.length} skipped, ${evacs.length} evacuations · ${(total / 1e6).toFixed(1)} MB`)
}

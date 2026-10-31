import { test, expect, type Page, type Route } from '@playwright/test'
import { zones as mapZones } from '../src/map/t2/data'

// D16 admin screen. GET /api/sim, GET /api/reports and POST /api/ops/command are mocked; no WebSocket is needed.
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' }
const row = (waiting: number, waitMin: number | null, extra = {}) => ({ waiting, waitMin, capacity: null, staff: null, coverage: 0.8, forecast: null, peak: waiting, updatedAt: '2026-10-31T12:00:00Z', stale: false, source: 'vision', ...extra })
const empty = { connected: false, vision: false, lastSeen: null, run: { scenario: null, arm: null, coverage: null, seed: null }, simTime: null, speed: null, counts: {}, actions: {}, phones: { unknown: 0, notified: 0, read: 0, acting: 0 }, metrics: {}, flow: {}, flights: [], flightsAt: null, positions: null, ops: [], blocked: [], lanes: { 'check_in:1': 2, 'bag_drop:1': 1, 'check_in:2': 2, 'bag_drop:2': 1, security: 2 }, truth: null }

/** Deterministic dots spread inside the zones the cameras see. Vision sends no kind. */
function crowd(counts: Record<string, number>) {
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  return mapZones.flatMap(zone => Array.from({ length: counts[zone.id] ?? 0 }, () => {
    const x = zone.centre[0] + (rnd() - 0.5) * 3, z = zone.centre[1] + (rnd() - 0.5) * 3
    return { x, y: z, z, level: zone.level }
  }))
}
const live = {
  ...empty, connected: true, vision: true, simTime: 13 * 3600 + 42 * 60 + 10, run: { scenario: 'terminal', arm: 'B', coverage: 0.5, seed: 1 },
  flow: {
    'check_in:1': row(46, 30), 'check_in:2': row(12, 4), 'bag_drop:2': row(5, 2, { stale: true }),
    security: row(88, 6, { forecast: [{ inMin: 48, waitMin: 18 }], advice: { lanes: 3, by: 50700, waitMinIfNot: 18 } }), gate_1: row(32, null, { density: 1 }), gate_2: row(10, null, { density: 2.1 }), gate_3: row(5, null, { density: 0.5 }),
  },
  positions: { at: '2026-10-31T12:00:00Z', people: crowd({ G_CHECKIN_QUEUE: 58, U_SECURITY_QUEUE: 88, U_GATE_1: 32 }) },
  truth: { at: '2026-10-31T12:00:00Z', zones: { security: { waiting: 93, waitMin: 15.5 }, 'check_in:1': { waiting: 44, waitMin: 20 }, 'bag_drop:1': { waiting: 9, waitMin: 4 } } },
}
const reports = [
  { id: 'r1', at: '2026-10-31T12:00:00Z', kind: 'bagaj', node: 'gate_3', text: 'Bagaj abandonat la poarta 3', status: 'open' },
  { id: 'r2', at: '2026-10-31T11:00:00Z', kind: 'bataie', node: 'security', text: 'Închis', status: 'closed' },
]

async function mock(page: Page, sim: () => unknown, command?: (route: Route, body: Record<string, unknown>) => Promise<void>, staffReports?: unknown[]) {
  await page.route(/\/api\/sim$/, route => route.fulfill({ json: sim(), headers: cors }))
  await page.route(/\/api\/reports$/, route => staffReports ? route.fulfill({ json: staffReports, headers: cors }) : route.fulfill({ status: 404, json: { error: 'Not found' }, headers: cors }))
  await page.route(/\/api\/ops\/command$/, async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (command) await command(route, route.request().postDataJSON())
  })
}

test('offline console exposes five metrics and unknown zones', async ({ page }) => {
  await mock(page, () => empty)
  await page.goto('/')
  await expect(page.getByTestId('top-band').locator(':scope > div')).toHaveCount(5)
  await expect(page.getByTestId('top-band').getByRole('button')).toHaveCount(0)
  await expect(page.getByTestId('row-U_SECURITY_QUEUE')).toContainText('Necunoscut')
  await expect(page.getByTestId('alerts-slot')).toContainText('D32')
  await expect(page.getByTestId('alerts-log-slot')).toContainText('D32')
  await expect(page.getByTestId('journal')).toContainText('Nicio înregistrare')
})
test('camera metrics, bullet rows, FIDS and unified staff log', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await mock(page, () => ({ ...live, flights: [{ flight: 'W4 3751', destination: 'Roma', std: 54000, gate: 'G2', status: 'delayed', delayMin: 20 }] }), undefined, reports)
  await page.goto('/')
  await expect(page.getByTestId('top-band')).toContainText('30 min')
  await expect(page.getByTestId('top-band')).toContainText('2.1 /m²')
  await expect(page.getByTestId('row-U_SECURITY_QUEUE').getByRole('img')).toHaveAttribute('aria-label', /țintă 10 min/)
  await expect(page.getByTestId('row-U_SECURITY_QUEUE')).toContainText('14:30')
  await expect(page.getByRole('table').first()).toContainText('Roma')
  await expect(page.getByTestId('journal')).toContainText('Bagaj abandonat')
  await expect(page.getByTestId('journal').locator('.unacknowledged')).toHaveCount(1)
  await page.screenshot({ path: 'test-results/console-v2-desktop.png' })
  expect(errors).toEqual([])
})
test('map and list share hover and click selection', async ({ page }) => {
  await mock(page, () => live)
  await page.goto('/')
  await page.getByTestId('row-U_SECURITY_QUEUE').hover()
  await expect(page.getByTestId('zone-U_SECURITY_QUEUE')).toHaveClass(/sel/)
  await page.getByTestId('row-U_SECURITY_QUEUE').click()
  await expect(page.getByTestId('zone-panel')).toContainText('Coadă securitate')
  await page.getByTestId('zone-U_GATE_1').dispatchEvent('mouseover')
  await expect(page.getByTestId('row-U_GATE_1')).toHaveClass(/sel/)
  await page.getByTestId('zone-U_GATE_1').dispatchEvent('click')
  await expect(page.getByTestId('zone-panel')).toContainText('Poarta 1')
})
test('recommendation sends unchanged command and tracks ack then camera effect', async ({ page }) => {
  let sim = { ...live, flow: { security: row(88, 12, { forecast: [{ inMin: 30, waitMin: 18 }], advice: { lanes: 3, by: 50700, waitMin: 7, waitMinIfNot: 18 } }) }, ops: [] as Record<string, unknown>[] }
  const posted: Record<string, unknown>[] = []
  await mock(page, () => sim, async (route, body) => {
    posted.push(body)
    const command = { ...body, id: 'op-1', status: 'sent', sentAt: '2026-10-31T12:00:01Z', ackedAt: null }
    sim = { ...sim, ops: [command] }
    await route.fulfill({ status: 202, json: { command }, headers: cors })
  })
  await page.goto('/')
  await expect(page.getByTestId('advice')).toContainText('Supervizor securitate')
  await expect(page.getByTestId('advice')).toContainText('Cu acțiune: 7 min')
  await page.getByTestId('advice').getByRole('button', { name: 'Trimite', exact: true }).click()
  expect(posted).toEqual([{ type: 'staff', zone: 'security', delta: 1 }])
  await expect(page.getByTestId('journal')).toContainText('Trimis')
  sim = { ...sim, ops: sim.ops.map(o => ({ ...o, status: 'acked' })) }
  await expect(page.getByTestId('journal')).toContainText('Confirmat')
  sim = { ...sim, flow: { security: { ...sim.flow.security, waitMin: 5, updatedAt: '2026-10-31T12:01:00Z' } } }
  await expect(page.getByTestId('journal')).toContainText('Făcut')
})
test('rejection and transport failures remain actionable', async ({ page }) => {
  await mock(page, () => live, async route => route.fulfill({ status: 409, json: {}, headers: cors }))
  await page.goto('/')
  await page.getByTestId('advice').getByRole('button', { name: 'Respinge' }).click()
  await page.getByTestId('advice').getByRole('button', { name: 'Trimite', exact: true }).click()
  await expect(page.getByTestId('journal')).toContainText('Unity offline')
})
test('phone layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mock(page, () => live, undefined, reports)
  await page.goto('/')
  await page.getByTestId('row-U_SECURITY_QUEUE').click()
  await expect(page.getByTestId('zone-panel')).toContainText('88')
  const widths = await page.locator('.ops').evaluate(el => [el.scrollWidth, el.clientWidth])
  expect(widths[0]).toBeLessThanOrEqual(widths[1]!)
  await page.screenshot({ path: 'test-results/console-v2-phone.png', fullPage: true })
})

import { test, expect, type Page, type Route } from '@playwright/test'
import { join } from 'node:path'
import { plan } from '../src/console/terminal'

// D16 admin screen. GET /api/sim and POST /api/ops/command are mocked; no WebSocket is needed.
const shots = process.env.OPS_SHOTS || 'test-results'
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' }
const row = (waiting: number, capacity: number | null, staff: number | null, waitMin: number | null) => ({ waiting, capacity, waitMin, staff, forecast: null, peak: waiting, updatedAt: '2026-10-31T12:00:00Z' })
const empty = { connected: false, lastSeen: null, run: { scenario: null, arm: null, coverage: null, seed: null }, simTime: null, speed: null, counts: {}, actions: {}, phones: { unknown: 0, notified: 0, read: 0, acting: 0 }, metrics: {}, flow: {}, flights: [], flightsAt: null, positions: null, ops: [] }

/** Deterministic dots spread inside each zone rectangle. */
function crowd(counts: Record<string, [pax: number, staff: number]>) {
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  return plan.zones.flatMap(zone => {
    const [pax, staff] = counts[zone.id] ?? [0, 0]
    const xs = zone.polygon.map(p => p[0]), ys = zone.polygon.map(p => p[1])
    const at = () => ({ x: Math.min(...xs) + 1 + rnd() * (Math.max(...xs) - Math.min(...xs) - 2), y: Math.min(...ys) + 1 + rnd() * (Math.max(...ys) - Math.min(...ys) - 2) })
    return [...Array.from({ length: pax }, () => ({ ...at(), kind: 'pax' })), ...Array.from({ length: staff }, () => ({ ...at(), kind: 'staff' }))]
  })
}
const live = {
  ...empty, connected: true, simTime: 13 * 3600 + 42 * 60 + 10, run: { scenario: 'terminal', arm: 'B', coverage: 0.5, seed: 1 },
  flow: { 'check_in:W6': row(46, 40, 3, 22), 'bag_drop:W6': row(18, 20, 2, 9), 'check_in:RO': row(12, 30, 2, 4), 'bag_drop:RO': row(5, 15, 1, 2), security: row(88, 100, 4, 14) },
  positions: { at: '2026-10-31T12:00:00Z', people: crowd({ entrance: [14, 1], 'check_in:W6': [46, 3], 'bag_drop:W6': [18, 2], 'check_in:RO': [12, 2], 'bag_drop:RO': [5, 1], security: [88, 4], airside: [60, 3], gate_1: [32, 1], gate_2: [11, 1], gate_3: [4, 0] }) },
}

async function mock(page: Page, sim: () => unknown, command?: (route: Route, body: Record<string, unknown>) => Promise<void>) {
  await page.route(/\/api\/sim$/, route => route.fulfill({ json: sim(), headers: cors }))
  await page.route(/\/api\/ops\/command$/, async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (command) await command(route, route.request().postDataJSON())
  })
}

test('renders with no backend and no Unity, without crashing', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await expect(page.getByText('Clarion', { exact: true })).toBeVisible()
  await expect(page.getByTestId('unity-status')).toHaveText('Backend offline')
  await expect(page.getByTestId('terminal-map').locator('.ops-zone')).toHaveCount(plan.zones.length)
  await expect(page.getByTestId('row-security').getByTestId('people')).toHaveText('—')
  await expect(page.getByRole('button', { name: 'Evacuare' })).toBeDisabled()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByText('Nicio comandă')).toBeVisible()
  expect(errors).toEqual([])
})

test('Unity offline: plan without numbers, commands report Unity offline', async ({ page }) => {
  const posted: Record<string, unknown>[] = []
  await mock(page, () => empty, async (route, body) => { posted.push(body); await route.fulfill({ status: 409, json: { connected: false }, headers: cors }) })
  await page.goto('/')
  await expect(page.getByTestId('unity-status')).toHaveText('Unity offline')
  await expect(page.getByTestId('sim-clock')).toHaveText('—')
  await page.getByRole('button', { name: 'Securitate +1 angajat' }).click()
  await expect(page.getByTestId('command').first()).toContainText('Securitate +1 angajat')
  await expect(page.getByTestId('command').first()).toContainText('Unity offline')
  expect(posted).toEqual([{ type: 'staff', zone: 'security', delta: 1 }])
})

test('live zones, staff decisions, evacuation and acknowledgement', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  let sim: Record<string, unknown> = live
  const posted: Record<string, unknown>[] = []
  await mock(page, () => sim, async (route, body) => {
    posted.push(body)
    const command = { ...body, id: `op-${posted.length}`, status: 'sent', sentAt: new Date(Date.now() + posted.length).toISOString(), ackedAt: null }
    sim = { ...sim, ops: [command, ...(sim.ops as unknown[])] }
    await route.fulfill({ status: 202, json: { connected: true, command }, headers: cors })
  })
  await page.goto('/')
  await expect(page.getByTestId('unity-status')).toHaveText('Unity conectat')
  await expect(page.getByTestId('sim-clock')).toHaveText('13:42:10')
  const security = page.getByTestId('row-security')
  await expect(security.getByTestId('people')).toHaveText('88')
  await expect(security.getByTestId('staff')).toHaveText('4')
  await expect(security.getByTestId('wait')).toHaveText('14 min')
  await expect(page.getByTestId('zone-security')).toHaveClass(/ops-near/)
  await expect(page.getByTestId('zone-check_in:W6')).toHaveClass(/ops-full/)
  await expect(page.getByTestId('zone-check_in:RO')).toHaveClass(/ops-normal/)
  // Gates have no flow row: people and staff come from the dots inside the zone.
  await expect(page.getByTestId('row-gate_1').getByTestId('people')).toHaveText('32')
  await expect(page.getByTestId('row-gate_1').getByTestId('staff')).toHaveText('1')
  await expect(page.getByTestId('row-gate_1').getByRole('button')).toHaveCount(0)
  await expect(page.locator('.ops-dots circle')).toHaveCount((live.positions.people).length)
  await page.screenshot({ path: join(shots, 'ops-desktop.png') })

  await page.getByRole('button', { name: 'Bagaje W6 +1 angajat' }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'staff', zone: 'bag_drop:W6', delta: 1 })
  await expect(page.getByTestId('command').first()).toContainText('Bagaje W6 +1 angajat')
  await expect(page.getByTestId('command').first()).toContainText('Trimis')
  sim = { ...sim, ops: (sim.ops as Record<string, unknown>[]).map(o => ({ ...o, status: 'acked', ackedAt: new Date().toISOString() })) }
  await expect(page.getByTestId('command').first()).toContainText('Confirmat')
  await page.getByRole('button', { name: 'Securitate −1 angajat' }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'staff', zone: 'security', delta: -1 })

  await page.getByTestId('zone-gate_1').click()
  await page.getByRole('checkbox', { name: 'Selectează Zona plecări' }).check()
  await expect(page.getByTestId('zone-airside')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.ops-hint')).toHaveText('Poarta 1, Zona plecări')
  await page.screenshot({ path: join(shots, 'ops-desktop-selected.png') })
  await page.getByRole('button', { name: 'Evacuare · 2' }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'evacuate', zones: ['gate_1', 'airside'] })
  await expect(page.getByTestId('command').first()).toContainText('Evacuare Poarta 1, Zona plecări')
  await expect(page.getByRole('button', { name: 'Evacuare' })).toBeDisabled()
  expect(errors).toEqual([])
})

test('fits a phone screen without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mock(page, () => live)
  await page.goto('/')
  await expect(page.getByTestId('row-security').getByTestId('people')).toHaveText('88')
  const width = await page.locator('.ops').evaluate(el => [el.scrollWidth, el.clientWidth])
  expect(width[0]).toBeLessThanOrEqual(width[1]!)
  await page.screenshot({ path: join(shots, 'ops-phone.png') })
  await page.locator('.ops').evaluate(el => el.scrollTo(0, el.scrollHeight))
  await page.screenshot({ path: join(shots, 'ops-phone-list.png') })
})

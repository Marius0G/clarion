import { test, expect, type Page, type Route } from '@playwright/test'
import { join } from 'node:path'
import { zones as mapZones } from '../src/map/t2/data'

// D16 admin screen. GET /api/sim, GET /api/reports and POST /api/ops/command are mocked; no WebSocket is needed.
const shots = process.env.OPS_SHOTS || 'test-results'
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

const panel = (page: Page) => page.getByTestId('zone-panel')
const levelOf = (id: string) => mapZones.find(z => z.id === id)?.level ?? 'G'
/** Opens a zone's decision panel from the map; desk groups through their hall's group picker. Click by event: the map flies. */
async function openZone(page: Page, id: string) {
  const group = /^(check_in|bag_drop):/.exec(id)
  const hall = group ? (group[1] === 'bag_drop' ? 'G_CHECKIN_DESKS' : 'G_CHECKIN_QUEUE') : id
  await page.getByTestId(`floor-${levelOf(hall)}`).click()
  await page.getByTestId(`zone-${hall}`).dispatchEvent('click')
  await expect(panel(page)).toBeVisible()
  if (group) await page.getByTestId(`group-${id}`).click()
}
async function openSettings(page: Page) {
  if (!await page.getByTestId('settings').isVisible()) await page.getByTestId('settings-toggle').click()
  await expect(page.getByTestId('settings')).toBeVisible()
}

test('renders with no backend and no Unity, map only, without crashing', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await expect(page.getByTestId('terminal-map').locator('[data-testid^="zone-"]')).toHaveCount(19)
  // Map only: no brand bar, no queue strip, no dock.
  await expect(page.getByText('Clarion', { exact: true })).toHaveCount(0)
  await expect(page.locator('.ops-queues, .ops-dock, .ops-top')).toHaveCount(0)
  await expect(page.getByTestId('evac-bar')).toHaveCount(0)
  await page.getByTestId('floor-G').click()
  await expect(page.getByTestId('terminal-map').locator('[data-testid^="zone-"]')).toHaveCount(22)
  await openZone(page, 'U_SECURITY_QUEUE')
  await expect(panel(page).getByTestId('people')).toHaveText('necunoscut')
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByTestId('report-pin')).toHaveCount(0)
  await openSettings(page)
  await expect(page.getByTestId('unity-status')).toHaveText('Backend offline')
  await expect(page.getByTestId('accuracy')).toHaveCount(0)
  await expect(page.getByText('Nicio comandă')).toBeVisible()
  expect(errors).toEqual([])
})

test('no cameras: lanes from the backend, zones unknown, commands report Unity offline', async ({ page }) => {
  const posted: Record<string, unknown>[] = []
  await mock(page, () => empty, async (route, body) => { posted.push(body); await route.fulfill({ status: 409, json: { connected: false }, headers: cors }) })
  await page.goto('/')
  await openSettings(page)
  await expect(page.getByTestId('unity-status')).toHaveText('Unity offline')
  await expect(page.getByTestId('vision-status')).toHaveText('Camere offline')
  await expect(page.getByTestId('sim-clock')).toHaveText('—')
  await expect(page.getByTestId('zone-U_SECURITY_QUEUE')).toHaveClass(/s-none/)
  await openZone(page, 'U_SECURITY_QUEUE')
  await expect(page.getByTestId('settings')).toHaveCount(0)
  await expect(panel(page).getByTestId('lanes')).toHaveText('2')
  await expect(panel(page).getByTestId('people')).toHaveText('necunoscut')
  await page.getByRole('button', { name: '+1 linie', exact: true }).click()
  await expect(panel(page)).toContainText('Coadă securitate +1 linie')
  await expect(panel(page)).toContainText('Unity offline')
  await openSettings(page)
  await expect(page.getByTestId('command').first()).toContainText('Unity offline')
  expect(posted).toEqual([{ type: 'staff', zone: 'security', delta: 1 }])
})

test('live cameras, lanes, advice, accuracy, report pins, decisions and acknowledgement', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  let sim: Record<string, unknown> = live
  const posted: Record<string, unknown>[] = []
  await mock(page, () => sim, async (route, body) => {
    posted.push(body)
    const command = { ...body, id: `op-${posted.length}`, status: 'sent', sentAt: new Date(Date.now() + posted.length).toISOString(), ackedAt: null }
    const lanes = { ...(sim.lanes as Record<string, number>) }
    if (body.type === 'staff') lanes[body.zone as string] = Math.max(0, (lanes[body.zone as string] ?? 0) + (body.delta as number))
    const blocked = new Set(sim.blocked as string[])
    if (body.type === 'close') blocked.add(body.zone as string)
    if (body.type === 'open') blocked.delete(body.zone as string)
    if (body.type === 'evacuate') for (const id of body.zones as string[]) blocked.add(id)
    sim = { ...sim, lanes, blocked: [...blocked], ops: [command, ...(sim.ops as unknown[])] }
    await route.fulfill({ status: 202, json: { connected: true, command }, headers: cors })
  }, reports)
  await page.goto('/')
  await openSettings(page)
  await expect(page.getByTestId('unity-status')).toHaveText('Unity conectat')
  await expect(page.getByTestId('vision-status')).toHaveText('Camere')
  await expect(page.getByTestId('sim-clock')).toHaveText('13:42:10')
  await expect(page.getByTestId('accuracy').getByRole('heading')).toHaveText('Acuratețe')
  await expect(page.getByTestId('accuracy-security').locator('td')).toHaveText(['88 / 93', '6 min / 16 min'])
  await expect(page.getByTestId('accuracy-bag_drop:1').locator('td')).toHaveText(['— / 9', '— / 4 min'])

  // Hover card: the zone's own camera numbers.
  await page.getByTestId('zone-U_SECURITY_QUEUE').hover()
  await expect(page.getByTestId('map-card')).toContainText('Coadă securitate')
  await expect(page.getByTestId('map-card')).toContainText('88')
  await expect(page.getByTestId('map-card')).toContainText('Ocupat')

  await openZone(page, 'U_SECURITY_QUEUE')
  await expect(panel(page).getByTestId('people')).toHaveText('88')
  await expect(panel(page).getByTestId('lanes')).toHaveText('2')
  await expect(panel(page).getByTestId('wait')).toHaveText('6 min')
  await expect(panel(page).getByTestId('zone-line')).toHaveText('6 min → 18 min la 14:30Deschide 1 linie până la 14:05')
  await expect(page.getByTestId('zone-U_SECURITY_QUEUE')).toHaveClass(/s-near/)
  await expect(page.getByTestId('zone-U_CORRIDOR_EAST')).toHaveClass(/s-none/)
  await expect(page.locator('.t2-dots circle')).toHaveCount(88 + 32)
  await expect(page.getByTestId('report-pin')).toHaveCount(1)
  await expect(page.getByTestId('report-pin')).toHaveAttribute('aria-label', 'Raport: Bagaj abandonat la poarta 3')
  await expect(page.getByTestId('zone-U_GATE_1')).toHaveClass(/s-near/)
  await expect(page.getByTestId('zone-U_GATE_2')).toHaveClass(/s-full/)
  await expect(page.getByTestId('zone-U_GATE_3')).toHaveClass(/s-normal/)
  await page.screenshot({ path: join(shots, 'zone-states-desktop.png') })
  await panel(page).getByRole('button', { name: 'Deschide 1 linie până la 14:05', exact: true }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'staff', zone: 'security', delta: 1 })
  await expect(panel(page).getByTestId('lanes')).toHaveText('3')
  await expect(panel(page)).toContainText('Trimis')

  // Desk groups share the check-in hall: the hall panel picks one group at a time.
  await openZone(page, 'check_in:1')
  await expect(page.getByTestId('zone-G_CHECKIN_QUEUE')).toHaveClass(/s-full/)
  await expect(page.locator('.t2-dots circle')).toHaveCount(58)
  await expect(page.getByTestId('report-pin')).toHaveCount(0)
  await panel(page).getByRole('button', { name: 'Deschide 2 linii', exact: true }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'staff', zone: 'check_in:1', delta: 2 })
  await page.getByTestId('group-check_in:2').click()
  await page.getByRole('button', { name: '+1 linie', exact: true }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'staff', zone: 'check_in:2', delta: 1 })
  await expect(panel(page).getByTestId('lanes')).toHaveText('3')
  await expect(panel(page)).toContainText('Check-in ghișee 5–8 +1 linie')
  await expect(panel(page)).toContainText('Trimis')
  sim = { ...sim, ops: (sim.ops as Record<string, unknown>[]).map(o => ({ ...o, status: 'acked', ackedAt: new Date().toISOString() })) }
  await expect(panel(page)).toContainText('Confirmat')
  await openZone(page, 'bag_drop:2')
  await expect(panel(page).getByTestId('people')).toHaveText('necunoscut')
  await page.getByRole('button', { name: '−1 linie', exact: true }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'staff', zone: 'bag_drop:2', delta: -1 })
  await expect(page.getByRole('button', { name: '−1 linie', exact: true })).toBeDisabled()

  await openZone(page, 'check_in:1')
  await page.getByRole('combobox', { name: 'Destinație' }).selectOption('check_in:2')
  await page.getByRole('button', { name: 'Mută', exact: true }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'redirect', from: 'check_in:1', to: 'check_in:2' })
  await page.getByRole('button', { name: 'Închide', exact: true }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'close', zone: 'check_in:1' })
  await expect(panel(page)).toHaveClass(/is-closed/)
  await page.getByRole('button', { name: 'Deschide', exact: true }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'open', zone: 'check_in:1' })
  await expect(panel(page)).not.toHaveClass(/is-closed/)

  await openZone(page, 'U_GATE_1')
  await expect(panel(page).getByRole('button', { name: '+1 linie', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Evacuează', exact: true }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'evacuate', zones: ['U_GATE_1'] })
  await expect(page.getByTestId('evac-bar')).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Adaugă la evacuare' }).check()
  await openZone(page, 'U_CORRIDOR_EAST')
  await page.getByRole('checkbox', { name: 'Adaugă la evacuare' }).check()
  await expect(page.locator('.ops-hint')).toHaveText('Poarta 1 (non-Schengen), Coridor airside (peste check-in)')
  await page.getByRole('button', { name: 'Evacuează 2 zone' }).click()
  await expect.poll(() => posted.at(-1)).toEqual({ type: 'evacuate', zones: ['U_GATE_1', 'U_CORRIDOR_EAST'] })
  await expect(page.getByTestId('evac-bar')).toHaveCount(0)
  await openSettings(page)
  await expect(page.getByTestId('command').first()).toContainText('Evacuare Poarta 1 (non-Schengen), Coridor airside (peste check-in)')

  await openZone(page, 'U_SECURITY_QUEUE')
  await page.screenshot({ path: join(shots, 'zone-panel-desktop.png') })

  // Cameras gone: numbers turn unknown, lanes stay.
  sim = { ...sim, vision: false, connected: true }
  await expect(panel(page).getByTestId('people')).toHaveText('necunoscut')
  await expect(panel(page).getByTestId('lanes')).toHaveText('3')
  await expect(panel(page).getByTestId('zone-line')).toHaveCount(0)
  await expect(page.locator('.t2-dots circle')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('map layers and refresh are settings that persist', async ({ page }) => {
  await mock(page, () => live, undefined, reports)
  await page.goto('/')
  await expect(page.locator('.t2-dots circle')).toHaveCount(88 + 32)
  await expect(page.locator('.t2-heat')).toHaveCount(0)
  await openSettings(page)
  await page.getByTestId('layer-dots').uncheck()
  await page.getByTestId('layer-heat').check()
  await page.getByTestId('layer-labels').uncheck()
  await page.getByTestId('layer-pins').uncheck()
  await page.getByRole('button', { name: '5 s', exact: true }).click()
  await expect(page.locator('.t2-dots')).toHaveCount(0)
  await expect(page.locator('.t2-heat circle')).toHaveCount(88 + 32)
  await expect(page.locator('.t2-labels')).toHaveCount(0)
  await expect(page.getByTestId('report-pin')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.t2-heat circle')).toHaveCount(88 + 32)
  await expect(page.locator('.t2-dots')).toHaveCount(0)
  await openSettings(page)
  await expect(page.getByRole('button', { name: '5 s', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('zoom: buttons, keys and focus fly the view, reset returns to the whole floor', async ({ page }) => {
  await mock(page, () => live, undefined, reports)
  await page.goto('/')
  const map = page.getByTestId('t2-map-U')
  const box = () => map.getAttribute('viewBox').then(v => v!.split(' ').map(Number))
  const whole = await box()
  await page.getByRole('button', { name: 'Mărește' }).click()
  await expect.poll(async () => (await box())[2]).toBeLessThan(whole[2]! * 0.7)
  await page.keyboard.press('0')
  await expect.poll(async () => (await box())[2]).toBeCloseTo(whole[2]!, 0)
  await page.keyboard.press('+')
  await expect.poll(async () => (await box())[2]).toBeLessThan(whole[2]!)
  await page.getByRole('button', { name: 'Toată harta' }).click()
  await expect.poll(async () => (await box())[2]).toBeCloseTo(whole[2]!, 0)
  await openZone(page, 'U_SECURITY_QUEUE')
  await expect.poll(async () => (await box())[2]).toBeLessThan(whole[2]! / 2)
})

test('fits a phone screen without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mock(page, () => live, undefined, reports)
  await page.goto('/')
  await expect(page.getByTestId('report-pin')).toHaveCount(1)
  await openZone(page, 'U_SECURITY_QUEUE')
  await expect(panel(page).getByTestId('people')).toHaveText('88')
  await panel(page).scrollIntoViewIfNeeded()
  await expect(panel(page)).toBeInViewport()
  const width = await page.locator('.ops').evaluate(el => [el.scrollWidth, el.clientWidth])
  expect(width[0]).toBeLessThanOrEqual(width[1]!)
  await page.screenshot({ path: join(shots, 'zone-panel-phone.png') })
})

test('rejected decisions stay visible in the zone panel without closing the zone', async ({ page }) => {
  await mock(page, () => live, async route => { await route.fulfill({ status: 400, json: { error: 'Invalid ops command' }, headers: cors }) })
  await page.goto('/')
  await page.getByTestId('floor-G').click()
  await page.getByTestId('zone-G_CHECKIN_QUEUE').focus()
  await page.keyboard.press('Enter')
  await page.getByTestId('group-check_in:1').click()
  await page.getByRole('button', { name: 'Închide', exact: true }).click()
  await expect(panel(page)).toContainText('Respins')
  await expect(panel(page)).not.toHaveClass(/is-closed/)
})

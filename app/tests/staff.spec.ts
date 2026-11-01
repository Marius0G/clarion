import { expect, test, type Page } from '@playwright/test'
import { checkButtons } from './button-states'
import { chatCoverage } from './chat-fixture'
import { flowFixture, mockLive, opsFixture, staffData, staffSession } from './live-fixture'
const shots = '/private/tmp/claude-502/-Users-bogdan-Developer-Hackathon-Craiova2026/f87d6fa9-77a5-40df-8e73-615c38ce0588/scratchpad'
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

async function open(page: Page, data: () => unknown = () => staffData(), ops: unknown[] = opsFixture()) {
  await page.addInitScript(s => localStorage.setItem('clarion.session', s), staffSession)
  await mockLive(page, { ops })
  await page.route('**/api/staff', route => route.fulfill({ json: data() }))
  await page.route('**/api/staff/tasks/**', () => { throw new Error('Staff must never call task endpoints') })
  await page.goto('/s')
  await expect(page.getByTestId('live-map')).toBeVisible()
}

test('staff map: own zone, live numbers, forecast, report pins and the moving team', async ({ page }) => {
  await open(page)
  await expect(page.getByRole('heading', { name: 'Coadă securitate · supervizor' })).toBeVisible()
  await expect(page.getByTestId('queue-wait')).toContainText('14 min')
  await expect(page.getByTestId('queue-wait')).toContainText('Ocupat')
  await expect(page.getByTestId('queue-people')).toContainText('62')
  await expect(page.getByTestId('lm-zone-U_SECURITY_QUEUE')).toHaveAttribute('data-home', '1')
  // ISA-101: exact count, trend and data age on the map.
  await expect(page.getByTestId('lm-point-U_SECURITY_QUEUE')).toHaveAttribute('aria-label', /62 → · 14 min · \d+ s/)
  // Pins: state by shape and word.
  await expect(page.getByTestId('lm-pin-R1')).toHaveAttribute('data-state', 'sent')
  await expect(page.getByTestId('lm-pin-R1')).toHaveAttribute('aria-label', 'Aglomerație · Neconfirmat')
  await expect(page.getByTestId('lm-pin-R2')).toHaveAttribute('aria-label', 'Medical · Echipa vine · ~3 min')
  await expect(page.getByTestId('lm-pin-R3')).toHaveAttribute('data-state', 'resolved')
  expect(Number(await page.getByTestId('lm-pin-R3').evaluate(e => getComputedStyle(e).opacity))).toBeLessThan(1)
  const team = page.getByTestId('lm-team')
  await expect(team).toHaveAttribute('aria-label', 'Echipa · ~3 min')
  const before = await team.evaluate(e => (e as SVGGElement).style.transform)
  await expect.poll(() => team.evaluate(e => (e as SVGGElement).style.transform), { timeout: 4000 }).not.toBe(before)
  const lines = page.getByTestId('lm-team-route').locator('.lm-team-line')
  await expect(lines.first()).toBeVisible()
  await expect(lines).toHaveCount(1)
  await expect(lines.first()).toHaveAttribute('data-floor', 'U')
  await page.getByRole('button', { name: 'Extinde' }).press('Enter')
  await expect(page.getByTestId('zone-forecast')).toContainText('Peste 30 min: ▲~18 min'.replace('▲', '●'))
  await expect(page.getByTestId('zone-forecast')).toContainText('Peste 60 min: ~8 min')
  await expect(page.getByTestId('team-eta')).toContainText('Echipa · ~3 min · Poarta 3')
  await expect(page.getByTestId('dispatch-notices')).toContainText('Dispeceratul a deschis o linie în plus la Coadă securitate')
  await expect(page.getByTestId('dispatch-notices')).not.toContainText('Poarta 9')
  await expect(page.locator('body')).not.toContainText(/Sarcini|Deschide o linie|Gata|demo/)
  await page.screenshot({ path: `${shots}/staff.png` })
})

test('team route stays on each floor and drops completed corridors', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: now })
  await page.clock.pauseAt(now)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const data = staffData(now)
  data.reports[1]!.timestamps.en_route = new Date(now).toISOString()
  await open(page, () => data)
  await page.clock.runFor(100)
  const route = page.getByTestId('lm-team-route')
  const lines = route.locator('.lm-team-line')
  await expect(lines).toHaveCount(2)
  await expect(lines.nth(0)).toHaveAttribute('data-floor', 'G')
  await expect(lines.nth(1)).toHaveAttribute('data-floor', 'U')
  await expect(route.locator('.lm-change')).toHaveCount(1)
  const remainingLength = () => lines.evaluateAll(els => els.reduce((sum, el) => sum + (el as SVGPathElement).getTotalLength(), 0))
  const before = await remainingLength()
  await page.getByRole('button', { name: 'Micșorează' }).click()
  await page.getByRole('button', { name: 'Micșorează' }).click()
  await page.clock.runFor(1000)
  await page.screenshot({ path: `${shots}/team-route.png` })
  await page.clock.fastForward(180_000)
  await expect(lines).toHaveCount(1)
  await expect(lines.first()).toHaveAttribute('data-floor', 'U')
  await expect(route.locator('.lm-change')).toHaveCount(0)
  expect(await remainingLength()).toBeLessThan(before)
})

test('blocked security removes an unreachable route without a straight fallback', async ({ page }) => {
  await page.addInitScript(s => localStorage.setItem('clarion.session', s), staffSession)
  await mockLive(page, { flow: () => ({ ...flowFixture(), blocked: ['security'] }) })
  await page.route('**/api/staff', route => route.fulfill({ json: staffData() }))
  await page.goto('/s')
  await expect(page.getByTestId('lm-pin-R2')).toBeVisible()
  await expect(page.getByTestId('lm-team-route')).toHaveCount(0)
  await expect(page.getByTestId('lm-team')).toHaveCount(0)
})

test('one tap: too many people in my zone, or in the selected place', async ({ page }) => {
  const bodies: unknown[] = []
  await page.route('**/api/reports', route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${staffSession}`)
    bodies.push(route.request().postDataJSON()); return route.fulfill({ status: 201, json: { id: 'R9' } })
  })
  await open(page)
  const crowd = page.getByRole('button', { name: 'Prea multă lume aici', exact: true }).first()
  expect((await crowd.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await crowd.click()
  await expect(page.getByRole('status').filter({ hasText: 'Am transmis. Dispeceratul decide.' })).toBeVisible()
  expect(bodies[0]).toEqual({ type: 'crowd', place: { node: 'security', name: 'Securitate' }, text: 'Prea multă lume aici' })
  await page.getByPlaceholder('Caută un loc').fill('poarta 5')
  await page.getByRole('list', { name: 'Rezultate' }).getByRole('button').first().click()
  const card = page.getByTestId('point-card')
  await expect(card.getByRole('heading', { name: 'Poarta 5' })).toBeVisible()
  await expect(card).toContainText('Necunoscut')
  await card.getByRole('button', { name: 'Prea multă lume aici' }).click()
  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[1]).toEqual({ type: 'crowd', place: { node: 'U_GATE_5', name: 'Poarta 5' }, text: 'Prea multă lume aici' })
})

test('tap-to-report: tap, drag the pin, pick the type, Trimite', async ({ page }) => {
  let body: { type?: string; place?: { node: string; name: string }; text?: string } = {}
  await page.route('**/api/reports', route => { body = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { id: 'R9' } }) })
  await open(page)
  await page.getByRole('button', { name: 'Raportează pe hartă' }).click()
  await expect(page.getByText('Atinge harta unde este').first()).toBeVisible()
  const target = (await page.getByTestId('lm-point-U_SECURITY_QUEUE').boundingBox())!
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2 + 4)
  const pin = page.getByTestId('lm-draft')
  await expect(pin).toBeVisible()
  const form = page.getByRole('form', { name: 'Raportează' })
  const first = await form.locator('.place b').textContent()
  // Drag the pin somewhere else: the place follows.
  const box = (await pin.locator('.grab').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 140, { steps: 8 })
  await page.mouse.up()
  await expect(form.locator('.place b')).not.toHaveText(first!)
  await form.getByRole('button', { name: 'Curățenie' }).click()
  await form.getByRole('button', { name: 'Trimite' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Am transmis. Dispeceratul decide.' })).toBeVisible()
  expect(body.type).toBe('cleaning')
  expect(body.text).toBe('')
  expect(body.place?.node).toMatch(/^[A-Za-z]/)
  await expect(pin).toHaveCount(0)
})

test('reads the newer staff API: zone object, forecast and notices', async ({ page }) => {
  let simCalls = 0
  await page.addInitScript(s => localStorage.setItem('clarion.session', s), staffSession)
  await mockLive(page)
  await page.route('**/api/sim', route => { simCalls++; return route.fulfill({ json: { ops: [] } }) })
  await page.route('**/api/staff', route => route.fulfill({ json: { ...staffData(), zone: { id: 'security', forecast: [{ inMin: 30, waitMin: 25 }, { inMin: 60, waitMin: 9 }] },
    notices: [{ text: 'Dispeceratul a deschis o linie în plus la securitate', at: '14:12', timestamp: 1, zone: 'security' }] } }))
  await page.goto('/s')
  await page.getByRole('button', { name: 'Extinde' }).press('Enter')
  await expect(page.getByTestId('zone-forecast')).toContainText('Peste 30 min: ●~25 min')
  await expect(page.getByTestId('dispatch-notices')).toHaveText('Dispeceratul a deschis o linie în plus la securitate14:12')
  expect(simCalls).toBe(0)
})

test('chat from the staff sheet', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Extinde' }).press('Enter')
  await page.getByRole('button', { name: 'Extinde' }).press('Enter')
  await chatCoverage(page)
})

test('guests see login', async ({ page }) => {
  await page.route('**/api/staff', route => route.fulfill({ status: 401, json: {} }))
  await page.goto('/s')
  await expect(page.getByRole('link', { name: 'Conectează-te cu WhatsApp' })).toBeVisible()
})

test('403 explains the WhatsApp staff command', async ({ page }) => {
  await page.addInitScript(s => localStorage.setItem('clarion.session', s), staffSession)
  await mockLive(page)
  await page.route('**/api/staff', route => route.fulfill({ status: 403, json: { error: 'Staff role required' } }))
  await page.goto('/s')
  await expect(page.getByRole('heading', { name: 'Trimite STAFF <cod> pe WhatsApp', exact: true })).toBeVisible()
  await expect(page.getByText('Acces personal', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Prea multă lume aici' })).toHaveCount(0)
})

test('unknown cameras, empty lists and a failed crowd report', async ({ page }) => {
  await page.route('**/api/reports', route => route.fulfill({ status: 500, json: {} }))
  await open(page, () => ({ ...staffData(), reports: [], alerts: [], situation: { waitMin: null, people: null, state: 'unknown', forecast: [] } }), [])
  await expect(page.getByTestId('queue-wait')).toContainText('Necunoscut')
  await page.getByRole('button', { name: 'Prea multă lume aici' }).click()
  await expect(page.getByRole('alert')).toHaveText('Raport netrimis')
  await expect(page.getByRole('button', { name: 'Prea multă lume aici' })).toBeEnabled()
  await page.getByRole('button', { name: 'Extinde' }).press('Enter')
  await expect(page.getByText('Nicio alertă')).toBeVisible()
  await expect(page.getByText('Niciun raport')).toBeVisible()
  await expect(page.getByText('Nicio decizie pentru zona ta')).toBeVisible()
})

test('English staff page', async ({ page }) => {
  await open(page, () => ({ ...staffData(), lang: 'en' }))
  await expect(page.getByRole('heading', { name: 'Security queue · supervisor' })).toBeVisible()
  await expect(page.getByTestId('queue-wait')).toContainText('Busy')
  await expect(page.getByRole('button', { name: 'Too many people here' })).toBeEnabled()
  await expect(page.getByTestId('lm-pin-R2')).toHaveAttribute('aria-label', 'Medical · Team en route · ~3 min')
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false })
  test('side panel instead of the sheet', async ({ page }) => {
    await open(page)
    await expect(page.locator('.lm-sheet')).toHaveCount(0)
    const panel = page.getByRole('complementary', { name: 'Detalii' })
    await expect(panel.getByTestId('dispatch-notices')).toBeVisible()
    await expect(panel.getByRole('region', { name: 'Mesaje' })).toBeVisible()
    await expect(page.getByTestId('lm-team')).toBeVisible()
  })
})

for (const width of [390, 1440]) {
  test(`staff attribution, labels and button states at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    const data = staffData()
    data.reports.push({ ...data.reports[0], id: 'R4', state: 'taken', isOwn: false, reporterRole: 'security_supervisor', timestamps: { sent: data.reports[0].at, taken: data.reports[0].at } })
    await open(page, () => data)
    await checkButtons(page)
    if (width < 900) await page.getByRole('button', { name: 'Extinde' }).press('Enter')
    const reports = page.locator('.lv-myreports')
    for (const text of ['Neconfirmat', 'Confirmat de dispecerat', 'Trimis de tine', 'Agent hol', 'Pasager', 'Supervizor securitate']) await expect(reports).toContainText(text)
    await expect(page.getByTestId('lm-pin-R4')).toHaveAttribute('aria-label', 'Aglomerație · Confirmat')
    if (width === 1440) await page.screenshot({ path: `${shots}/staff-labels.png` })
    await checkButtons(page)
    const primary = page.getByRole('button', { name: 'Raportează pe hartă' })
    await primary.hover()
    await expect(primary).toHaveCSS('background-color', 'rgb(37, 75, 118)')
    if (width === 1440) await page.screenshot({ path: `${shots}/hover.png` })
    await primary.click()
    const target = (await page.getByTestId('lm-point-U_SECURITY_QUEUE').boundingBox())!
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2)
    const form = page.getByRole('form', { name: 'Raportează' })
    await expect(form.getByRole('button', { name: 'Trimite' })).toBeDisabled()
    await checkButtons(page)
    await form.getByRole('button', { name: 'Medical' }).click()
    await checkButtons(page)
    await page.getByRole('button', { name: 'Renunță' }).click()
    await page.getByPlaceholder('Caută un loc').fill('cafenea')
    await checkButtons(page)
    await page.getByRole('list', { name: 'Rezultate' }).getByRole('button').first().click()
    await checkButtons(page)
  })
}

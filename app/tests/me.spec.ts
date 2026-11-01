import { expect, test, type Page } from '@playwright/test'
import { chatCoverage } from './chat-fixture'
import { checkButtons } from './button-states'
import { fixture } from '../src/me/fixture'
import { flowFixture, mockLive, passengerData, session, staffData } from './live-fixture'
const shots = '/private/tmp/claude-502/-Users-bogdan-Developer-Hackathon-Craiova2026/f87d6fa9-77a5-40df-8e73-615c38ce0588/scratchpad'
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

async function open(page: Page, data: Record<string, unknown> = passengerData, opts: Parameters<typeof mockLive>[1] = {}) {
  await page.addInitScript(s => localStorage.setItem('clarion.session', s), session)
  await mockLive(page, opts)
  let meCalls = 0
  await page.route('**/api/me', route => { meCalls++; return route.fulfill({ json: data }) })
  await page.goto('/m')
  await expect(page.getByTestId('live-map')).toBeVisible()
  await expect(page.getByTestId('lm-point-U_GATE_3')).toBeVisible()
  return { meCalls: () => meCalls }
}
const expandSheet = async (page: Page) => { await page.getByRole('button', { name: 'Extinde' }).press('Enter'); await page.getByRole('button', { name: 'Extinde' }).press('Enter') }

test('passenger map: flight, queue list, own route to the gate and live crowding', async ({ page }) => {
  await open(page)
  await expect(page.getByRole('heading', { name: 'W6 3751 · Roma', exact: true })).toBeVisible()
  await expect(page.locator('.me-flight')).toContainText('Poarta 3 · se închide la 15:05')
  await expect(page.getByTestId('queue-checkin')).toContainText('5 min')
  await expect(page.getByTestId('queue-security')).toContainText('12 min')
  await expect(page.getByTestId('queue-security')).toContainText('~20 min la 14:25')
  await expect(page.locator('body')).not.toContainText(/demo|ora simulării|aproximativ/i)
  await expect(page.getByTestId('lm-route')).toBeVisible()
  await expect(page.getByTestId('lm-here')).toHaveAttribute('aria-label', 'Ești aici')
  await expect(page.getByText('Urci la etaj 1', { exact: false }).first()).toBeAttached()
  await expect(page.getByRole('region', { name: 'Drumul tău' })).toContainText('pe jos')
  // Crowding from the cameras, as data attributes (CSS fills), with words and a hatched stale zone.
  await expect(page.getByTestId('lm-zone-U_SECURITY_QUEUE')).toHaveAttribute('data-crowd', 'busy')
  await expect(page.getByTestId('lm-zone-G_CENTER')).toHaveAttribute('data-crowd', 'very')
  await expect(page.getByTestId('lm-zone-U_DUTY_FREE')).toHaveAttribute('data-crowd', 'stale')
  await expect(page.getByTestId('lm-zone-G_WC')).toHaveAttribute('data-crowd', 'none')
  await expect(page.getByTestId('lm-point-U_SECURITY_QUEUE')).toHaveAttribute('aria-label', /Aglomerat · 11–20 min/)
  // No people dots for passengers.
  await expect(page.locator('.t2-dots circle')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `${shots}/me.png` })
})

test('crowding updates in place every poll, without reloading the map', async ({ page }) => {
  let density = 0.4
  await open(page, passengerData, { flow: () => { const f = flowFixture(); (f.flow.gate_3 as unknown as { density: number }).density = density; return f } })
  const zone = page.getByTestId('lm-zone-U_GATE_3')
  await expect(zone).toHaveAttribute('data-crowd', 'free')
  await page.evaluate(() => { (document.querySelector('[data-zone="U_GATE_3"]') as HTMLElement & { __mark?: number }).__mark = 1 })
  density = 2.5
  await expect(zone).toHaveAttribute('data-crowd', 'very', { timeout: 6000 })
  expect(await page.evaluate(() => (document.querySelector('[data-zone="U_GATE_3"]') as HTMLElement & { __mark?: number }).__mark)).toBe(1)
})

test('search, card, directions and "Sunt aici"', async ({ page }) => {
  await open(page)
  await page.getByPlaceholder('Unde vrei să mergi?').fill('cafenea')
  await page.getByRole('list', { name: 'Rezultate' }).getByRole('button', { name: /Cafenea/ }).click()
  const card = page.getByTestId('point-card')
  await expect(card.getByRole('heading', { name: 'Cafenea' })).toBeVisible()
  await expect(card).toContainText('Liber')
  await expect(card).toContainText('Etaj 1')
  await card.getByRole('button', { name: 'Drum până aici' }).click()
  await expect(page.getByRole('region', { name: 'Drumul tău' })).toContainText('Spre Cafenea')
  await expect(page.getByRole('region', { name: 'Drumul tău' })).toContainText('pe jos')
  await page.getByRole('button', { name: 'Înapoi la poarta 3' }).click()
  await expect(page.getByRole('region', { name: 'Drumul tău' })).toContainText('Spre poarta 3')
  // Tap a point on the map, then set it as the current place.
  await page.getByTestId('lm-point-U_GATE_3').click()
  await expect(card.getByRole('heading', { name: 'Poarta 3' })).toBeVisible()
  await expect(card).toContainText('Aglomerat')
  await card.getByRole('button', { name: 'Sunt aici' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Salvat: ești aici' })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('clarion.here')!).id)).toBe('U_GATE_3')
  await expect(card).toContainText('ești aici')
})

test('category chips list places by walking time; one tap selects', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Toalete', exact: true }).click()
  const rows = page.getByRole('list', { name: 'Rezultate' })
  await expect(rows.getByRole('button')).toHaveCount(2)
  await expect(rows).toContainText('Toalete parter')
  await expect(rows).toContainText('Toalete etaj')
  await expect(page.getByTestId('lm-point-U_WC')).toBeVisible()
  await expect(page.getByTestId('lm-point-U_GATE_3')).toHaveCount(0)
  await rows.getByRole('button').first().click()
  await expect(page.getByTestId('point-card')).toContainText('Fără date')
})

test('tap-to-report from the passenger page sends the place under the pin', async ({ page }) => {
  await open(page)
  let body: unknown
  await page.route('**/api/reports', route => { body = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { id: 'R1' } }) })
  await page.getByRole('button', { name: 'Raportează o problemă' }).click()
  await expect(page.getByText('Atinge harta unde este').first()).toBeVisible()
  const gate = (await page.getByTestId('lm-point-U_GATE_3').boundingBox())!
  await page.mouse.click(gate.x + gate.width / 2, gate.y + gate.height / 2)
  await expect(page.getByTestId('lm-draft')).toBeVisible()
  const form = page.getByRole('form', { name: 'Raportează' })
  await expect(form).toContainText('Poarta 3')
  await expect(form.getByRole('button', { name: 'Trimite' })).toBeDisabled()
  await form.getByRole('button', { name: 'Medical' }).click()
  await form.getByLabel('Notă').fill('O persoană a leșinat')
  await form.getByRole('button', { name: 'Trimite' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Raport trimis' })).toBeVisible()
  expect(body).toEqual({ type: 'medical', place: { node: 'U_GATE_3', name: 'Poarta 3' }, text: 'O persoană a leșinat' })
})

test('chat opens full screen from the sheet', async ({ page }) => {
  await page.addInitScript(s => localStorage.setItem('clarion.session', s), session)
  await page.route('**/api/sim/flow', route => route.fulfill({ json: flowFixture() }))
  await page.route('**/api/chat/ticket', route => route.fulfill({ status: 503, json: {} }))
  await page.route('**/api/me', route => route.fulfill({ json: passengerData }))
  await page.goto('/m')
  await expandSheet(page)
  await chatCoverage(page)
})

test('missing session requests WhatsApp login, failed legacy token shows no invented data', async ({ page }) => {
  await page.route('**/api/me*', route => route.fulfill({ status: 401, json: {} }))
  await page.goto('/m')
  await expect(page.getByRole('link', { name: 'Conectează-te cu WhatsApp' })).toHaveAttribute('href', '/join')
  await page.route('**/api/me?token=old', route => route.fulfill({ status: 404, json: {} }))
  await page.goto('/m/old')
  await expect(page.getByRole('alert')).toHaveText('Date indisponibile')
  await expect(page.locator('body')).not.toContainText('Roma')
})

test('legacy URL works and polling highlights gate changes', async ({ page }) => {
  await page.clock.install()
  let gate = '3'
  await page.route('**/api/me?token=old', route => route.fulfill({ json: { ...fixture, flight: { ...fixture.flight, gate } } }))
  await page.goto('/m/old')
  await expect(page.locator('.me-flight')).toContainText('3')
  gate = '4'; await page.clock.runFor(5000)
  await expect(page.locator('.me-flight .flight-change').first()).toContainText('4')
  await expect(page.locator('.me-flight .flight-change').first()).toContainText('Schimbare')
})

test('evacuation shows only the way out and the assembly point', async ({ page }) => {
  await mockLive(page)
  await page.route('**/api/me?token=evac', route => route.fulfill({ json: { ...fixture,
    routeImage: '/routes/evac/U_SECURITY_QUEUE.png', assembly: 'ASSEMBLY_LANDSIDE_EAST', evacuation: { active: true, zones: ['security'], route: { exit: 'Est', steps: ['Securitate', 'Ieșire est'] } } } }))
  await page.goto('/m/evac')
  await expect(page.getByRole('alert')).toContainText('Evacuare')
  await expect(page.getByRole('alert')).toContainText('Punct adunare est')
  await expect(page.getByTestId('lm-route')).toHaveClass(/evac/)
  await expect(page.locator('.lm-points .lm-pt')).toHaveCount(0)
  await expect(page.getByPlaceholder('Unde vrei să mergi?')).toHaveCount(0)
  await expect(page.locator('.me-flight')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Raportează o problemă' })).toHaveCount(0)
})

test('English: profile language and the EN / RO toggle', async ({ page }) => {
  await open(page, { ...passengerData, lang: 'en', flight: { ...fixture.flight, status: 'delayed', delayMin: 15 } })
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('.me-flight')).toContainText('Delayed 15 min')
  await expect(page.getByPlaceholder('Where do you want to go?')).toBeVisible()
  await page.getByRole('button', { name: 'Română' }).click()
  await expect(page.getByPlaceholder('Unde vrei să mergi?')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ro')
})

test('recent staff crowd observation appears on its queue', async ({ page }) => {
  await open(page, { ...passengerData, gateCrowd: 'Personalul semnalează aglomerație la poarta 3.',
    queues: fixture.queues!.map(q => ({ ...q, staffCrowd: /security/i.test(q.zone) ? 'Personalul semnalează aglomerație la securitate.' : undefined })) })
  await expect(page.getByTestId('queue-security')).toContainText('Personalul semnalează aglomerație la securitate.')
  await expect(page.getByTestId('queue-checkin')).not.toContainText('Personalul')
  await expect(page.getByTestId('queue-gate')).toContainText('poarta 3')
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false })
  test('map left, side panel with queues, details and the conversation', async ({ page }) => {
    await open(page)
    await expect(page.locator('.lm-sheet')).toHaveCount(0)
    const panel = page.getByRole('complementary', { name: 'Detalii' })
    await expect(panel).toBeVisible()
    expect((await panel.boundingBox())!.width).toBe(380)
    await expect(panel.getByTestId('queue-security')).toContainText('12 min')
    await expect(panel.getByRole('region', { name: 'Mesaje' })).toBeVisible()
    await page.getByTestId('lm-point-U_GATE_3').click()
    await expect(panel.getByTestId('point-card')).toContainText('Poarta 3')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})

for (const width of [390, 1440]) {
  test(`passenger report labels and button states at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    const reports = staffData().reports
    reports.push({ ...reports[0], id: 'R4', state: 'taken' })
    await open(page, { ...passengerData, reports })
    await checkButtons(page)
    if (width < 900) await expandSheet(page)
    await page.locator('.lv-reports summary').click()
    for (const text of ['Neconfirmat', 'Confirmat', 'Echipa vine · ~4 min', 'Rezolvat']) await expect(page.locator('.lv-reports')).toContainText(text)
    await checkButtons(page)
    await page.getByRole('button', { name: 'English' }).click()
    await expect(page.locator('.lv-reports')).toContainText('Unconfirmed')
    await expect(page.locator('.lv-reports')).toContainText('Confirmed')
    await page.getByRole('button', { name: 'Română' }).click()
    await page.getByRole('button', { name: 'Toalete', exact: true }).click()
    await checkButtons(page)
    await page.getByRole('list', { name: 'Rezultate' }).getByRole('button').first().click()
    await checkButtons(page)
    await page.getByRole('button', { name: 'Raportează aici' }).click()
    await checkButtons(page)
    await page.getByRole('button', { name: 'Medical', exact: true }).click()
    await checkButtons(page)
  })
}

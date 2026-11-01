import { expect, test } from '@playwright/test'
import { chatCoverage } from './chat-fixture'
import { fixture } from '../src/me/fixture'
const screenshot = '/private/tmp/claude-502/-Users-bogdan-Developer-Hackathon-Craiova2026/f87d6fa9-77a5-40df-8e73-615c38ce0588/scratchpad/me.png'
test.use({ viewport: { width: 390, height: 844 } })
const session = 'a'.repeat(64)
test('passenger dashboard shows four tiles, collapsed details, route, chat and fixed reporting', async ({ page }) => {
  await page.addInitScript(s => localStorage.setItem('clarion.session', s), session)
  let submitted = false
  await page.route('**/api/me', async route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${session}`)
    return route.fulfill({ json: { ...fixture, stage: 'public', routeImage: '/routes/door_departures__U_GATE_3.png',
      timeline: [{ at: '14:10', kind: 'flight', text: 'Poarta 3 · Îmbarcare' }],
      reports: submitted ? [{ id: 'R1', text: 'O persoană a leșinat', state: 'sent', priority: 'P1', place: { node: 'U_GATE_3', name: 'Poarta 3' }, etaMin: 3 }] : [] } })
  })
  await page.route('**/api/reports', async route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${session}`)
    expect(route.request().postDataJSON()).toEqual({ type: 'medical', place: { node: 'U_GATE_3', name: 'Poarta 3' }, text: 'O persoană a leșinat' })
    submitted = true; return route.fulfill({ status: 201, json: { id: 'R1' } })
  })
  await page.goto('/m')
  await expect(page.getByRole('heading', { name: 'W6 3751 · Roma', exact: true })).toBeVisible()
  await expect(page.locator('.me-flight')).toContainText('Poarta 3 · se închide la 15:05')
  await expect(page.locator('.dashboard-tiles > *')).toHaveCount(4)
  await expect(page.locator('.queue-band')).toHaveText(['4–10 min', '>10 min'])
  await expect(page.locator('.queue-forecast')).toHaveText('~20 min la 14:25')
  await expect(page.locator('body')).not.toContainText(/ora simulării|\(prognoză\)|\(acum\)|marjă|demo|>10 \/ >10|4–10 \/ 4–10/i)
  await expect(page.getByRole('heading', { name: 'Drumul tău' })).toBeVisible()
  await expect(page.locator('.me-map')).toContainText('Spre poarta 3 · ~5 min')
  await expect(page.locator('.dashboard-tiles')).toContainText('12 min')
  await expect(page.locator('.dashboard-tiles')).toContainText('5 min')
  await expect(page.locator('.route-image')).toBeVisible()
  await expect.poll(() => page.locator('.route-image').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  const reportButton = page.getByRole('button', { name: 'Raportează o problemă', exact: true })
  expect((await reportButton.boundingBox())!.y).toBeLessThan(844)
  await page.screenshot({ path: screenshot, fullPage: false })
  await chatCoverage(page)
  await page.getByRole('button', { name: 'Raportează o problemă', exact: true }).click()
  await page.getByRole('button', { name: 'Medical', exact: true }).click()
  await page.getByLabel('Caută un reper').fill('Poarta 3')
  await page.getByRole('button', { name: 'Poarta 3', exact: true }).click()
  await page.getByLabel('Detalii').fill('O persoană a leșinat')
  await page.getByRole('button', { name: 'Trimite', exact: true }).click()
  await page.locator('.dashboard-tiles details').last().locator('summary').click()
  await expect(page.getByText('R1 · Trimis', { exact: false })).toBeVisible()
  await expect(page.getByText('ETA ~3 min')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
})
test('missing session requests WhatsApp login, failed legacy token shows no invented data', async ({ page }) => {
  await page.route('**/api/me*', route => route.fulfill({ status: 401, json: {} }))
  await page.goto('/m')
  await expect(page.getByRole('link', { name: 'Conectează-te cu WhatsApp' })).toHaveAttribute('href', '/join')
  await page.route('**/api/me?token=old', route => route.fulfill({ status: 404, json: {} }))
  await page.goto('/m/old')
  await expect(page.getByRole('alert')).toHaveText('Date indisponibile')
  await expect(page.locator('body')).not.toContainText('Roma')
  await expect(page.locator('body')).not.toContainText('demo')
})
test('legacy URL works and polling highlights gate changes', async ({ page }) => {
  await page.clock.install()
  let gate = '3'
  await page.route('**/api/me?token=old', route => route.fulfill({ json: { ...fixture, flight: { ...fixture.flight, gate } } }))
  await page.goto('/m/old')
  await expect(page.locator('.me-flight')).toContainText('3')
  gate = '4'; await page.clock.runFor(5000)
  await expect(page.locator('.me-flight .flight-change')).toContainText('4')
  await expect(page.locator('.me-flight .flight-change')).toContainText('Schimbare')
})
test('evacuation shows only exit image and assembly, with no ordinary sections', async ({ page }) => {
  await page.route('**/api/me?token=evac', route => route.fulfill({ json: { ...fixture,
    routeImage: '/routes/evac/U_SECURITY_QUEUE.png', assembly: 'ASSEMBLY_LANDSIDE_EAST', evacuation: { active: true, zones: ['security'], route: { exit: 'Est', steps: ['Securitate', 'Ieșire est'] } } } }))
  await page.goto('/m/evac')
  await expect(page.getByRole('alert')).toContainText('ASSEMBLY_LANDSIDE_EAST')
  await expect(page.locator('.route-image')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Zbor', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Raportează o problemă' })).toHaveCount(0)
  await expect(page.locator('.me-flight')).toHaveCount(0)
})
test('English page preserves the passenger language', async ({ page }) => {
  await page.route('**/api/me?token=english', route => route.fulfill({ json: { ...fixture, lang: 'en', flight: { ...fixture.flight, status: 'delayed', delayMin: 15 } } }))
  await page.goto('/m/english')
  await expect(page.getByRole('heading', { name: 'W6 3751', exact: false })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await page.locator('.dashboard-details summary').click()
  await expect(page.getByText('Delayed 15 min', { exact: false })).toBeVisible()
  await page.locator('.dashboard-tiles details').last().locator('summary').click()
  await expect(page.getByRole('heading', { name: 'My reports' })).toBeVisible()
})

test('unchanged security forecast has no extra line', async ({ page }) => {
  await page.route('**/api/me?token=same', route => route.fulfill({ json: { ...fixture, queues: fixture.queues!.map(q => ({ ...q, forecastMin: q.nowMin })) } }))
  await page.goto('/m/same')
  await expect(page.getByRole('heading', { name: 'W6 3751 · Roma' })).toBeVisible()
  await expect(page.locator('.queue-forecast')).toHaveCount(0)
  await expect(page.locator('.queue-band')).toHaveText(['4–10 min', '>10 min'])
})

test('report details are optional after selecting type and landmark', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('clarion.session', 'a'.repeat(64)))
  await page.route('**/api/me', route => route.fulfill({ json: fixture }))
  let submitted = false
  await page.route('**/api/reports', route => {
    expect(route.request().postDataJSON()).toMatchObject({ type: 'medical', place: { node: 'U_GATE_3' }, text: '' })
    submitted = true
    return route.fulfill({ status: 201, json: { id: 'R1' } })
  })
  await page.goto('/m')
  await page.getByRole('button', { name: 'Raportează o problemă' }).click()
  await expect(page.getByRole('button', { name: 'Trimite', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Medical', exact: true }).click()
  await page.getByLabel('Caută un reper').fill('Poarta 3')
  await page.getByRole('button', { name: 'Poarta 3', exact: true }).click()
  await page.getByRole('button', { name: 'Trimite', exact: true }).click()
  await expect.poll(() => submitted).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

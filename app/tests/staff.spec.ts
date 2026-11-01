import { expect, test } from '@playwright/test'
const screenshot = '/private/tmp/claude-502/-Users-bogdan-Developer-Hackathon-Craiova2026/f87d6fa9-77a5-40df-8e73-615c38ce0588/scratchpad/staff.png'
test.use({ viewport: { width: 390, height: 844 } })
test('staff confirms and completes shared tasks, sees zone alerts and reports', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('clarion.session', 'b'.repeat(64)))
  let state: string | undefined, report = false
  await page.route('**/api/staff', route => route.fulfill({ json: { zone: 'Securitate', role: 'security_supervisor',
    tasks: [{ id: 'T1', type: 'staff', zone: 'Securitate', status: 'sent', staffState: state }],
    alerts: [{ id: 'A1', priority: 'P2', text: 'Țintă depășită · 12 min' }],
    reports: [{ id: 'R7', priority: 'P1', state: 'en_route', text: 'Incident', place: { name: 'Poarta 3' }, etaMin: 2 }, ...(report ? [{ id: 'R8', priority: 'P3', state: 'sent', text: 'Podea murdară', place: { name: 'Securitate' } }] : [])] } }))
  await page.route('**/api/staff/tasks/T1/*', route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${'b'.repeat(64)}`)
    state = route.request().url().endsWith('/confirm') ? 'confirmed' : 'done'
    return route.fulfill({ json: { staffState: state } })
  })
  await page.route('**/api/reports', route => { report = true; expect(route.request().postDataJSON().type).toBe('cleaning'); return route.fulfill({ status: 201, json: { id: 'R8' } }) })
  await page.goto('/s')
  await expect(page.getByRole('heading', { name: 'Sarcinile mele' })).toBeVisible()
  await expect(page.getByText('P2 · Țintă depășită', { exact: false })).toBeVisible()
  await expect(page.getByText('ETA ~2 min')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByText('Confirmat', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Făcut', exact: true }).click()
  await expect(page.getByText('Făcut', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Raportează' }).click()
  await page.getByRole('button', { name: 'Curățenie', exact: true }).click()
  await page.getByLabel('Reper').selectOption('U_SECURITY_QUEUE')
  await page.getByLabel('Descriere').fill('Podea murdară')
  await page.getByRole('button', { name: 'Trimite', exact: true }).click()
  await expect(page.getByText('Securitate · Podea murdară')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: screenshot, fullPage: false })
})
test('passengers see access restriction and guests see login', async ({ page }) => {
  await page.route('**/api/staff', route => route.fulfill({ status: 401, json: {} }))
  await page.goto('/s')
  await expect(page.getByRole('link', { name: 'Conectează-te cu WhatsApp' })).toBeVisible()
  await page.evaluate(() => localStorage.setItem('clarion.session', 'b'.repeat(64)))
  await page.route('**/api/staff', route => route.fulfill({ status: 403, json: {} }))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Acces personal' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Raportează' })).toHaveCount(0)
})
test('staff handles empty data and reports a task failure without marking it done', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('clarion.session', 'b'.repeat(64)))
  let empty = false
  await page.route('**/api/staff', route => route.fulfill({ json: { zone: 'Securitate', reports: [], alerts: [], tasks: empty ? [] : [{ id: 'T1', type: 'staff', zone: 'security' }] } }))
  await page.route('**/api/staff/tasks/**', route => route.fulfill({ status: 400, json: {} }))
  await page.goto('/s')
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Acțiune netrimisă')
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled()
  empty = true; await page.reload()
  await expect(page.getByText('Nicio sarcină')).toBeVisible()
  await expect(page.getByText('Nicio alertă')).toBeVisible()
  await expect(page.getByText('Niciun raport')).toBeVisible()
})

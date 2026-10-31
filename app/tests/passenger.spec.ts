import { test, expect } from '@playwright/test'
import { fixture } from '../src/me/fixture'

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' }
const token = 'a'.repeat(48)
const waLink = `https://wa.me/15556318672?text=${encodeURIComponent(`START W6 3751 ${token}`)}`

test('enter boarding flight, consent, then open the matching WhatsApp START and Wallet', async ({ page, context }) => {
  const joins: unknown[] = []
  await page.route(/\/api\/state$/, route => route.fulfill({ json: { flights: [{ flight: 'W6 3751' }] }, headers: cors }))
  await page.route(/\/api\/join$/, route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    joins.push(route.request().postDataJSON())
    return route.fulfill({ status: 201, json: { token, waLink }, headers: cors })
  })
  const walletRequests: unknown[] = []
  await page.route(/\/api\/wallet\/pass$/, route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    walletRequests.push(route.request().postDataJSON())
    return route.fulfill({ json: { saveUrl: 'https://pay.google.com/gp/v/save/test-pass', demo: false }, headers: cors })
  })
  await context.route('https://pay.google.com/**', route => route.fulfill({ contentType: 'text/html', body: 'Wallet test' }))
  await page.goto('/join')
  await page.getByRole('button', { name: 'Pasager', exact: true }).click()
  await page.getByLabel('Număr zbor').fill('W6 3751')
  await expect(page.getByRole('button', { name: 'Continuă în WhatsApp' })).toBeDisabled()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Continuă în WhatsApp' }).click()
  await expect(page.getByRole('link', { name: 'Deschide WhatsApp' })).toHaveAttribute('href', waLink)
  expect(joins).toEqual([{ flight: 'W6 3751', lang: 'ro' }])
  const wallet = page.getByRole('button', { name: 'Adaugă în Google Wallet' })
  await expect(wallet).toBeEnabled()
  const popupPromise = page.waitForEvent('popup')
  await wallet.click()
  const popup = await popupPromise
  await expect(popup).toHaveURL('https://pay.google.com/gp/v/save/test-pass')
  expect(walletRequests).toEqual([{ joinToken: token }])
})

test('passenger link reads its token and renders the backend flight, gate and queues', async ({ page }) => {
  const data = { ...fixture, flight: { ...fixture.flight, flight: 'E2 9876', destination: 'Test destination', gate: 'G2' }, alerts: [] }
  const requested: string[] = []
  await page.route(/\/api\/me\?/, route => {
    requested.push(new URL(route.request().url()).searchParams.get('token') || '')
    return route.fulfill({ json: data, headers: cors })
  })
  await page.goto('/m/passenger-test-token')
  const flight = page.getByRole('region', { name: 'Zbor', exact: true })
  await expect(flight).toContainText('E2 9876')
  await expect(flight).toContainText('Test destination')
  await expect(flight).toContainText('G2')
  await expect(page.locator('.me-arrival')).toContainText('12 min acum')
  await expect(page.locator('.me-arrival')).toContainText('~20 min la 14:25')
  await expect(page.locator('.me-arrival')).toContainText('Securitate')
  await expect(page.getByText('date demo', { exact: true })).toHaveCount(0)
  expect(requested.length).toBeGreaterThan(0)
  expect(new Set(requested)).toEqual(new Set(['passenger-test-token']))
})

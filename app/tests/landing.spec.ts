import { test, expect } from '@playwright/test'

const tagline = 'Clarion transformă aglomerația din aeroport în instrucțiuni personale: când să vii, pe unde să intri și unde să te duci când ceva merge prost.'

test('landing page explains Clarion and subscribes through /join', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(tagline)
  await expect(page.getByRole('link', { name: 'Abonează-te', exact: true })).toHaveAttribute('href', '/join')
  await expect(page.getByRole('link', { name: 'Scrie-ne pe WhatsApp' })).toHaveAttribute('href', 'https://wa.me/15556318672?text=START')
  await expect(page.getByRole('link', { name: 'Consola operatorului' })).toHaveAttribute('href', '/console')
  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
  expect(widths[0]).toBeLessThanOrEqual(widths[1]!)
  await page.screenshot({ path: 'test-results/landing-phone.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: 'test-results/landing-desktop.png', fullPage: true })
  await page.getByRole('link', { name: 'Abonează-te', exact: true }).click()
  await expect(page).toHaveURL(/\/join$/)
})

test('old operator links on / open the console with the same query', async ({ page }) => {
  await page.route(/\/api\/(sim|reports)$/, route => route.fulfill({ status: 404, json: {}, headers: { 'access-control-allow-origin': '*' } }))
  await page.goto('/?token=x')
  await expect(page).toHaveURL(/\/console(\?|$)/)
  await expect(page.getByTestId('top-band')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('clarion.token'))).toBe('x')
})

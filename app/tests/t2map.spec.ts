import { test, expect } from '@playwright/test'

test('the T2 map draws both floors at once, upper above ground', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/harta')
  const map = page.getByTestId('t2-map-G')
  await expect(map).toBeVisible()
  // Both floors are drawn; test ids follow the highlighted floor.
  await expect(map.locator('[data-zone^="G_"]')).toHaveCount(22)
  await expect(map.locator('[data-zone^="U_"]')).toHaveCount(19)
  await expect(map.locator('[data-testid^="t2-zone-G_"]')).toHaveCount(22)
  await expect(map.locator('[data-testid^="t2-zone-U_"]')).toHaveCount(0)
  // Exterior is the ground plate's lighter edge, no separate button.
  await expect(map.locator('[data-zone="X_TAXI_RANK"]')).toHaveClass(/ext/)
  await expect(page.getByRole('button', { name: 'Exterior' })).toHaveCount(0)
  // Upper plate sits above the ground plate.
  const top = async (id: string) => (await map.locator(`[data-zone="${id}"] .fill`).boundingBox())!
  expect((await top('U_CONCOURSE')).y + (await top('U_CONCOURSE')).height).toBeLessThan((await top('G_RECLAIM_1')).y)
  // Nothing drawn between the floors: no connector lines, no stairs, escalator or lift icons.
  await expect(map.locator('.t2-links, .t2-link, .i-vert')).toHaveCount(0)
  // Labels on both floors.
  await expect(map.locator('.t2-labels text', { hasText: /^Banda 1$/ })).toHaveCount(1)
  await expect(map.locator('.t2-labels text', { hasText: /^Securitate$/ })).toHaveCount(1)
  expect(errors).toEqual([])
})

test('hover and click work on either floor, and zoom glides', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/harta')
  const map = page.getByTestId('t2-map-G')
  await page.getByTestId('t2-zone-G_CHECKIN_QUEUE').hover()
  await expect(page.getByTestId('map-card')).toContainText('Coadă check-in')
  await page.getByTestId('t2-zone-G_CHECKIN_QUEUE').click({ force: true })
  await expect(page.locator('span', { hasText: /^G_CHECKIN_QUEUE$/ })).toBeVisible()

  // A zone upstairs: hover card, click selects it and highlights that floor.
  await map.locator('[data-zone="U_SECURITY"]').hover()
  await expect(page.getByTestId('map-card')).toContainText('Securitate')
  await map.locator('[data-zone="U_SECURITY"]').dispatchEvent('click')
  const upper = page.getByTestId('t2-map-U')
  await expect(upper).toBeVisible()
  await expect(upper.getByTestId('t2-zone-U_SECURITY')).toHaveClass(/sel/)
  await expect(page.getByTestId('map-floor-U')).toHaveClass(/on/)

  // The floor name of the other floor switches back.
  await page.getByTestId('map-floor-G').click()
  await expect(page.getByTestId('t2-map-G')).toBeVisible()

  const g = page.getByTestId('t2-map-G')
  const width = async () => Number((await g.getAttribute('viewBox'))!.split(' ')[2])
  const whole = await width()
  await expect(page.getByRole('button', { name: 'Toată harta' })).toBeDisabled()
  await page.getByRole('button', { name: 'Mărește' }).click()
  await expect.poll(width).toBeLessThan(whole)
  await page.getByRole('button', { name: 'Toată harta' }).click()
  await expect.poll(width).toBeCloseTo(whole, 0)
})

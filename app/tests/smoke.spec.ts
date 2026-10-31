import { test, expect } from '@playwright/test'

test('app shell, map canvas and layer toggles render', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')

  await expect(page.getByText('LRCV', { exact: true })).toBeVisible()
  await expect(page.getByTestId('status-pill')).toBeVisible()
  await expect(page.getByTestId('scenario-rail')).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(4)

  const canvas = page.locator('.maplibregl-canvas')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box!.width).toBeGreaterThan(400)
  expect(box!.height).toBeGreaterThan(300)

  // all layers loaded into the style
  await expect(page.getByTestId('map')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 })

  const toggles = page.locator('[data-testid^="toggle-"]')
  expect(await toggles.count()).toBeGreaterThanOrEqual(15)
  await expect(page.getByTestId('toggle-aeroway-runway')).toBeChecked()
  await page.getByTestId('toggle-aeroway-runway').uncheck()
  await expect(page.getByTestId('toggle-aeroway-runway')).not.toBeChecked()

  expect(errors).toEqual([])
})

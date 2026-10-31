import { test, expect } from '@playwright/test'

test('the T2 map draws every floor and zooms', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/harta')
  await expect(page.getByTestId('t2-map-G')).toBeVisible()
  await expect(page.locator('[data-testid^="t2-zone-G_"]')).toHaveCount(22)
  await page.getByTestId('t2-zone-G_CHECKIN_QUEUE').click({ force: true })
  await expect(page.getByText('G_CHECKIN_QUEUE')).toBeVisible()

  await page.getByRole('button', { name: 'Mărește' }).click()
  const box = await page.getByTestId('t2-map-G').getAttribute('viewBox')
  expect(box?.split(' ').map(Number)[2]).toBeLessThan(3000)
  await page.getByRole('button', { name: 'Toată harta' }).click()
  await expect(page.getByTestId('t2-map-G')).toHaveAttribute('viewBox', '0 0 3000 1050')

  await page.getByRole('button', { name: 'Etaj 1' }).click()
  await expect(page.locator('[data-testid^="t2-zone-U_"]')).toHaveCount(19)
  await page.getByRole('button', { name: 'Exterior' }).click()
  await expect(page.locator('[data-testid^="t2-zone-"]')).toHaveCount(11)
  expect(errors).toEqual([])
})

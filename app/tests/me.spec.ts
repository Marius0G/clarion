import { expect, test } from '@playwright/test'
import { fixture } from '../src/me/fixture'

test.use({ viewport: { width: 360, height: 800 } })

test('personal page falls back to demo, polls, and displays evacuation and latest alerts', async ({ page }) => {
  await page.clock.install()
  let live = false
  await page.route('**/api/me?token=demo', route => {
    if (!live) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: {
      ...fixture, simTime: 14 * 3600 + 25 * 60, arriveBy: '14:35', entranceToGateMin: 45,
      queues: [{ zone: 'security', label: 'Securitate', nowMin: 22, forecastMin: 30, forecastAt: '14:45', source: 'prognoză' }],
      flight: { ...fixture.flight, status: 'delayed', delayMin: 15 },
      steps: [{ zone: 'security', label: 'Securitate', waitMin: null }],
      evacuation: { active: true, zones: ['security', 'check_in:2'] },
      alerts: Array.from({ length: 7 }, (_, i) => ({ at: `14:0${i}`, kind: 'admin', text: `Mesaj ${i}` })),
    } })
  })
  await page.goto('/m/demo')
  await expect(page.getByRole('heading', { name: 'Situația din terminal' })).toBeVisible()
  await expect(page.locator('.me-arrival')).toContainText('Securitate: 12 min acum, ~20 min la 14:25')
  await expect(page.locator('.me-arrival')).toContainText('~40 min, inclusiv 10 min marjă')
  await expect(page.locator('.me-arrival')).toContainText('se închide la 15:05')
  await expect(page.getByText('date demo', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/me-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.locator('.me-page').evaluate(element => getComputedStyle(element).paddingLeft)).toBe('16px')
  live = true
  await page.clock.runFor(5000)
  await expect(page.locator('.me-arrival')).toContainText('Securitate: 22 min acum, ~30 min la 14:45')
  await expect(page.locator('.me-arrival')).toContainText('~45 min')
  await expect(page.locator('body')).not.toContainText('Fii la intrare')
  await expect(page.getByText('date demo', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('Urmează indicatoarele spre cea mai apropiată ieșire')
  await expect(page.getByRole('alert')).toContainText('check_in:2')
  await expect(page.getByText('Întârziat +15 min', { exact: true })).toBeVisible()
  await expect(page.getByText('14:25', { exact: true })).toBeVisible()
  await expect(page.locator('.me-steps')).toContainText('necunoscut')
  await expect(page.locator('.me-alerts li')).toHaveCount(5)
  await expect(page.locator('.me-alerts li').first()).toContainText('Mesaj 6')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('network failure and incomplete live data render safely', async ({ page }) => {
  await page.route('**/api/me?token=demo', route => route.abort())
  await page.goto('/m/demo')
  await expect(page.getByText('date demo', { exact: true })).toBeVisible()
  await page.unroute('**/api/me?token=demo')
  await page.route('**/api/me?token=demo', route => route.fulfill({ json: { steps: [null], flight: null } }))
  await page.reload()
  await expect(page.locator('.me-arrival')).toContainText('durată necunoscută')
  await expect(page.getByText('date demo', { exact: true })).toHaveCount(0)
})

test('English passenger page translates conditions, labels, status and evacuation', async ({ page }) => {
  await page.route('**/api/me?token=english', route => route.fulfill({ json: {
    ...fixture, lang: 'en', flight: { ...fixture.flight, status: 'delayed', delayMin: 30 },
    queues: [{ zone: 'security', label: 'Control de securitate', nowMin: 12, forecastMin: 20, forecastAt: '14:30', source: 'prognoză' }],
    evacuation: { active: true, zones: ['security'] }, alerts: [],
  } }));
  await page.goto('/m/english');
  await expect(page.getByRole('heading', { name: 'Terminal conditions' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.me-arrival')).toContainText('Security: 12 min now, ~20 min at 14:30 (forecast)');
  await expect(page.getByText('Delayed +30 min')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Follow signs to the nearest exit');
  await expect(page.getByRole('heading', { name: 'Map', exact: true })).toBeVisible();
  await expect(page.getByText('No alerts.')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Poartă');
});

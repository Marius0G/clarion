import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

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

test('snow candidate requires declaration and checklist completion enters timeline', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Snow or blizzard', exact: true }).click()
  await page.getByRole('button', { name: 'Click map to set location' }).click()
  await expect(page.getByTestId('map')).toHaveAttribute('data-ready','true', {timeout:30000})
  await page.locator('.maplibregl-canvas').click({position:{x:350,y:200}})
  await page.getByRole('button', {name:'Start',exact:true}).click()
  await expect(page.getByTestId('status-pill')).toHaveText('Candidate')
  await expect(page.locator('.playbook input').first()).toBeDisabled()
  await page.getByRole('button',{name:'Declare',exact:true}).click()
  await page.getByRole('button',{name:'Confirm Declare',exact:true}).click()
  await page.locator('.playbook input').first().check()
  await page.screenshot({ path: 'test-results/incident-console.png' })
  await page.getByRole('tab',{name:'Timeline',exact:true}).click()
  await expect(page.getByTestId('timeline-entry').filter({hasText:'Checklist completed'})).toHaveCount(1)
  await expect(page.getByTestId('timeline-entry').filter({hasText:'Declared · Snow or blizzard'})).toHaveCount(1)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button',{name:'Export JSON'}).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('lrcv-simulation-timeline.json')
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8'))
  expect(exported.simulated).toBe(true)
  expect(exported.entries.some((e: { category: string }) => e.category === 'checklist')).toBe(true)
  await page.emulateMedia({ media: 'print' })
  await expect(page.getByTestId('scenario-rail')).toBeHidden()
  await expect(page.getByTestId('timeline-entry').first()).toBeVisible()
  await page.screenshot({ path: 'test-results/timeline-print.png', fullPage: true })
})

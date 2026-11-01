import { expect, type Page } from '@playwright/test'
import { checkButtons } from './button-states'
export async function chatCoverage(page: Page) {
  const history: { role: string; text: string; at: string; channel: string; buttons?: { id: string; title: string }[]; image?: string }[] = [
    { role: 'clarion', text: 'Poarta 3 · Îmbarcare', at: '14:10', channel: 'whatsapp' },
    { role: 'clarion', text: 'Bagaj', at: '14:11', channel: 'web', buttons: [{ id: 'bag:yes', title: 'Da' }] },
  ]
  await page.route('**/api/chat', route => {
    expect(route.request().headers().authorization).toMatch(/^Bearer [ab]{64}$/)
    if (route.request().method() === 'GET') return route.fulfill({ json: { history } })
    const body = route.request().postDataJSON()
    if (body.text === 'Limită') return route.fulfill({ status: 429, json: {} })
    if (body.text === 'Eroare') return route.fulfill({ status: 500, json: {} })
    if (body.text === 'Da') expect(body.replyId).toBe('bag:yes')
    history.push({ role: 'user', text: body.text, at: '14:12', channel: 'web' }, { role: 'clarion', text: 'Traseu spre poartă', at: '14:12', channel: 'web', image: '/routes/door_departures__U_GATE_3.png' })
    return route.fulfill({ json: { history } })
  })
  const launch = page.getByRole('button', { name: 'Mesaje' })
  await expect(launch).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await launch.click()
  const dialog = page.getByRole('dialog', { name: 'Mesaje', exact: true })
  await expect(dialog).toBeVisible()
  expect(await dialog.boundingBox()).toMatchObject({ x: 0, y: 0, width: 390, height: 844 })
  await expect(dialog.getByText('Poarta 3 · Îmbarcare')).toBeVisible()
  await checkButtons(page)
  await dialog.getByRole('button', { name: 'Da', exact: true }).click()
  await expect(dialog.locator('.chat-user').getByText('Da', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('img', { name: 'Traseu' })).toBeVisible()
  await dialog.getByLabel('Mesaj', { exact: true }).fill('Securitate?')
  await dialog.getByRole('button', { name: 'Trimite', exact: true }).click()
  await expect(dialog.getByText('Securitate?', { exact: true })).toBeVisible()
  for (const [input, error] of [['Limită', 'Limită mesaje · 1 min'], ['Eroare', 'Mesaj netrimis']]) {
    await dialog.getByLabel('Mesaj', { exact: true }).fill(input)
    await dialog.getByRole('button', { name: 'Trimite', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText(error)
    await expect(dialog.getByLabel('Mesaj', { exact: true })).toHaveValue(input)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(launch).toHaveAttribute('aria-expanded', 'false')
  await expect(launch).toBeFocused()
}

import { expect, test, type WebSocketRoute } from '@playwright/test'
import { flowFixture, passengerData, session } from './live-fixture'
test.use({ viewport: { width: 1440, height: 900 } })

const entry = (id: string, role: 'user' | 'clarion', text: string, channel: 'whatsapp' | 'web', extra = {}) => ({ id, role, text, channel, at: '14:10', timestamp: Date.now(), ...extra })

test('chat is live over the WebSocket: history, WhatsApp messages, typing, buttons and page refresh', async ({ page }) => {
  await page.addInitScript(s => localStorage.setItem('clarion.session', s), session)
  await page.route('**/api/sim/flow', route => route.fulfill({ json: flowFixture() }))
  let meCalls = 0
  await page.route('**/api/me', route => { meCalls++; return route.fulfill({ json: passengerData }) })
  let tickets = 0
  await page.route('**/api/chat/ticket', route => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().headers().authorization).toBe(`Bearer ${session}`)
    tickets++; return route.fulfill({ json: { ticket: `t${tickets}`, expiresIn: 60 } })
  })
  // Until the socket opens the page may poll; it never posts over HTTP while the socket is open.
  await page.route('**/api/chat', route => { expect(route.request().method()).toBe('GET'); return route.fulfill({ json: { history: [] } }) })
  const sockets: WebSocketRoute[] = [], received: unknown[] = []
  await page.routeWebSocket(/\/ws\?client=person&ticket=t\d+$/, ws => {
    sockets.push(ws)
    ws.onMessage(raw => {
      const msg = JSON.parse(String(raw)); received.push(msg)
      ws.send(JSON.stringify({ type: 'chat', entry: entry(`u${received.length}`, 'user', msg.text, 'web') }))
      ws.send(JSON.stringify({ type: 'typing', on: true }))
    })
    ws.send(JSON.stringify({ type: 'history', entries: [entry('h1', 'clarion', 'Bun venit', 'whatsapp', { buttons: [{ id: 'bag:yes', title: 'Am bagaj' }] })] }))
  })
  await page.goto('/m')
  const chat = page.getByRole('region', { name: 'Mesaje' })
  await expect(chat.getByText('Bun venit')).toBeVisible()
  await expect(chat.locator('.chat-ch').first()).toHaveText('WhatsApp')
  // A message written on WhatsApp shows up at once, once.
  const ws = sockets[0]!
  const wa = entry('w1', 'user', 'Cât e la securitate?', 'whatsapp')
  ws.send(JSON.stringify({ type: 'chat', entry: wa }))
  ws.send(JSON.stringify({ type: 'chat', entry: wa }))
  await expect(chat.getByText('Cât e la securitate?')).toHaveCount(1)
  // Buttons send the id as replyId and the title as text.
  await chat.getByRole('button', { name: 'Am bagaj' }).click()
  await expect.poll(() => received).toContainEqual({ type: 'chat', text: 'Am bagaj', replyId: 'bag:yes' })
  await expect(chat.getByText('Clarion scrie…')).toBeVisible()
  ws.send(JSON.stringify({ type: 'chat', entry: entry('c2', 'clarion', 'Securitate: 12 min acum.', 'web') }))
  await expect(chat.getByText('Clarion scrie…')).toHaveCount(0)
  await expect(chat.getByText('Securitate: 12 min acum.')).toBeVisible()
  await chat.getByLabel('Mesaj').fill('Mulțumesc')
  await chat.getByRole('button', { name: 'Trimite' }).click()
  await expect.poll(() => received).toContainEqual({ type: 'chat', text: 'Mulțumesc' })
  await expect(chat.getByLabel('Mesaj')).toHaveValue('')
  // `me` refreshes the page data.
  const before = meCalls
  ws.send(JSON.stringify({ type: 'me' }))
  await expect.poll(() => meCalls).toBeGreaterThan(before)
  // Reconnects with a new ticket after the socket closes.
  await ws.close()
  await expect.poll(() => tickets, { timeout: 5000 }).toBe(2)
  await expect.poll(() => sockets.length).toBe(2)
})

test('falls back to HTTP when the socket cannot open', async ({ page }) => {
  await page.addInitScript(s => localStorage.setItem('clarion.session', s), session)
  await page.route('**/api/sim/flow', route => route.fulfill({ json: flowFixture() }))
  await page.route('**/api/me', route => route.fulfill({ json: passengerData }))
  await page.route('**/api/chat/ticket', route => route.fulfill({ status: 503, json: {} }))
  const history = [{ role: 'clarion', text: 'Poarta 3 · Îmbarcare', at: '14:10', channel: 'whatsapp' }]
  await page.route('**/api/chat', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { history } })
    history.push({ role: 'user', text: route.request().postDataJSON().text, at: '14:11', channel: 'web' })
    return route.fulfill({ json: { history } })
  })
  await page.goto('/m')
  const chat = page.getByRole('region', { name: 'Mesaje' })
  await expect(chat.getByText('Poarta 3 · Îmbarcare')).toBeVisible()
  await chat.getByLabel('Mesaj').fill('Salut')
  await chat.getByRole('button', { name: 'Trimite' }).click()
  await expect(chat.getByText('Salut', { exact: true })).toBeVisible()
  await expect(chat.locator('.chat-ch').last()).toHaveText('Web')
})

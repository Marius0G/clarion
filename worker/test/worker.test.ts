import { Miniflare,Response,convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
import { mkdir,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';

let mf: Miniflare;
const persist = resolve('.test-state', crypto.randomUUID());
const sockets: { close(): void }[] = [];
const envelope = (type: string, data = {}) => ({ type, ts: new Date().toISOString(), data });
function start(simSpeed = '60000') {
  return new Miniflare(convertV4MiniflareOptions({
    name: 'clarion-test', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    resourcePersistencePath: persist, unsafeInspectDurableObjects: true,
    outboundService: async request => Response.json(request.url.startsWith('https://fids.flightradar.live/') ? [{
      flight_iata: 'W63412', dep_iata: 'BGY', arr_iata: 'CRA', dep_time_ts: 1793462400, arr_time_ts: 1793469600,
    }] : []),
    bindings: { SIM_SPEED: simSpeed,
      WHATSAPP_VERIFY_TOKEN: 'verify-me', WHATSAPP_APP_SECRET: 'meta-secret' },
  }));
}
async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return mf.dispatchFetch(`https://worker.example${path}`, body === undefined ? { headers } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}
async function action(type: string, data = {}) {
  const response = await request('/api/action', envelope(type, data));
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}
async function connect(client: string) {
  const response = await mf.dispatchFetch(`https://worker.example/ws?client=${client}`, { headers: { Upgrade: 'websocket' } });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const messages: any[] = [];
  ws.addEventListener('message', e => messages.push(JSON.parse(String(e.data))));
  ws.accept();
  sockets.push(ws);
  await expect.poll(() => messages.find(m => m.type === 'state')).toBeTruthy();
  return { ws, messages };
}
beforeAll(async () => { await mkdir(persist, { recursive: true }); mf = start(); });
beforeEach(async () => { for (const ws of sockets.splice(0)) ws.close(); await action('console.reset'); });
afterAll(async () => { for (const ws of sockets) ws.close(); await mf.dispose(); await rm(persist, { recursive: true, force: true }); });

describe('Worker + SQLite Tower in workerd', () => {
  it('serves the contract HTTP routes and rejects invalid commands', async () => {
    expect(await request('/health').then(r => r.json())).toEqual({ ok: true, service: 'clarion', whatsapp: 'dry-run' });
    expect(await request('/api/aircraft').then(r => r.json())).toEqual({ aircraft: [], source: 'OpenSky (empty on timeout/unavailable)' });
    expect((await request('/api/state').then(r => r.json()) as any).dataSource).toBe('fids');
    for (const path of ['/missing', '/api/telegram', '/waze/cifs.json']) expect((await request(path)).status).toBe(404);
    expect((await request('/webhooks/telegram', {})).status).toBe(404);
    expect((await request('/api/action', envelope('agent.register', { agents: [] }))).status).toBe(400);
    expect((await request('/ws?client=invalid')).status).toBe(400);
    expect((await request('/ws?client=twin')).status).toBe(426);
  });
  it.each(['whatsapp'])('accepts the %s subscription contract', async channel => {
    const response = await request('/api/subscribe', { role: 'rideshare', channel, lang: 'en', consent: true, source: 'qr' });
    expect(response.status).toBe(201);
    const subscription = await response.json() as any;
    expect(subscription.subscriptionId).toMatch(/^[\da-f-]{36}$/);
    expect(Object.keys(subscription).sort()).toEqual(['subscriptionId']);
  });
  it('broadcasts agent.update presence, validates locations and persists it through hibernation', async () => {
    const twin = await connect('twin');
    const viewer = await connect('viewer');
    twin.ws.send(JSON.stringify(envelope('agent.register', { agents: [{ agentId: 'location-test', role: 'rent_a_car_ubt', channel: 'whatsapp' }] })));
    await expect.poll(() => viewer.messages.some(m => m.type === 'state' && m.data.presence.rent_a_car_ubt.unknown === 1)).toBe(true);
    for (const location of ['home', 'road', 'terminal', 'kerb']) {
      twin.ws.send(JSON.stringify(envelope('agent.update', { agentId: 'location-test', role: 'rent_a_car_ubt', location, action: 'moving' })));
      await expect.poll(() => viewer.messages.some(m => m.type === 'state' && m.data.presence.rent_a_car_ubt[location] === 1)).toBe(true);
    }
    twin.ws.send(JSON.stringify(envelope('agent.update', { agentId: 'location-test', role: 'rent_a_car_ubt', location: 'invalid' })));
    await expect.poll(() => twin.messages.some(m => m.type === 'error' && m.data.message === 'Invalid agent update')).toBe(true);
    await mf.unsafeEvictDurableObject('clarion-test', 'Tower', { name: 'tower', webSockets: 'hibernate' });
    const state = await request('/api/state').then(r => r.json()) as any;
    expect(state.presence.rent_a_car_ubt).toEqual({ home: 0, road: 0, terminal: 0, kerb: 1, unknown: 0 });
  });
  it('accepts console actions via WS and rejects viewer mutations', async () => {
    const consoleClient = await connect('console');
    consoleClient.ws.send(JSON.stringify(envelope('console.reset')));
    await expect.poll(() => consoleClient.messages.some(m => m.type === 'state' && m.data.phase === 'normal')).toBe(true);
    const viewer = await connect('viewer');
    viewer.ws.send(JSON.stringify(envelope('console.reset')));
    await expect.poll(() => viewer.messages.some(m => m.type === 'error')).toBe(true);
    expect((await request('/api/state').then(r => r.json()) as any).phase).toBe('normal');
  });
  it('subscribes, validates consent and preserves subscriptions on reset', async () => {
    const response = await request('/api/subscribe', { role: 'relative_arrivals', flight: 'W63412', channel: 'whatsapp', lang: 'en', consent: true, source: 'relative' });
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.subscriptionId).toMatch(/^[\da-f-]{36}$/);
    expect(Object.keys(body)).toEqual(['subscriptionId']);
    expect((await request('/api/subscribe', { role: 'taxi', channel: 'whatsapp', lang: 'ro', consent: false })).status).toBe(400);
    const state = await action('console.reset');
    expect(state.counters.relative_arrivals.subscribers).toBeGreaterThan(0);
    expect(JSON.stringify(state)).not.toContain('test-secret');
  });
  it('verifies WhatsApp GET challenge and rejects unauthenticated POSTs', async () => {
    expect(await (await request('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1234')).text()).toBe('1234');
    expect((await request('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1234')).status).toBe(403);
    expect((await request('/webhooks/whatsapp', {})).status).toBe(403);
  });
  it('forwards signed WhatsApp inbound events into the shared handler and deduplicates retries', async () => {
    const viewer = await connect('viewer');
    const body = { entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', from: '40700000000', text: { body: 'START TAXI' }, timestamp: String(Math.floor(Date.now()/1000)) }] } }] }] };
    const signature = 'sha256=' + createHmac('sha256', 'meta-secret').update(JSON.stringify(body)).digest('hex');
    expect((await request('/webhooks/whatsapp', body, { 'X-Hub-Signature-256': signature })).status).toBe(200);
    expect((await request('/webhooks/whatsapp', body, { 'X-Hub-Signature-256': signature })).status).toBe(200);
    const presence = { entry: [{ changes: [{ value: { messages: [{ id: 'wamid.2', from: '40700000000', button: { text: 'Sunt pe drum' } }] } }] }] };
    const sig2 = 'sha256=' + createHmac('sha256', 'meta-secret').update(JSON.stringify(presence)).digest('hex');
    expect((await request('/webhooks/whatsapp', presence, { 'X-Hub-Signature-256': sig2 })).status).toBe(200);
    const state = await request('/api/state').then(r => r.json()) as any;
    expect(state.counters.taxi.subscribers).toBe(1);
    expect(state.counters.taxi.sent).toBe(1);
    expect(state.presence.taxi.road).toBe(1);
    await expect.poll(() => viewer.messages.some(m => m.type === 'state' && m.data.presence.taxi.road === 1)).toBe(true);
    for (const [index, text, location] of [[3, 'Sunt în terminal', 'terminal'], [4, 'Nu am plecat încă', 'home'], [5, 'Plec acum', 'road']] as const) {
      const update = { entry: [{ changes: [{ value: { messages: [{ id: `wamid.${index}`, from: '40700000000', interactive: { button_reply: { title: text, id: text } } }] } }] }] };
      const signature = 'sha256=' + createHmac('sha256', 'meta-secret').update(JSON.stringify(update)).digest('hex');
      expect((await request('/webhooks/whatsapp', update, { 'X-Hub-Signature-256': signature })).status).toBe(200);
      expect((await request('/api/state').then(r => r.json()) as any).presence.taxi[location]).toBe(1);
    }
  });
  it('enforces CORS including upgrades, localhost and preflight', async () => {
    const good = await request('/health', undefined, { Origin: 'https://clarion-craiova.pages.dev' });
    expect(good.headers.get('Access-Control-Allow-Origin')).toBe('https://clarion-craiova.pages.dev');
    expect((await request('/health', undefined, { Origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await request('/health', undefined, { Origin: 'https://pages.dev.evil.com' })).status).toBe(403);
    const badWs = await mf.dispatchFetch('https://worker.example/ws?client=twin', { headers: { Upgrade: 'websocket', Origin: 'https://evil.com' } });
    expect(badWs.status).toBe(403);
    expect((await mf.dispatchFetch('https://worker.example/api/action', { method: 'OPTIONS', headers: { Origin: 'https://branch.clarion-craiova.pages.dev' } })).status).toBe(204);
  });
});

import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

let mf: Miniflare;
const persist = resolve('.test-state', crypto.randomUUID());
const sockets: { close(): void }[] = [];
const envelope = (type: string, data = {}) => ({ type, ts: new Date().toISOString(), data });
function start(simSpeed = '60000') {
  return new Miniflare(convertV4MiniflareOptions({
    name: 'clarion-test', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    resourcePersistencePath: persist, unsafeInspectDurableObjects: true,
    bindings: { SIM_SPEED: simSpeed, TELEGRAM_WEBHOOK_SECRET: 'test-secret',
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
async function detect() {
  const twin = await connect('twin');
  twin.ws.send(JSON.stringify(envelope('drone.detected', { distanceM: 2000, bearingDeg: 270, nearRunway: '27', source: 'radar' })));
  await expect.poll(() => twin.messages.some(m => m.type === 'state' && m.data.phase === 'detection')).toBe(true);
  return twin;
}
beforeAll(async () => { await mkdir(persist, { recursive: true }); mf = start(); });
beforeEach(async () => { for (const ws of sockets.splice(0)) ws.close(); await action('console.reset'); });
afterAll(async () => { for (const ws of sockets) ws.close(); await mf.dispose(); await rm(persist, { recursive: true, force: true }); });

describe('Worker + SQLite Tower in workerd', () => {
  it('connects, broadcasts detection and confirms suspension over HTTP', async () => {
    const viewer = await connect('viewer');
    expect(viewer.messages[0].data.phase).toBe('normal');
    await detect();
    const state = await action('console.confirm_suspension');
    expect(state.phase).toBe('suspended');
    expect(state.drafts.length).toBeGreaterThan(0);
    expect(state.drone.distanceM).toBe(2000);
    await expect.poll(() => viewer.messages.some(m => m.type === 'state' && m.data.phase === 'suspended')).toBe(true);
    expect((await request('/waze/cifs.json').then(r => r.json()) as any).incidents).toHaveLength(1);
  });
  it('accepts console actions via WS and rejects viewer mutations', async () => {
    await detect();
    const consoleClient = await connect('console');
    consoleClient.ws.send(JSON.stringify(envelope('console.confirm_suspension')));
    await expect.poll(() => consoleClient.messages.some(m => m.type === 'state' && m.data.phase === 'suspended')).toBe(true);
    const viewer = await connect('viewer');
    viewer.ws.send(JSON.stringify(envelope('console.reset')));
    await expect.poll(() => viewer.messages.some(m => m.type === 'error')).toBe(true);
    expect((await request('/api/state').then(r => r.json()) as any).phase).toBe('suspended');
  });
  it('subscribes, returns a Telegram deep link, validates consent and preserves subscriptions on reset', async () => {
    const response = await request('/api/subscribe', { role: 'relative_arrivals', flight: 'W63412', channel: 'telegram', lang: 'en', consent: true, source: 'relative' });
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.subscriptionId).toMatch(/^[\da-f-]{36}$/);
    expect(body.telegramLink).toContain('start=relative_arrivals__W63412__');
    expect((await request('/api/subscribe', { role: 'taxi', channel: 'telegram', lang: 'ro', consent: false })).status).toBe(400);
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
  });
  it('authenticates Telegram, binds private Start and deduplicates update IDs', async () => {
    const update = { update_id: 100, message: { text: '/start passenger_home__', chat: { id: 123, type: 'private' } } };
    expect((await request('/webhooks/telegram', update)).status).toBe(403);
    const headers = { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' };
    expect((await request('/webhooks/telegram', update, headers)).status).toBe(200);
    expect((await request('/webhooks/telegram', update, headers)).status).toBe(200);
    expect((await request('/api/state').then(r => r.json()) as any).counters.passenger_home.subscribers).toBe(1);
    const group = { update_id: 101, message: { text: '/start staff__', chat: { id: -1, type: 'group' } } };
    await request('/webhooks/telegram', group, headers);
    expect((await request('/api/state').then(r => r.json()) as any).counters.staff.subscribers).toBe(0);
    expect(await request('/api/telegram').then(r => r.json())).toEqual({ enabled: false, botUsername: null, deepLinkExample: null });
  });
  it('uses alarms to advance seeded twin reads without incoming traffic', async () => {
    const twin = await detect();
    twin.ws.send(JSON.stringify(envelope('agent.register', { agents: [{ agentId: 'alarm-test', role: 'public', channel: 'telegram' }] })));
    await expect.poll(() => twin.messages.some(m => m.type === 'state' && m.data.counters.public.subscribers === 1)).toBe(true);
    await action('console.confirm_suspension');
    await action('console.approve_messages', { roles: ['public'] });
    await expect.poll(() => twin.messages.some(m => m.type === 'agent.notified' && m.data.state === 'read')).toBe(true);
    const state = await request('/api/state').then(r => r.json()) as any;
    expect(state.counters.public.delivered).toBe(1);
    expect(state.counters.public.read).toBe(1);
    expect(state.metrics.readRecipients).toBe(1);
    expect(state.metrics.notifiedFirstMinute).toBe(1);
  });
  it('restores socket roles and pending alarms after hibernation', async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await mf.dispose();
    mf = start('60');
    await action('console.reset');
    const twin = await detect();
    const operator = await connect('console');
    twin.ws.send(JSON.stringify(envelope('agent.register', { agents: [{ agentId: 'alarm-test', role: 'public', channel: 'telegram' }] })));
    await expect.poll(() => twin.messages.some(m => m.type === 'state' && m.data.counters.public.subscribers === 1)).toBe(true);
    await action('console.confirm_suspension');
    await action('console.approve_messages', { roles: ['public'] });
    const storage = await mf.unsafeGetDurableObjectStorage('clarion-test', 'Tower', { name: 'tower' });
    const [row] = await storage.exec('SELECT value FROM engine_snapshot WHERE id = 1');
    expect(JSON.parse(String(row!.value)).receipts.some((r: any) => r.readAt > Date.now() && !r.read)).toBe(true);
    await mf.unsafeEvictDurableObject('clarion-test', 'Tower', { name: 'tower', webSockets: 'hibernate' });
    await expect.poll(() => twin.messages.some(m => m.type === 'agent.notified' && m.data.state === 'read'), { timeout: 15000 }).toBe(true);
    operator.ws.send(JSON.stringify(envelope('console.reopen')));
    await expect.poll(() => operator.messages.some(m => m.type === 'state' && m.data.phase === 'recovery')).toBe(true);
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
  it('persists incident, subscriptions and private metric deduplication through isolate restart', async () => {
    const twin = await detect();
    twin.ws.send(JSON.stringify(envelope('agent.register', { agents: [{ agentId: 'persist-test', role: 'public', channel: 'telegram' }] })));
    await expect.poll(() => twin.messages.some(m => m.type === 'state' && m.data.counters.public.subscribers === 1)).toBe(true);
    await action('console.confirm_suspension');
    await action('console.approve_messages', { roles: ['public'] });
    await expect.poll(() => twin.messages.some(m => m.type === 'agent.notified' && m.data.state === 'read'), { timeout: 15000 }).toBe(true);
    await expect.poll(async () => {
      const storage = await mf.unsafeGetDurableObjectStorage('clarion-test', 'Tower', { name: 'tower' });
      const [row] = await storage.exec('SELECT value FROM engine_snapshot WHERE id = 1');
      return JSON.parse(String(row!.value)).receipts.every((r: any) => !r.actAt || r.acted);
    }, { timeout: 15000 }).toBe(true);
    const before = await request('/api/state').then(r => r.json()) as any;
    for (const ws of sockets.splice(0)) ws.close();
    await mf.dispose();
    mf = start();
    const after = await request('/api/state').then(r => r.json()) as any;
    expect(after.phase).toBe('suspended');
    expect(after.drone).toEqual(before.drone);
    expect(after.counters).toEqual(before.counters);
    expect(after.metrics).toEqual(before.metrics);
  });
});

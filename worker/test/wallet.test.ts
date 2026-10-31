import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mf: Miniflare | undefined;
let dir: string;
let key: CryptoKey;
let bindings: Record<string, string>;
const calls: { url: string; method: string; body: any; authorization: string | null }[] = [];
const envelope = (type: string, data = {}) => ({ type, ts: new Date().toISOString(), data });
function start(credentials = false) {
  return new Miniflare(convertV4MiniflareOptions({
    name: 'wallet-test', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } }, resourcePersistencePath: dir,
    bindings: { WAVES_ENABLED: 'false', ...(credentials ? bindings : {}) },
    outboundService: async request => {
      if (request.url.includes('fids.flightradar.live')) return Response.json([]);
      const text = await request.text();
      calls.push({ url: request.url, method: request.method,
        body: request.url.includes('oauth2') ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text || '{}'),
        authorization: request.headers.get('Authorization') });
      return Response.json(request.url.includes('oauth2') ? { access_token: 'test-access-token', expires_in: 3600 } : {});
    },
  }));
}
async function post(path: string, body: unknown) {
  return mf!.dispatchFetch(`https://worker.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function action(type: string) {
  const response = await post('/api/action', envelope(type));
  expect(response.status).toBe(200);
}
async function subscribe() {
  const response = await post('/api/subscribe', { role: 'relative_arrivals', flight: 'W6 3412', channel: 'telegram', lang: 'ro', consent: true });
  expect(response.status).toBe(201);
  return await response.json() as { subscriptionId: string };
}
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  key = pair.publicKey;
  bindings = { GOOGLE_WALLET_ISSUER_ID: '123456', GOOGLE_WALLET_SA_EMAIL: 'test@example.invalid',
    GOOGLE_WALLET_SA_KEY: `-----BEGIN PRIVATE KEY-----\\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')}\\n-----END PRIVATE KEY-----` };
});
afterEach(async () => { await mf?.dispose(); mf = undefined; if (dir) await rm(dir, { recursive: true, force: true }); calls.length = 0; });

it('serves demo fallback and validates subscription IDs in workerd', async () => {
  dir = await mkdtemp(join(tmpdir(), 'wallet-worker-'));
  mf = start();
  expect((await post('/api/wallet/pass', {})).status).toBe(400);
  expect((await post('/api/wallet/pass', { subscriptionId: 'missing' })).status).toBe(400);
  const { subscriptionId } = await subscribe();
  expect(await post('/api/wallet/pass', { subscriptionId }).then(r => r.json())).toEqual({ demo: true, saveUrl: `/join/wallet-demo?sub=${subscriptionId}` });
  expect(calls).toHaveLength(0);
});
it('signs in workerd, updates after confirmation, and preserves the cap across a DO restart', async () => {
  dir = await mkdtemp(join(tmpdir(), 'wallet-worker-'));
  mf = start(true);
  const { subscriptionId } = await subscribe();
  const pass = await post('/api/wallet/pass', { subscriptionId }).then(r => r.json()) as { saveUrl: string; demo: boolean };
  expect(pass.demo).toBe(false);
  const [header, body, signature] = pass.saveUrl.split('/save/')[1]!.split('.') as [string, string, string];
  expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe('RS256');
  expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, new Uint8Array(Buffer.from(signature, 'base64url')), new TextEncoder().encode(`${header}.${body}`))).toBe(true);
  expect(JSON.parse(Buffer.from(body, 'base64url').toString()).payload.genericObjects[0].header.defaultValue.value).toBe('Clarion');
  const response = await mf.dispatchFetch('https://worker.example/ws?client=twin', { headers: { Upgrade: 'websocket' } });
  const ws = response.webSocket!;
  ws.accept();
  const phases: string[] = [];
  ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.type === 'state') phases.push(m.data.phase); });
  ws.send(JSON.stringify(envelope('ops.suspended', { reason: 'drone', estimatedReopen: new Date(Date.now() + 600000).toISOString() })));
  await expect.poll(() => phases.includes('detection')).toBe(true);
  expect(calls).toHaveLength(0);
  await action('console.confirm_suspension');
  const patches = () => calls.filter(c => c.method === 'PATCH');
  const notifications = () => calls.filter(c => c.url.endsWith('/addMessage'));
  expect(patches()).toHaveLength(1);
  expect(patches()[0]!.body.textModulesData[2].body).toContain('suspendate');
  expect(notifications()).toHaveLength(1);
  expect(notifications()[0]!.authorization).toBe('Bearer test-access-token');
  expect(notifications()[0]!.body.message.messageType).toBe('TEXT_AND_NOTIFY');
  await action('console.reopen');
  await action('console.reopen');
  expect(notifications()).toHaveLength(3);
  ws.close();
  await mf.dispose();
  mf = start(true);
  await action('console.reset');
  const next = await mf.dispatchFetch('https://worker.example/ws?client=twin', { headers: { Upgrade: 'websocket' } });
  const twin = next.webSocket!;
  twin.accept();
  const states: string[] = [];
  twin.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.type === 'state') states.push(m.data.phase); });
  twin.send(JSON.stringify(envelope('ops.suspended', { reason: 'weather', estimatedReopen: new Date(Date.now() + 600000).toISOString() })));
  await expect.poll(() => states.includes('detection')).toBe(true);
  await action('console.confirm_suspension');
  expect(patches()).toHaveLength(4);
  expect(notifications()).toHaveLength(3);
  twin.close();
});

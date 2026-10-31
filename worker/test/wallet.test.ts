import { Miniflare,Response,convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,beforeAll,expect,it } from 'vitest';

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
    bindings: { ...(credentials ? bindings : {}) },
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
  const response = await post('/api/subscribe', { role: 'relative_arrivals', flight: 'W6 3412', channel: 'whatsapp', lang: 'ro', consent: true });
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
it('signs a verifiable Wallet pass in workerd', async () => {
  dir = await mkdtemp(join(tmpdir(), 'wallet-worker-'));
  mf = start(true);
  const { subscriptionId } = await subscribe();
  const pass = await post('/api/wallet/pass', { subscriptionId }).then(r => r.json()) as { saveUrl: string; demo: boolean };
  expect(pass.demo).toBe(false);
  const [header, body, signature] = pass.saveUrl.split('/save/')[1]!.split('.') as [string, string, string];
  expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe('RS256');
  expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, new Uint8Array(Buffer.from(signature, 'base64url')), new TextEncoder().encode(`${header}.${body}`))).toBe(true);
  expect(JSON.parse(Buffer.from(body, 'base64url').toString()).payload.genericObjects[0].header.defaultValue.value).toBe('Clarion');
});

it('issues a flight JWT and usable join token for the default demo schedule', async () => {
  dir = await mkdtemp(join(tmpdir(), 'wallet-worker-'));
  mf = start(true);
  const response = await post('/api/join/demo', {});
  expect(response.status).toBe(201);
  const result = await response.json() as { bcbp: string; token: string; waLink: string; walletUrl: string };
  expect(result.bcbp).toHaveLength(60);
  expect(result.bcbp.slice(30, 44)).toBe('CRALTNW6 03751');
  expect(result.token).toMatch(/^[a-f0-9]{48}$/);
  expect(new URL(result.waLink).searchParams.get('text')).toBe(`START W6 3751 ${result.token}`);
  const [, body] = result.walletUrl.split('/save/')[1]!.split('.');
  const payload = JSON.parse(Buffer.from(body!, 'base64url').toString()).payload;
  expect(payload.flightObjects[0].barcode).toEqual({ type: 'PDF_417', value: result.bcbp });
  expect(payload.flightObjects[0].linksModuleData.uris[0].uri).toBe(result.waLink);
  expect(payload.flightClasses[0].localScheduledDepartureDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T09:40:00$/);
  expect((await post('/api/wallet/pass', { joinToken: result.token })).status).toBe(200);
});

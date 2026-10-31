import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createControlTower } from '../src/server.js';
const dir = mkdtempSync(join(tmpdir(), 'auth-http-'));
let server: ReturnType<typeof createControlTower>, base: string;
beforeAll(async () => {
  vi.stubEnv('STATE_FILE', join(dir, 'state.json'));
  vi.stubEnv('WHATSAPP_APP_SECRET', 'local-secret');
  vi.stubEnv('WHATSAPP_TOKEN', '');
  vi.stubEnv('WA_TOKEN', '');
  vi.stubGlobal('fetch', vi.fn(fetch));
  server = createControlTower();
  await new Promise<void>(r => server.http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await server.stop(); rmSync(dir, { recursive: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
const post = (path: string, body: unknown, session?: string) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(session && { Authorization: `Bearer ${session}` }) }, body: JSON.stringify(body),
});
it('shares signed reverse login, join, persistent sessions and logout in Node', async () => {
  const pending = await (await post('/api/auth/login-code', {})).json();
  expect(await (await fetch(`${base}/api/auth/login-code/${pending.pollToken}`)).json()).toEqual({ status: 'pending' });
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'node-login', from: '40712345678', type: 'text', text: { body: `LOGIN ${pending.code}` } }] } }] }] });
  expect((await post('/webhooks/whatsapp', JSON.parse(raw))).status).toBe(403);
  const signed = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', body: raw, headers: {
    'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'local-secret').update(raw).digest('hex'),
  } });
  expect(signed.status).toBe(200);
  let result: any;
  await vi.waitFor(async () => {
    result = await (await fetch(`${base}/api/auth/login-code/${pending.pollToken}`)).json();
    expect(result.status).toBe('ok');
  });
  const me = () => fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${result.session}` } });
  expect(await (await me()).json()).toEqual({ phone: '+40712345678', role: 'passenger' });
  expect((await post('/api/join', { flight: 'W6 3751' }, result.session)).status).toBe(201);
  expect(await (await me()).json()).toMatchObject({ flight: 'W6 3751' });
  expect(await (await post('/api/auth/otp', { phone: '0799 999 999' })).json()).toEqual({ sent: false, reason: 'window' });
  expect(await (await post('/api/auth/otp', { phone: '0712 345 678' })).json()).toEqual({ sent: false, reason: 'delivery' });
  await server.stop();
  server = createControlTower();
  await new Promise<void>(r => server.http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
  expect(await (await me()).json()).toMatchObject({ phone: '+40712345678', flight: 'W6 3751' });
  expect((await post('/api/auth/logout', {}, result.session)).status).toBe(200);
  expect((await me()).status).toBe(401);
});

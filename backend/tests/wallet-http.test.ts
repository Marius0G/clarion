import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createControlTower } from '../src/server.js';
const dir = mkdtempSync(join(tmpdir(), 'wallet-http-'));
let server: ReturnType<typeof createControlTower>;
let base: string;
beforeAll(async () => {
  vi.stubEnv('STATE_FILE', join(dir, 'state.json'));
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  vi.stubEnv('GOOGLE_WALLET_ISSUER_ID', '');
  vi.stubGlobal('fetch', async () => Response.json([]));
  server = createControlTower();
  vi.unstubAllGlobals();
  await new Promise<void>(r => server.http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
});
afterAll(async () => { await server.stop(); rmSync(dir, { recursive: true }); vi.unstubAllEnvs(); });
it('serves the Node pass endpoint and fires its console suspension hook', async () => {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post('/api/wallet/pass', {})).status).toBe(400);
  const sub = await post('/api/subscribe', { role: 'taxi', channel: 'telegram', lang: 'ro', consent: true }).then(r => r.json());
  expect(await post('/api/wallet/pass', { subscriptionId: sub.subscriptionId }).then(r => r.json())).toEqual({ demo: true, saveUrl: `/join/wallet-demo?sub=${sub.subscriptionId}` });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await server.engine.handle({ type: 'ops.suspended', ts: new Date().toISOString(), data: { reason: 'weather', estimatedReopen: new Date(Date.now() + 600000).toISOString() } }, 'twin');
    expect((await post('/api/action', { type: 'console.confirm_suspension', ts: new Date().toISOString(), data: {} })).status).toBe(200);
    expect(log.mock.calls.some(([value]) => JSON.parse(String(value)).channel === 'wallet')).toBe(true);
  } finally { log.mockRestore(); }
});

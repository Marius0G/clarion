import { mkdtempSync,rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { createControlTower } from '../src/server.js';
const dir = mkdtempSync(join(tmpdir(), 'wallet-http-'));
let server: ReturnType<typeof createControlTower>;
let base: string;
beforeAll(async () => {
  vi.stubEnv('STATE_FILE', join(dir, 'state.json'));
  vi.stubEnv('GOOGLE_WALLET_ISSUER_ID', '');
  vi.stubGlobal('fetch', async () => Response.json([]));
  server = createControlTower();
  vi.unstubAllGlobals();
  await new Promise<void>(r => server.http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
});
afterAll(async () => { await server.stop(); rmSync(dir, { recursive: true }); vi.unstubAllEnvs(); });
it('serves the Node pass endpoint', async () => {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post('/api/wallet/pass', {})).status).toBe(400);
  const sub = await post('/api/subscribe', { role: 'taxi', channel: 'whatsapp', lang: 'ro', consent: true }).then(r => r.json());
  expect(await post('/api/wallet/pass', { subscriptionId: sub.subscriptionId }).then(r => r.json())).toEqual({ demo: true, saveUrl: `/join/wallet-demo?sub=${sub.subscriptionId}` });
});

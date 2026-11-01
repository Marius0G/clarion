import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createControlTower } from '../src/server.js';
import { socketContract, ticketContract, type ChatHarness } from './chat-ws-contract.js';
const dir = mkdtempSync(join(tmpdir(), 'chat-ws-'));
let server: ReturnType<typeof createControlTower>, base: string;
let sequence = 0;
const actualFetch = fetch;
beforeAll(async () => {
  vi.stubEnv('STATE_FILE', join(dir, 'state.json'));
  vi.stubEnv('WHATSAPP_APP_SECRET', 'ws-secret');
  vi.stubEnv('WHATSAPP_TOKEN', 'token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'PN1');
  vi.stubEnv('WA_ALLOWLIST', '+40712345678,+40722222222');
  vi.stubEnv('STAFF_PHONES', '');
  vi.stubEnv('DEMO_TOKEN', '');
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1')) return actualFetch(input, init);
    return Response.json(url.includes('graph.facebook.com') ? { messages: [{ id: 'out' }] } : []);
  });
  server = createControlTower();
  await new Promise<void>(r => server.http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
});
afterAll(async () => { await server.stop(); rmSync(dir, { recursive: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const harness: ChatHarness = {
  post: (path, body, session) => fetch(`${base}${path}`, { method: 'POST', headers: { ...(session && { Authorization: `Bearer ${session}` }) }, body: JSON.stringify(body) }),
  get: async (path, session) => (await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${session}` } })).json(),
  open: ticket => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?client=person&ticket=${ticket}`);
    const events: any[] = [];
    const closed = new Promise<number>(r => ws.once('close', code => r(code)));
    ws.on('message', raw => events.push(JSON.parse(raw.toString())));
    ws.once('error', reject);
    ws.once('open', () => resolve({ events, closed, send: value => ws.send(JSON.stringify(value)), close: () => ws.close(1000) }));
  }),
  webhook: async (text, phone) => {
    const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, messages: [{ id: `ws-${++sequence}`, from: phone, type: 'text', text: { body: text } }] } }] }] });
    await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', body: raw, headers: { 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'ws-secret').update(raw).digest('hex') } });
  },
};
ticketContract();
socketContract(() => harness);

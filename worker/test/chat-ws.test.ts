import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { socketContract, ticketContract, type ChatHarness, type Peer } from '../../backend/tests/chat-ws-contract.js';
let mf: Miniflare;
let sequence = 0;
beforeAll(() => {
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'chat-ws', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    bindings: { WHATSAPP_APP_SECRET: 'ws-secret', WHATSAPP_TOKEN: 'token', WHATSAPP_PHONE_NUMBER_ID: 'PN1', WA_ALLOWLIST: '+40712345678,+40722222222' },
    outboundService: async request => Response.json(request.url.includes('graph.facebook.com') ? { messages: [{ id: 'out' }] } : []),
  }));
});
afterAll(async () => mf.dispose());
const harness: ChatHarness = {
  hibernate: () => mf.unsafeEvictDurableObject('chat-ws', 'Tower', { name: 'tower', webSockets: 'hibernate' }),
  post: (path, body, session) => mf.dispatchFetch(`https://worker.example${path}`, { method: 'POST', headers: { ...(session && { Authorization: `Bearer ${session}` }) }, body: JSON.stringify(body) }),
  get: async (path, session) => (await mf.dispatchFetch(`https://worker.example${path}`, { headers: { Authorization: `Bearer ${session}` } })).json(),
  open: async ticket => {
    const response = await mf.dispatchFetch(`https://worker.example/ws?client=person&ticket=${ticket}`, { headers: { Upgrade: 'websocket' } });
    const ws = response.webSocket!;
    const events: any[] = [];
    const closed = new Promise<number>(resolve => ws.addEventListener('close', e => resolve(e.code)));
    ws.addEventListener('message', e => events.push(JSON.parse(String(e.data))));
    ws.accept();
    return { events, closed, send: value => ws.send(JSON.stringify(value)), close: () => ws.close(1000) } satisfies Peer;
  },
  webhook: async (text, phone) => {
    const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, messages: [{ id: `ws-${++sequence}`, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
    await mf.dispatchFetch('https://worker.example/webhooks/whatsapp', { method: 'POST', body: raw, headers: { 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'ws-secret').update(raw).digest('hex') } });
  },
};
ticketContract();
socketContract(() => harness);

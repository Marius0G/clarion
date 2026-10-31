import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
let mf: Miniflare;
const graph: any[] = [];
beforeAll(() => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'lab', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    bindings: { DEMO_TOKEN: 'operator', WHATSAPP_APP_SECRET: 'secret', WHATSAPP_TOKEN: 'token', WHATSAPP_PHONE_NUMBER_ID: 'PN1' },
    outboundService: async request => {
      if (request.url.startsWith('https://graph.facebook.com')) {
        graph.push(await request.json());
        return Response.json({ error: { code: 131030 } }, { status: 400 });
      }
      return Response.json([]);
    },
  }));
});
afterAll(async () => { await mf.dispose(); });
const auth = { authorization: 'Bearer operator', 'content-type': 'application/json' };
const run = (body: unknown, headers = auth) => mf.dispatchFetch('https://worker.example/lab/run', { method: 'POST', headers, body: JSON.stringify(body) });
it('serves the page, gates both lab APIs, rejects malformed runs and captures every outbound send', async () => {
  const page = await mf.dispatchFetch('https://worker.example/lab');
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('Live');
  expect((await run({}, {} as typeof auth)).status).toBe(401);
  expect((await mf.dispatchFetch('https://worker.example/lab/events')).status).toBe(401);
  expect((await run({ script: 'constructor' })).status).toBe(400);
  const report = await run({}).then(r => r.json()) as any;
  expect(report.results.startFlight.transcript[0].replies.join(' ')).toContain('W6 3751');
  expect(report.results.evacuation.transcript.at(-1).replies.join(' ')).toMatch(/evacua/i);
  expect(report.pass, JSON.stringify(report.failed.map((n: string) => [n, report.results[n].violations]))).toBe(true);
  expect(graph).toHaveLength(0);
  expect(await mf.dispatchFetch('https://worker.example/lab/events', { headers: auth }).then(r => r.json())).toEqual({ events: [] });
});
it('records real webhook turns, outbound Meta failures and delivery statuses with masked phones', async () => {
  const body = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, messages: [{ id: 'real-message', from: '40712345678', type: 'text', text: { body: 'English' } }], statuses: [{ status: 'failed', recipient_id: '40712345678', errors: [{ code: 131047 }] }] } }] }] };
  const raw = JSON.stringify(body);
  const response = await mf.dispatchFetch('https://worker.example/webhooks/whatsapp', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'secret').update(raw).digest('hex') } });
  expect(response.status).toBe(200);
  const events = async () => (await mf.dispatchFetch('https://worker.example/lab/events', { headers: auth }).then(r => r.json()) as any).events as any[];
  await expect.poll(async () => (await events()).some(e => e.kind === 'turn')).toBe(true);
  const rows = await events();
  expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'inbound', phone: '•••678', text: 'English' }),
    expect.objectContaining({ kind: 'turn', tools: [], bubbles: 1 }), expect.objectContaining({ kind: 'send-failure', code: 131030, explanation: expect.stringContaining('allowed list') }),
    expect.objectContaining({ kind: 'send-failure', code: 131047, explanation: expect.stringContaining('24h') })]));
  expect(JSON.stringify(rows)).not.toContain('40712345678');
});
it('refuses lab APIs when DEMO_TOKEN is unset', async () => {
  const empty = new Miniflare(convertV4MiniflareOptions({ name: 'no-token', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30', durableObjects: { TOWER: { className: 'Tower', useSQLite: true } } }));
  try { expect((await empty.dispatchFetch('https://worker.example/lab/events', { headers: auth })).status).toBe(401); }
  finally { await empty.dispose(); }
});
it('keeps an issued-token passenger visible to the real page and ops fan-out, captures sends, then cleans up', async () => {
  const phone = 'lab-e2e-11111111-1111-4111-8111-111111111111';
  const api = (path: string, body?: unknown) => mf.dispatchFetch(`https://worker.example${path}`, { method: body === undefined ? 'GET' : 'POST', headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
  const original: any = await api('/api/sim').then(r => r.json());
  const graphBefore = graph.length;
  const joined: any = await api('/api/join', { flight: 'W6 3751', lang: 'ro' }).then(r => r.json());
  const report: any = await run({ phone, keep: true, texts: [new URL(joined.waLink).searchParams.get('text'), 'English', 'What is my gate?'] }).then(r => r.json());
  expect(report.pass, JSON.stringify(report)).toBe(true);
  expect(report.results.custom.stored.profile).toMatchObject({ verified: true, flight: 'W6 3751', lang: 'en' });
  expect(graph).toHaveLength(graphBefore);
  const pageToken = report.results.custom.stored.profile.pageToken;
  const passenger = async (): Promise<any> => api(`/api/me?token=${pageToken}`).then(r => r.json());
  expect(await passenger()).toMatchObject({ flight: { flight: 'W6 3751' }, lang: 'en', queues: expect.any(Array) });
  // Issued joins are single-use, including when claimed through the isolated lab.
  expect((await run({ texts: [new URL(joined.waLink).searchParams.get('text')] })).status).toBe(500);
  const socket = (await mf.dispatchFetch('https://worker.example/ws?client=twin&token=operator', { headers: { Upgrade: 'websocket' } })).webSocket!;
  socket.accept();
  try {
    const gate = (await passenger()).flight.gate;
    expect((await api('/lab/alert-ready', { phone: '+40712345678' })).status).toBe(400);
    expect((await api('/lab/alert-ready', { phone })).status).toBe(200);
    expect((await api('/api/ops/command', { type: 'close', zone: gate })).status).toBe(202);
    await expect.poll(async () => (await passenger()).alerts.some((a: any) => a.kind === 'admin')).toBe(true);
    const rows: any = await api('/lab/events').then(r => r.json());
    expect(rows.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'lab-out', phone, type: 'text', ok: true })]));
    expect(graph).toHaveLength(graphBefore);
    const alert = (await passenger()).alerts.find((a: any) => a.kind === 'admin');
    expect(alert.text).toMatch(/closed/i);
    expect(alert.text).not.toMatch(/\p{Extended_Pictographic}|\p{Regional_Indicator}/u);
    expect((await api('/api/ops/command', { type: 'open', zone: gate })).status).toBe(202);
    // Do not permit deleting arbitrary real passenger identities.
    expect((await api('/lab/cleanup', { phone: '+40712345678' })).status).toBe(400);
    expect((await api('/lab/cleanup', { phone })).status).toBe(200);
    expect((await api('/api/me?token=' + pageToken)).status).toBe(404);
    expect((await api('/lab/cleanup', { phone })).status).toBe(200);
    expect((await api('/api/sim').then(r => r.json()) as any).lanes).toEqual(original.lanes);
  } finally { socket.close(); }
});

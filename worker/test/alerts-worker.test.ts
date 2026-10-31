import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
let mf: Miniflare;
const sockets: { close(): void }[] = [];
beforeAll(() => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'alerts', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } }, outboundService: async () => Response.json([]),
    bindings: { DEMO_TOKEN: 'op', SIM_SPEED: '10', STAFF_CODE: 'echipa', WHATSAPP_APP_SECRET: 'meta-secret', WHATSAPP_PHONE_NUMBER_ID: 'PN1' } }));
});
afterAll(async () => { for (const ws of sockets) ws.close(); await mf.dispose(); });
const envelope = (type: string, data = {}) => ({ type, ts: new Date().toISOString(), data });
const api = (path: string, body?: unknown, token = 'op') => mf.dispatchFetch(`https://worker.example${path}`, {
  method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
});
const sim = () => api('/api/sim').then(r => r.json()) as Promise<any>;
async function connect(client: string) {
  const r = await mf.dispatchFetch(`https://worker.example/ws?client=${client}&token=op`, { headers: { Upgrade: 'websocket' } });
  const ws = r.webSocket!; const messages: any[] = [];
  ws.addEventListener('message', e => messages.push(JSON.parse(String(e.data)))); ws.accept(); sockets.push(ws);
  await expect.poll(() => messages.some(m => m.type === 'state')).toBe(true);
  return { ws, messages, send: (type: string, data: any) => ws.send(JSON.stringify(envelope(type, data))) };
}
async function whatsapp(text: string) {
  const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' },
    messages: [{ id: `wamid.${crypto.randomUUID()}`, from: '40700000000', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return mf.dispatchFetch('https://worker.example/webhooks/whatsapp', { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'meta-secret').update(raw).digest('hex') } });
}
it('computes camera alerts in the live runtime, isolates truth, authorizes commands and expires shelving in simTime', async () => {
  const twin = await connect('twin'); const vision = await connect('vision'); const consoleClient = await connect('console');
  const status = (simTime: number) => twin.send('sim.status', { running: true, scenario: 'rush', arm: 'B', coverage: 1, seed: 1, simTime, speed: 10, agents: 0 });
  status(54000);
  await expect.poll(async () => (await sim()).simTime).toBe(54000);
  twin.send('truth.report', { zones: [{ zone: 'security', waiting: 900, waitMin: 100 }] });
  await expect.poll(async () => (await sim()).truth?.zones.security.waiting).toBe(900);
  expect((await sim()).alerts).toEqual([]);
  vision.send('flow.report', { zones: [{ zone: 'security', waiting: 30, waitMin: 12, coverage: 1, density: 0.5, forecast: [{ inMin: 30, waitMin: 18 }] }] });
  await expect.poll(async () => (await sim()).alerts.filter((a: any) => a.active).length).toBe(2);
  const id = (await sim()).alerts.find((a: any) => a.kind === 'zone-target').id;
  expect((await api('/api/alerts/command', { type: 'ack', id }, '')).status).toBe(401);
  twin.send('console.alert.command', { type: 'ack', id });
  await expect.poll(() => twin.messages.some(m => m.type === 'error' && m.data.message.includes('Client cannot'))).toBe(true);
  const acked = await api('/api/alerts/command', { type: 'ack', id }).then(r => r.json()) as any;
  expect(acked.alerts.find((a: any) => a.id === id).state).toBe('acked');
  await expect.poll(() => consoleClient.messages.some(m => m.type === 'state' && m.data.alerts.some((a: any) => a.id === id && a.state === 'acked'))).toBe(true);
  expect((await api('/api/alerts/command', { type: 'shelve', id, durationSec: 60, reason: '' })).status).toBe(400);
  expect((await api('/api/alerts/command', { type: 'ack', id: 'unknown' })).status).toBe(400);
  await api('/api/alerts/command', { type: 'shelve', id, durationSec: 60, reason: 'Verificare' });
  status(54059);
  await expect.poll(async () => (await sim()).simTime).toBe(54059);
  expect((await sim()).alerts.find((a: any) => a.id === id).state).toBe('shelved');
  status(54060);
  await expect.poll(async () => (await sim()).alerts.find((a: any) => a.id === id).state).toBe('unacked');
  vision.send('flow.report', { zones: [{ zone: 'security', waiting: 0, waitMin: 0, coverage: 1 }] });
  await expect.poll(async () => (await sim()).alerts.find((a: any) => a.id === id).state).toBe('cleared-unacked');
  consoleClient.send('console.alert.command', { type: 'ack', id });
  await expect.poll(async () => (await sim()).alerts.find((a: any) => a.id === id).state).toBe('acked');
  expect(twin.messages.filter(m => m.type === 'ops.command')).toEqual([]);
});
it('turns real staff report storage changes into P1 alerts and clears on report close', async () => {
  expect((await whatsapp('STAFF echipa')).status).toBe(200);
  // Webhook responses precede background processing; the next inbound is serialized by the same agent.
  expect((await whatsapp('Bătaie la poarta 3')).status).toBe(200);
  await expect.poll(async () => (await sim()).alerts.some((a: any) => a.kind === 'staff-security' && a.active)).toBe(true);
  const reports = await api('/api/reports').then(r => r.json()) as any[];
  const report = reports.find(r => r.kind === 'securitate');
  expect(report).toBeTruthy();
  expect((await api(`/api/reports/${report.id}/close`, {})).status).toBe(200);
  expect((await sim()).alerts.find((a: any) => a.kind === 'staff-security')).toMatchObject({ state: 'cleared-unacked', active: false, priority: 'P1', zoneId: 'gate_3', createdAt: 54060 });
});

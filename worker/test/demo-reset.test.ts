import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialLanes } from '../../backend/src/terminal.js';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Same workerd, socket capture and signed-webhook helpers as messaging-worker / wa-worker.
let mf: Miniflare;
const sockets: { close(): void }[] = [];
const outbound: { url: string; body: any }[] = [];
const toolResults: any[] = [];
const reportText = 'Bagaj abandonat lângă check-in Wizz';
let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'reset-worker-')); start(); });
function start() {
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'demo-reset', resourcePersistencePath: dir, modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    bindings: { DEMO_TOKEN: 'op', SIM_SPEED: '60', WHATSAPP_APP_SECRET: 'meta-secret', WHATSAPP_TOKEN: 'token', WHATSAPP_PHONE_NUMBER_ID: 'PN1', STAFF_CODE: 'echipa', ANTHROPIC_API_KEY: 'key' },
    outboundService: async request => {
      const body: any = request.method === 'POST' ? await request.json() : null;
      outbound.push({ url: request.url, body });
      if (request.url.startsWith('https://api.anthropic.com')) {
        const last = body.messages.at(-1).content;
        if (Array.isArray(last) && last[0]?.type === 'tool_result') {
          const result = JSON.parse(last[0].content);
          toolResults.push(result);
          return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: result.beAtEntranceAt
            ? `Fii la intrarea în terminal la ${result.beAtEntranceAt}.` : `Am primit (${result.id}).` }] });
        }
        const staff = String(last).includes(reportText);
        return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: staff ? 'report' : 'arrival',
          name: staff ? 'reportIssue' : 'whenToArrive', input: staff ? { text: reportText } : { hasCheckedBag: true } }] });
      }
      return Response.json(request.url.startsWith('https://graph.facebook.com') ? { messages: [{ id: 'wamid.out' }] } : []);
    },
  }));
}
afterAll(async () => { for (const ws of sockets.splice(0)) ws.close(); await mf.dispose(); await rm(dir, { recursive: true, force: true }); });
const envelope = (type: string, data: unknown) => JSON.stringify({ type, ts: new Date().toISOString(), data });
const api = (path: string, body?: unknown, token = 'op') => mf.dispatchFetch(`https://worker.example${path}`, {
  method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
});
const sim = async (): Promise<any> => (await api('/api/sim')).json();
async function connect(client: string) {
  const response = await mf.dispatchFetch(`https://worker.example/ws?client=${client}&token=op`, { headers: { Upgrade: 'websocket' } });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const messages: any[] = [];
  ws.addEventListener('message', e => messages.push(JSON.parse(String(e.data))));
  ws.accept(); sockets.push(ws);
  await expect.poll(() => messages.some(m => m.type === 'state')).toBe(true);
  return { send: (type: string, data: unknown) => ws.send(envelope(type, data)), of: (type: string) => messages.filter(m => m.type === type).map(m => m.data) };
}
let inboundId = 0;
async function whatsapp(text: string, replyId?: string) {
  const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' },
    messages: [{ id: `wamid.chain.${++inboundId}`, from: '40712345678', timestamp: String(Math.floor(Date.now() / 1000)),
      ...(replyId ? { type: 'interactive', interactive: { button_reply: { id: replyId, title: text } } } : { type: 'text', text: { body: text } }) }] } }] }] });
  const response = await mf.dispatchFetch('https://worker.example/webhooks/whatsapp', { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'meta-secret').update(raw).digest('hex') } });
  expect(response.status).toBe(200);
}
const texts = () => outbound.filter(o => o.url.startsWith('https://graph.facebook.com') && o.body?.type === 'text').map(o => o.body.text.body as string);
const flight = (extra = {}) => ({ flight: 'W6 3751', airline: 'W6', destination: 'Londra Luton', std: '09:40', gate: 'gate_2', checkIn: 'check_in:2', checkInDesks: [], gateCloseAt: '09:10', status: 'scheduled', delayMin: 0, pax: 180, ...extra });

it('requires the operator token', async () => {
  for (const token of ['', 'wrong']) expect((await api('/api/demo/reset', {}, token)).status).toBe(401);
});

it('clears the complete demo through real routes and sockets, persists deletion and cancels old timers', async () => {
  const initial = await sim();
  const twin = await connect('twin');
  const vision = await connect('vision');
  twin.send('sim.status', { running: true, scenario: 'S1', arm: 'B', coverage: 1, seed: 1, speed: 60, simTime: 25200, agents: 1 });
  twin.send('flight.update', { flights: [flight()] });
  twin.send('agent.register', { agents: [{ agentId: 'legacy', role: 'passenger_terminal', channel: 'whatsapp' }] });
  twin.send('agent.batch', { updates: [{ agentId: 'legacy', role: 'passenger_terminal', persona: 'test', location: 'terminal', phone: 'read', action: 'waiting' }] });
  twin.send('truth.report', { zones: [{ zone: 'security', waiting: 100 }] });
  vision.send('flow.report', { zones: [{ zone: 'security', waiting: 40, waitMin: 5 }] });
  vision.send('crowd.positions', { people: [{ x: 10, y: 12 }] });
  await expect.poll(sim).toMatchObject({ flights: [flight()], truth: { zones: { security: { waiting: 100 } } }, positions: { people: [{ x: 10, y: 12 }] } });
  const pending: any = await (await api('/api/join', { flight: 'W6 3751' })).json();
  const consumed: any = await (await api('/api/join', { flight: 'W6 3751', name: 'OldName' })).json();
  const subscribed: any = await (await api('/api/subscribe', { role: 'passenger_home', channel: 'whatsapp', lang: 'ro', consent: true })).json();
  expect((await api('/api/wallet/pass', { subscriptionId: subscribed.subscriptionId })).status).toBe(200);
  await whatsapp(`START W6 3751 ${consumed.token}`);
  await expect.poll(() => texts().some(t => t.includes('/m/'))).toBe(true);
  const oldPage = /\/m\/([a-f0-9-]+)/.exec(texts().find(t => t.includes('/m/'))!)![1];
  twin.send('agent.register', { agentId: 'sim1', role: 'passenger_terminal', channel: 'sim', flight: 'W6 3751' });
  await expect.poll(() => twin.of('agent.message').length).toBe(1);
  const simPage = /\/m\/([a-f0-9-]+)/.exec(twin.of('agent.message')[0].text)![1];
  await whatsapp('STAFF echipa');
  await whatsapp(reportText);
  await expect.poll(async () => (await api('/api/reports')).json(), { timeout: 10000 }).toMatchObject([{ id: 'R1' }]);
  expect((await api('/api/ops/command', { type: 'staff', zone: 'security', delta: 3 })).status).toBe(202);
  const planned: any = await (await api('/api/ops/command', { type: 'evacuate', zones: ['security'] })).json();
  vision.send('evac.plan', { id: planned.command.id, blocked: ['security'], clearSec: 10, exits: [], routes: [{ from: 'entrance', exit: 'exit_1', nodes: ['entrance', 'exit_1'] }] });
  await expect.poll(() => twin.of('agent.route').length).toBe(1);
  twin.send('flight.update', { flights: [flight({ status: 'delayed', delayMin: 30 })] });
  await expect.poll(() => twin.of('agent.message').some(m => m.kind === 'flight')).toBe(true);
  // A second command deliberately has no plan: reset must cancel its pending fallback.
  expect((await api('/api/ops/command', { type: 'evacuate', zones: ['airside'] })).status).toBe(202);
  const response = await api('/api/demo/reset', {});
  expect(response.status).toBe(200);
  const result: any = await response.json();
  expect(result).toMatchObject({ ok: true, cleared: { profiles: 1, histories: 1, inboundWindows: 1,
    whatsappSubscribers: 1, simSubscribers: 1, pageTokens: 2, alerts: 2, joinTokens: 1,
    reports: 1, evacuation: 1, subscriptions: 1, agents: 1, receipts: 1, walletPasses: 1,
    flights: 1, commands: 3, flowZones: 1, truthZones: 1, positions: 1, simAgents: 1 } });
  expect(result.cleared.evacTimers).toBeGreaterThan(0);
  expect(result.cleared.whatsappIds).toBeGreaterThan(0);
  await expect.poll(() => twin.of('sim.command')).toEqual([{ reset: true }]);
  expect(await sim()).toMatchObject({ ...initial, connected: true, vision: true, lanes: initialLanes });
  expect(await (await api('/api/sim/agents')).json()).toEqual([]);
  expect(await (await api('/api/reports')).json()).toEqual([]);
  for (const token of [oldPage, simPage]) expect((await api(`/api/me?token=${token}`)).status).toBe(404);
  expect((await api('/api/wallet/pass', { joinToken: pending.token })).status).toBe(400);
  expect((await api('/api/wallet/pass', { subscriptionId: subscribed.subscriptionId })).status).toBe(400);
  // New passengers must not receive an evacuation from a timer belonging to the old demo.
  twin.send('agent.register', { agentId: 'fresh', role: 'passenger_terminal', channel: 'sim', flight: 'W6 3751' });
  await expect.poll(() => twin.of('agent.message').filter(m => m.agentId === 'fresh').length).toBe(1);
  await new Promise(r => setTimeout(r, 3200));
  expect(twin.of('agent.message').filter(m => m.agentId === 'fresh').map(m => m.kind)).toEqual(['arrive']);
  expect((await api(`/api/me?token=${oldPage}`)).status).toBe(404);
  // Same phone, old unconsumed join token: no old name, staff role, bag choice or verified identity.
  await whatsapp(`START W6 3751 ${pending.token}`);
  await whatsapp('Când trebuie să vin?');
  await expect.poll(() => toolResults.some(r => r.beAtEntranceAt), { timeout: 10000 }).toBe(true);
  const system = outbound.filter(o => o.url.startsWith('https://api.anthropic.com')).at(-1)!.body.system[1].text;
  expect(system).toContain('nevalidat');
  expect(system).not.toContain('OldName');
  expect(system).not.toContain('Bagaj de cală: da');
  const newPage = /\/m\/([a-f0-9-]+)/.exec(texts().filter(t => t.includes('/m/')).at(-1)!)![1];
  expect(await (await api(`/api/me?token=${newPage}`)).json()).toMatchObject({ flight: { status: 'scheduled', delayMin: 0 }, evacuation: { active: false, zones: [] } });
  await whatsapp('STAFF echipa'); await whatsapp(reportText);
  await expect.poll(async () => (await api('/api/reports')).json(), { timeout: 10000 }).toMatchObject([{ id: 'R1' }]);
  expect((await api('/api/demo/reset', {})).status).toBe(200);
  // Reopen the same SQLite store to verify reset survived a process restart.
  for (const ws of sockets.splice(0)) ws.close();
  await mf.dispose(); start();
  expect(await (await api('/api/reports')).json()).toEqual([]);
  expect((await api(`/api/me?token=${newPage}`)).status).toBe(404);
  expect((await api('/api/wallet/pass', { joinToken: pending.token })).status).toBe(400);
  expect((await api('/api/wallet/pass', { subscriptionId: subscribed.subscriptionId })).status).toBe(400);
  const state: any = await (await api('/api/state')).json();
  expect(state.counters.passenger_home.subscribers).toBe(0);
  expect(state.counters.passenger_terminal.subscribers).toBe(0);
}, 30000);

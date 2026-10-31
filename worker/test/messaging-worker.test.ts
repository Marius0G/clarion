import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The real Tower in workerd: Unity's twin socket, the WhatsApp webhook and the operator endpoints together.
let mf: Miniflare;
const graph: any[] = [];
const sockets: { close(): void }[] = [];
beforeAll(() => {
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'messaging', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    outboundService: async request => {
      if (request.url.startsWith('https://graph.facebook.com')) { graph.push(await request.json()); return Response.json({}); }
      return Response.json([]);
    },
    bindings: { DEMO_TOKEN: 'op', SIM_SPEED: '60', WHATSAPP_APP_SECRET: 'meta-secret', WHATSAPP_TOKEN: 'token', WHATSAPP_PHONE_NUMBER_ID: 'PN1', STAFF_CODE: 'echipa' },
  }));
});
afterAll(async () => { for (const ws of sockets) { try { ws.close(); } catch { /* closed */ } } await mf.dispose(); });

const envelope = (type: string, data = {}) => JSON.stringify({ type, ts: new Date().toISOString(), data });
const api = (path: string, body?: unknown, token = 'op') => mf.dispatchFetch(`https://worker.example${path}`, {
  method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
});
async function twin(client = 'twin') {
  const r = await mf.dispatchFetch(`https://worker.example/ws?client=${client}&token=op`, { headers: { Upgrade: 'websocket' } });
  const ws = r.webSocket!; const messages: any[] = [];
  ws.addEventListener('message', e => messages.push(JSON.parse(String(e.data)))); ws.accept(); sockets.push(ws);
  await expect.poll(() => messages.some(m => m.type === 'state')).toBe(true);
  return { ws, messages, of: (type: string) => messages.filter(m => m.type === type).map(m => m.data) };
}
function whatsapp(text: string) {
  const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' },
    messages: [{ id: `wamid.${Math.random()}`, from: '40712345678', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return mf.dispatchFetch('https://worker.example/webhooks/whatsapp', { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'meta-secret').update(raw).digest('hex') } });
}
const texts = () => graph.filter(b => b.type === 'text').map(b => b.text.body as string);
const flight = (extra = {}) => ({ flight: 'W6 3751', airline: 'W6', destination: 'Londra Luton', std: '09:40', gate: 'gate_2', checkIn: 'check_in:2', checkInDesks: [], gateCloseAt: '09:10', status: 'scheduled', delayMin: 0, pax: 180, ...extra });

describe('passenger messaging in the Tower', () => {
  it('rejects unknown or missing passenger tokens without operator auth', async () => {
    for (const path of ['/api/me', '/api/me?token=unknown']) {
      expect((await api(path, undefined, '')).status).toBe(404);
    }
  });
  it('sim subscribers, flight changes, staff reports and evacuation end to end', async () => {
    const u = await twin();
    u.ws.send(envelope('sim.status', { running: true, scenario: 'S1', arm: 'B', coverage: 1, seed: 1, speed: 60, simTime: 7 * 3600, agents: 1 }));
    u.ws.send(envelope('flight.update', { flights: [flight()] }));
    // D17: a sim subscriber, plus the legacy shape in the same socket.
    u.ws.send(envelope('agent.register', { agentId: 'a1', role: 'passenger_terminal', channel: 'sim', flight: 'W6 3751' }));
    u.ws.send(envelope('agent.register', { agents: [{ agentId: 'u1', role: 'taxi', channel: 'telegram' }] }));
    await expect.poll(() => u.of('agent.message').length).toBe(1);
    expect(u.of('agent.message')[0]).toMatchObject({ agentId: 'a1', kind: 'arrive', text: expect.stringContaining('Fii la intrarea în terminal la 08:') });
    const simLink = /https:\/\/clarion-craiova.pages.dev\/m\/([a-f0-9-]+)/.exec(u.of('agent.message')[0].text)!;
    const passengerPath = `/api/me?token=${simLink[1]}`;
    const response = await mf.dispatchFetch(`https://worker.example${passengerPath}`, { headers: { Origin: 'https://clarion-craiova.pages.dev' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://clarion-craiova.pages.dev');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      simTime: 25200,
      flight: { flight: 'W6 3751', destination: 'Londra Luton', std: '09:40', gate: 'gate_2', gateCloseAt: '09:10', status: 'scheduled', delayMin: 0 },
      arriveBy: '08:30',
      steps: [
        { zone: 'bag_drop:2', label: 'Predare bagaje, grupul 2', waitMin: 12 },
        { zone: 'security', label: 'Control de securitate', waitMin: 15 },
        { zone: 'walk', label: 'Drum până la poarta 2', waitMin: 1 },
      ],
      alerts: [{ at: expect.any(String), kind: 'arrive', text: u.of('agent.message')[0].text }],
      evacuation: { active: false, zones: [] },
    });
    u.ws.send(envelope('agent.register', { agentId: 'a1', role: 'p', channel: 'sim' }));
    await expect.poll(() => u.of('error').length).toBe(1);

    // A phone subscribes, then Unity delays the flight: one message each, even when the schedule is resent.
    await whatsapp('START W6 3751');
    await expect.poll(() => texts().some(t => t.includes('Poarta 2 se închide la 09:10')), { timeout: 10000 }).toBe(true);
    await expect.poll(() => texts().some(t => t.includes('/m/')), { timeout: 10000 }).toBe(true);
    const phoneToken = /\/m\/([a-f0-9-]+)/.exec(texts().find(t => t.includes('/m/'))!)![1];
    const phoneResponse = await api(`/api/me?token=${phoneToken}`, undefined, '');
    expect(phoneResponse.status).toBe(200);
    const phoneJson = await phoneResponse.text();
    expect(phoneJson).not.toContain('40712345678');
    expect(phoneJson).not.toContain('phone');
    u.ws.send(envelope('flight.update', { flights: [flight({ status: 'delayed', delayMin: 30 })] }));
    u.ws.send(envelope('flight.update', { flights: [flight({ status: 'delayed', delayMin: 30 })] }));
    await expect.poll(() => texts().filter(t => t.includes('întârziere de 30 min')).length, { timeout: 10000 }).toBe(1);
    await expect.poll(() => u.of('agent.message').filter(m => m.kind === 'flight').length).toBe(1);
    await new Promise(r => setTimeout(r, 300));
    expect(texts().filter(t => t.includes('întârziere de 30 min'))).toHaveLength(1);

    // Staff report -> GET /api/reports (operator token) -> close.
    await whatsapp('STAFF echipa');
    await expect.poll(() => texts().some(t => t.includes('ești înregistrat ca angajat')), { timeout: 10000 }).toBe(true);
    await whatsapp('Bagaj abandonat lângă check-in Wizz');
    expect((await api('/api/reports', undefined, '')).status).toBe(401);
    await expect.poll(async () => (await (await api('/api/reports')).json() as any[]).length, { timeout: 10000 }).toBe(1);
    const [report] = await (await api('/api/reports')).json() as any[];
    expect(report).toEqual({ id: 'R1', at: expect.any(String), kind: 'bagaj_abandonat', node: 'check_in:2', text: 'Bagaj abandonat lângă check-in Wizz', status: 'open', etaMin: 1 });
    expect(report.etaMin).toBe(1);
    expect((await api('/api/reports/R1/close', {}, '')).status).toBe(401);
    expect(await (await api('/api/reports/R1/close', {})).json()).toMatchObject({ id: 'R1', status: 'closed' });
    expect((await api('/api/reports/R7/close', {})).status).toBe(404);

    // Evacuation: vision's plan arrives in time -> routes; agent.route for the sim agent.
    expect((await api('/api/ops/command', { type: 'evacuate', zones: ['check_in:2'] })).status).toBe(202);
    await expect.poll(() => u.of('ops.command').length, { timeout: 10000 }).toBeGreaterThan(0);
    const command = u.of('ops.command').at(-1);
    // The plan comes from the vision service, which also receives every ops.command.
    const v = await twin('vision');
    await expect.poll(() => v.of('ops.command').length).toBe(0);
    expect((await api('/api/ops/command', { type: 'staff', zone: 'security', delta: 1 })).status).toBe(202);
    await expect.poll(() => v.of('ops.command').at(-1)?.type).toBe('staff');
    v.ws.send(envelope('evac.plan', { id: command.id, blocked: ['check_in:2'], clearSec: 120, exits: [{ exit: 'exit_1', people: 10, clearSec: 60 }],
      routes: [{ from: 'entrance', exit: 'exit_1', nodes: ['entrance', 'exit_1'] }] }));
    await expect.poll(() => u.of('agent.route')).toEqual([{ agentId: 'a1', nodes: ['entrance', 'exit_1'], reason: 'evacuate' }]);
    await expect.poll(() => texts().filter(t => t.includes('Ieși pe Ieșirea 1')).length, { timeout: 10000 }).toBe(1); // one phone (passenger turned staff)
    // No evac.plan: the generic message after ~3 s.
    expect((await api('/api/ops/command', { type: 'evacuate', zones: ['security'] })).status).toBe(202);
    await expect.poll(() => u.of('agent.message').filter(m => m.kind === 'evacuate' && m.text.includes('Control de securitate e închisă')).length, { timeout: 8000 }).toBe(1);
    await expect.poll(async () => (await (await api(passengerPath, undefined, '')).json() as any).evacuation).toEqual({ active: true, zones: ['security'] });
    for (let delayMin = 31; delayMin <= 36; delayMin++) {
      u.ws.send(envelope('flight.update', { flights: [flight({ status: 'delayed', delayMin })] }));
      await expect.poll(async () => (await (await api(passengerPath, undefined, '')).json() as any).alerts.at(-1)?.text).toContain(`întârziere de ${delayMin} min`);
    }
    await expect.poll(async () => (await (await api(passengerPath, undefined, '')).json() as any).alerts.at(-1)?.text).toContain('întârziere de 36 min');
    const final = await (await api(passengerPath, undefined, '')).json() as any;
    expect(final.alerts).toHaveLength(5);
    expect(final.alerts.every((a: any) => a.kind === 'flight')).toBe(true);
    expect(final.flight.gateCloseAt).toBe('09:46');
    // Re-registration keeps the existing secret and history.
    u.ws.send(envelope('agent.register', { agentId: 'a1', role: 'passenger_terminal', channel: 'sim', flight: 'W6 3751' }));
    expect((await api(passengerPath, undefined, '')).status).toBe(200);
    u.ws.send(envelope('evac.plan', { id: 'x', blocked: [], clearSec: 1, exits: [], routes: [] }));
    await expect.poll(() => u.of('error').length).toBe(2);
  });
});

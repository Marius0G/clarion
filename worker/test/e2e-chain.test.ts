import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Same workerd, socket capture and signed-webhook helpers as messaging-worker / wa-worker.
let mf: Miniflare;
const sockets: { close(): void }[] = [];
const outbound: { url: string; body: any }[] = [];
const toolResults: any[] = [];
const reportText = 'Bagaj abandonat lângă check-in Wizz';
beforeAll(() => {
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'e2e-chain', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
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
            ? result.situation : `Am primit (${result.id}).` }] });
        }
        const staff = String(last).includes(reportText);
        return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: staff ? 'report' : 'arrival',
          name: staff ? 'reportIssue' : 'whenToArrive', input: staff ? { text: reportText } : { hasCheckedBag: true } }] });
      }
      return Response.json(request.url.startsWith('https://graph.facebook.com') ? { messages: [{ id: 'wamid.out' }] } : []);
    },
  }));
});
afterAll(async () => { for (const ws of sockets) ws.close(); await mf.dispose(); });
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

it('walks all four D18 demo beats through Unity, vision, WhatsApp and the operator API', async () => {
  const twin = await connect('twin');
  const vision = await connect('vision');
  twin.send('sim.status', { running: true, scenario: 'S1', arm: 'B', coverage: 1, seed: 1, speed: 60, simTime: 25200, agents: 1 });
  twin.send('flight.update', { flights: [flight()] });
  const zones = ['bag_drop:2', 'security'].map(zone => ({ zone, waiting: 40, waitingSd: 2, density: 0.1, waitMin: 5, waitMinP90: 25, coverage: 1,
    forecast: [30, 60, 90, 120].map(inMin => ({ inMin, waitMin: zone === 'security' ? 20 : 10 })), advice: { lanes: 3, by: '08:00', waitMinIfNot: 25 } }));
  const people = [{ x: 10, y: 12 }, { x: 11, y: 13 }];
  vision.send('flow.report', { zones }); vision.send('crowd.positions', { people });
  await expect.poll(sim).toMatchObject({ connected: true, vision: true, simTime: 25200, flights: [flight()], positions: { people },
    lanes: { security: 2 }, flow: Object.fromEntries(zones.map(({ zone, ...row }) => [zone, row])) });

  // Beat 1: a real phone binds the join token; the bag answer goes through the real arrival tool.
  const joinResponse = await api('/api/join', { flight: 'W6 3751' }, '');
  expect(joinResponse.status).toBe(201);
  const joined: any = await joinResponse.json();
  expect(joined.token).toEqual(expect.any(String));
  expect(decodeURIComponent(joined.waLink)).toContain(`START W6 3751 ${joined.token}`);
  await whatsapp(`START W6 3751 ${joined.token}`);
  await expect.poll(() => texts().some(t => t.includes('Te-am conectat la zborul W6 3751')), { timeout: 10000 }).toBe(true);
  await expect.poll(() => outbound.some(o => o.body?.type === 'interactive'), { timeout: 10000 }).toBe(true);
  await expect.poll(() => texts().some(t => t.includes('/m/'))).toBe(true);
  const pageToken = /\/m\/([a-f0-9-]+)/.exec(texts().find(t => t.includes('/m/'))!)![1];
  expect(pageToken).not.toBe(joined.token);
  await whatsapp('Da, am bagaj', 'bag:yes');
  await expect.poll(() => toolResults.length, { timeout: 10000 }).toBe(1);
  const context = outbound.find(o => o.url.startsWith('https://api.anthropic.com'))!.body.system[1].text;
  expect(context).toContain('Zbor: W6 3751');
  expect(context).toContain('Bagaj de cală: da');
  expect(context).not.toContain('nevalidat');
  expect(toolResults[0]).toMatchObject({ beAtEntranceAt: '08:25', assumedCheckedBag: false,
    steps: [expect.objectContaining({ zone: 'bag_drop:2', min: 10, source: 'prognoză' }), expect.objectContaining({ zone: 'security', min: 20, source: 'prognoză' }), expect.anything(), expect.anything()] });
  await expect.poll(() => texts().filter(t => t.includes('Până la poarta') && !t.includes('/m/')).length, { timeout: 10000 }).toBe(1);
  const passenger = async (): Promise<any> => { const r = await api(`/api/me?token=${pageToken}`, undefined, ''); expect(r.status).toBe(200); return r.json(); };
  expect(await passenger()).toMatchObject({ arriveBy: '08:25', steps: [
    { zone: 'bag_drop:2', label: expect.any(String), waitMin: 10 }, { zone: 'security', label: expect.any(String), waitMin: 20 }, { zone: 'walk', label: expect.any(String), waitMin: 2 }], evacuation: { active: false, zones: [] } });
  twin.send('agent.register', { agentId: 'demo-passenger', role: 'passenger_terminal', channel: 'sim', flight: 'W6 3751' });
  await expect.poll(() => twin.of('agent.message')).toEqual([expect.objectContaining({ agentId: 'demo-passenger', kind: 'arrive', text: expect.stringContaining('Până la poarta') })]);

  // Beat 2: operator opens a lane, both services receive it, Unity acks and vision reports the improvement.
  const staff = await api('/api/ops/command', { type: 'staff', zone: 'security', delta: 1 });
  expect(staff.status).toBe(202);
  const { command }: any = await staff.json();
  for (const socket of [twin, vision]) await expect.poll(() => socket.of('ops.command')).toContainEqual({ id: command.id, type: 'staff', zone: 'security', delta: 1 });
  twin.send('ops.ack', { id: command.id });
  await expect.poll(sim).toMatchObject({ lanes: { security: 3 }, ops: [expect.objectContaining({ id: command.id, status: 'acked' })] });
  vision.send('flow.report', { zones: [{ ...zones[1], waiting: 20, waitMin: 3 }] });
  await expect.poll(sim).toMatchObject({ flow: { security: { waiting: 20, waitMin: 3 } } });

  // Beat 3: duplicate schedule deliveries must produce one notification on each channel.
  const delayed = { flights: [flight({ status: 'delayed', delayMin: 30 })] };
  twin.send('flight.update', delayed); twin.send('flight.update', delayed);
  const delays = () => texts().filter(t => t.includes('întârziere de 30 min'));
  const simDelays = () => twin.of('agent.message').filter(m => m.kind === 'flight');
  await expect.poll(() => delays().length, { timeout: 10000 }).toBe(1);
  await expect.poll(simDelays).toEqual([expect.objectContaining({ agentId: 'demo-passenger', text: expect.stringContaining('întârziere de 30 min') })]);
  await expect.poll(sim).toMatchObject({ flights: [expect.objectContaining({ status: 'delayed', delayMin: 30 })] });

  // Beat 4: staff reports the incident; vision's evacuation plan reaches both kinds of passenger.
  await whatsapp('STAFF echipa');
  await expect.poll(() => texts().some(t => t.includes('ești înregistrat ca angajat')), { timeout: 10000 }).toBe(true);
  await whatsapp(reportText);
  await expect.poll(async () => (await api('/api/reports')).json(), { timeout: 10000 }).toEqual([
    expect.objectContaining({ id: 'R1', text: reportText, kind: 'bagaj_abandonat', node: 'check_in:2', etaMin: 2, status: 'open' })]);
  const evac = await api('/api/ops/command', { type: 'evacuate', zones: ['check_in:2'] });
  expect(evac.status).toBe(202);
  const { command: evacuation }: any = await evac.json();
  for (const socket of [twin, vision]) await expect.poll(() => socket.of('ops.command').find(c => c.id === evacuation.id)).toMatchObject({ type: 'evacuate', zones: ['check_in:2'] });
  vision.send('evac.plan', { id: evacuation.id, blocked: ['check_in:2'], clearSec: 120, exits: [{ exit: 'exit_1', people: 10, clearSec: 60 }], routes: [{ from: 'entrance', exit: 'exit_1', nodes: ['entrance', 'exit_1'] }] });
  await expect.poll(() => twin.of('agent.route')).toEqual([{ agentId: 'demo-passenger', nodes: ['entrance', 'exit_1'], reason: 'evacuate' }]);
  await expect.poll(() => texts().filter(t => t.includes('Ieși pe Ieșirea 1')).length, { timeout: 10000 }).toBe(1);
  await expect.poll(passenger).toMatchObject({ evacuation: { active: true, zones: ['check_in:2'] } });
  expect(delays()).toHaveLength(1); expect(simDelays()).toHaveLength(1);
}, 30000);

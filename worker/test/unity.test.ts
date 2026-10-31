import { Miniflare,Response,convertV4MiniflareOptions } from 'miniflare';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
let mf: Miniflare;
const sockets: {close():void}[] = [];
const envelope = (type: string, data = {}) => ({type, ts:new Date().toISOString(),data});
beforeAll(() => {
  mf = new Miniflare(convertV4MiniflareOptions({ name:'unity', modules:true, scriptPath:'dist/index.js', compatibilityDate:'2026-10-30', durableObjects:{TOWER:{className:'Tower',useSQLite:true}}, unsafeInspectDurableObjects:true, outboundService:async () => Response.json([]), bindings:{DEMO_TOKEN:'test-unity',SIM_SPEED:'0.001'} }));
});
afterAll(async () => { for (const ws of sockets) { try { ws.close(); } catch { /* Already closed by the disconnect test. */ } } await mf.dispose(); });
function request(path:string, body?:unknown) { return mf.dispatchFetch(`https://worker.example${path}`,{method:body === undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test-unity'},body:body === undefined?undefined:JSON.stringify(body)}); }
function unauthorized(path:string, body?:unknown) { return mf.dispatchFetch(`https://worker.example${path}`,{method:body === undefined?'GET':'POST',headers:path.startsWith('/ws')?{Upgrade:'websocket'}:{},body:body === undefined?undefined:JSON.stringify(body)}); }
async function connect(client:string) {
  const r = await mf.dispatchFetch(`https://worker.example/ws?client=${client}&token=test-unity`,{headers:{Upgrade:'websocket'}});
  expect(r.status).toBe(101); const ws=r.webSocket!; const messages:any[]=[];
  ws.addEventListener('message',e=>messages.push(JSON.parse(String(e.data)))); ws.accept(); sockets.push(ws);
  await expect.poll(()=>messages.some(m=>m.type==='state')).toBe(true); return {ws,messages};
}
describe('Worker Unity integration', () => {

  it('connects fake Unity with token, 400 agents, telemetry and targeted commands', async () => {
    for (const client of ['console', 'twin']) expect((await unauthorized(`/ws?client=${client}`)).status).toBe(401);
    for (const path of ['/api/action', '/api/sim/command']) expect((await unauthorized(path, {})).status).toBe(401);
    expect((await unauthorized('/api/state')).status).toBe(200);
    expect((await unauthorized('/api/sim')).status).toBe(200);
    const twin = await connect('twin');
    const viewer = await connect('viewer');
    const consoleClient = await connect('console');
    const send = async (type: string, data: any, expected: number) => {
      const before = twin.messages.filter(m => m.type === 'state').length;
      twin.ws.send(JSON.stringify(envelope(type, data)));
      await expect.poll(() => twin.messages.filter(m => m.type === 'state').length).toBe(before + expected);
    };
    await send('agent.register', { agents: Array.from({ length: 400 }, (_,i) => ({ agentId: `u${i}`, role: 'taxi', channel: 'whatsapp' })) }, 1);
    await send('agent.batch', { updates: Array.from({ length: 400 }, (_,i) => ({ agentId: `u${i}`, role: 'taxi', persona: 'p07', location: 'road', phone: 'read', action: 'wait' })) }, 1);
    twin.ws.send(JSON.stringify(envelope('sim.status', { running: true, scenario: 'S2', arm: 'B', coverage: .5, seed: 42, speed: 60, simTime: 100, agents: 400 })));
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).simTime).toBe(100);
    const sim = await (await request('/api/sim')).json() as any;
    expect(sim).toMatchObject({ connected: true, run: { scenario: 'S2', arm: 'B', coverage: .5, seed: 42 }, counts: { taxi: { road: 400 } }, phones: { read: 400 }, actions: { wait: 400 } });
    expect(sim.flow).toEqual({});
    twin.ws.send(JSON.stringify(envelope('flow.report', { zones: [{ zone: 'taxi_rank', waiting: 30, capacity: 24, waitMin: 12 }, { zone: 'taxi_rank', waiting: 1, capacity: 24, waitMin: 1 }] })));
    await expect.poll(() => twin.messages.filter(m => m.type === 'error').length).toBe(1);
    twin.messages.splice(twin.messages.findIndex(m => m.type === 'error'), 1);
    twin.ws.send(JSON.stringify(envelope('flow.report', { zones: [{ zone: 'taxi_rank', waiting: 30, capacity: 24, waitMin: 12 }, { zone: 'security', waiting: 80, capacity: null, waitMin: null }] })));
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).flow.taxi_rank?.waiting).toBe(30);
    expect((await (await request('/api/sim')).json() as any).flow).toMatchObject({ taxi_rank: { waiting: 30, capacity: 24, waitMin: 12, peak: 30 }, security: { waiting: 80, capacity: null, waitMin: null, peak: 80 } });
    expect(await (await request('/api/sim/agents?role=taxi&location=road&action=wait')).json()).toHaveLength(400);
    expect(await (await request('/api/sim/agents?location=home')).json()).toEqual([]);
    expect((await request('/api/sim/command', { action: 'start', arm: 'Z' })).status).toBe(400);
    expect((await request('/api/sim/command', { action: 'trigger', event: 'delay' })).status).toBe(202);
    await expect.poll(() => twin.messages.some(m => m.type === 'sim.command' && m.data.event === 'delay')).toBe(true);
    expect(viewer.messages.some(m => m.type === 'sim.command')).toBe(false);
    expect(consoleClient.messages.some(m => m.type === 'sim.command')).toBe(false);
    expect(twin.messages.filter(m => m.type === 'error')).toEqual([]);
    expect(twin.messages.filter(m => m.type === 'state')).toHaveLength(3);
    twin.ws.close();
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).connected).toBe(false);
    expect((await request('/api/sim/command', { action: 'stop' })).status).toBe(409);
  });
  it('forwards ops.command and agent.route to Unity and tracks ops.ack', async () => {
    for (const path of ['/api/ops/command', '/api/agent/route']) expect((await unauthorized(path, {})).status).toBe(401);
    expect((await request('/api/ops/command', { type: 'evacuate', zones: ['gate_1'] })).status).toBe(409);
    expect((await request('/api/agent/route', { agentId: 'u1', nodes: ['entrance', 'gate_1'], reason: 'evacuate' })).status).toBe(409);
    const twin = await connect('twin');
    expect((await request('/api/ops/command', { type: 'evacuate', zones: [] })).status).toBe(400);
    const res = await request('/api/ops/command', { type: 'evacuate', zones: ['gate_1', 'airside'] });
    expect(res.status).toBe(202);
    const { command } = await res.json() as any;
    await expect.poll(() => twin.messages.find(m => m.type === 'ops.command')?.data).toEqual({ type: 'evacuate', zones: ['gate_1', 'airside'], id: command.id });
    expect((await (await request('/api/sim')).json() as any).ops[0]).toMatchObject({ id: command.id, status: 'sent' });
    twin.ws.send(JSON.stringify(envelope('ops.ack', { id: command.id })));
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).ops[0]?.status).toBe('acked');
    expect((await request('/api/agent/route', { agentId: 'u1', nodes: ['entrance', 'gate_1'], reason: 'evacuate' })).status).toBe(202);
    await expect.poll(() => twin.messages.find(m => m.type === 'agent.route')?.data).toEqual({ agentId: 'u1', nodes: ['entrance', 'gate_1'], reason: 'evacuate' });
    twin.ws.send(JSON.stringify(envelope('flight.update', { flights: [{ flight: 'W6 3751', airline: 'W6', destination: 'Luton', std: 100, status: 'boarding' }] })));
    twin.ws.send(JSON.stringify(envelope('flow.report', { zones: [{ zone: 'check_in:W6', waiting: 12, staff: 2, forecast: [{ inMin: 30, waitMin: 9 }] }] })));
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).flow['check_in:W6']?.staff).toBe(2);
    expect((await (await request('/api/sim')).json() as any).flights[0]).toMatchObject({ flight: 'W6 3751', status: 'boarding' });
    expect(twin.messages.filter(m => m.type === 'error')).toEqual([]);
    twin.ws.close();
  });
  it('client=vision: one at a time, camera flow, lanes, truth and every ops.command', async () => {
    expect((await unauthorized('/ws?client=vision')).status).toBe(401);
    const first = await connect('vision');
    const closed = new Promise<number>(r => first.ws.addEventListener('close', e => r(e.code)));
    const vision = await connect('vision');
    expect(await closed).toBe(4001);
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).vision).toBe(true);
    vision.ws.send(JSON.stringify(envelope('flow.report', { zones: [{ zone: 'check_in:2', waiting: 14, waitMin: 6, coverage: 0.7, density: 1.1, advice: { lanes: 3, by: 50700, waitMinIfNot: 18 } }] })));
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).flow['check_in:2']).toMatchObject({ waiting: 14, coverage: 0.7, density: 1.1, source: 'vision', stale: false, advice: { lanes: 3 } });
    vision.ws.send(JSON.stringify(envelope('ops.ack', { id: 'x' })));
    await expect.poll(() => vision.messages.find(m => m.type === 'error')?.data.message).toBe('Client cannot issue this event');
    const twin = await connect('twin');
    // Legacy Unity flow is ignored while the cameras report.
    twin.ws.send(JSON.stringify(envelope('flow.report', { zones: [{ zone: 'check_in:2', waiting: 99, staff: 2 }] })));
    twin.ws.send(JSON.stringify(envelope('truth.report', { zones: [{ zone: 'check_in:2', waiting: 15, waitMin: 7 }] })));
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).truth?.zones['check_in:2']).toEqual({ waiting: 15, waitMin: 7 });
    expect((await (await request('/api/sim')).json() as any).flow['check_in:2'].waiting).toBe(14);
    const before = (await (await request('/api/sim')).json() as any).lanes['check_in:2'];
    const res = await request('/api/ops/command', { type: 'staff', zone: 'check_in:2', delta: 1 });
    expect(res.status).toBe(202);
    const { command } = await res.json() as any;
    expect((await (await request('/api/sim')).json() as any).lanes['check_in:2']).toBe(before + 1);
    for (const client of [twin, vision]) await expect.poll(() => client.messages.find(m => m.type === 'ops.command')?.data).toEqual({ type: 'staff', zone: 'check_in:2', delta: 1, id: command.id });
    twin.ws.send(JSON.stringify(envelope('metric.report', { name: 'evacT90', value: 42 })));
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).metrics.evacT90).toBe(42);
    expect(twin.messages.filter(m => m.type === 'error')).toEqual([]);
    twin.ws.close(); vision.ws.close();
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).vision).toBe(false);
  });
  it('keeps live connectivity but clears telemetry after hibernation', async () => {
    const twin = await connect('twin');
    twin.ws.send(JSON.stringify(envelope('sim.status', {running:true,scenario:'S2',arm:'A',coverage:.5,seed:42,speed:60,simTime:1,agents:0})));
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).simTime).toBe(1);
    await mf.unsafeEvictDurableObject('unity','Tower',{name:'tower',webSockets:'hibernate'});
    expect(await (await request('/api/sim')).json()).toMatchObject({connected:true,lastSeen:null,counts:{},actions:{}});
    expect(await (await request('/api/sim/agents')).json()).toEqual([]);
  });
});

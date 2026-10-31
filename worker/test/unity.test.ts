import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
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

  it('connects fake Unity with token, 400 agents, incident, telemetry and targeted commands', async () => {
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
    await send('agent.register', { agents: Array.from({ length: 400 }, (_,i) => ({ agentId: `u${i}`, role: 'taxi', channel: 'telegram' })) }, 1);
    await send('drone.detected', { nearRunway: '26', distanceM: 2000, bearingDeg: 90, source: 'radar' }, 1);
    await request('/api/action', envelope('console.confirm_suspension'));
    await request('/api/action', envelope('console.approve_messages', { roles: ['taxi'] }));
    await expect.poll(() => twin.messages.filter(m => m.type === 'state').length).toBe(5);
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
    expect((await request('/api/sim/command', { action: 'trigger', event: 'drone' })).status).toBe(202);
    await expect.poll(() => twin.messages.some(m => m.type === 'sim.command' && m.data.event === 'drone')).toBe(true);
    expect(viewer.messages.some(m => m.type === 'sim.command')).toBe(false);
    expect(consoleClient.messages.some(m => m.type === 'sim.command')).toBe(false);
    expect(twin.messages.filter(m => m.type === 'error')).toEqual([]);
    // Initial state + register + detection + confirmation + send batch + presence batch.
    expect(twin.messages.filter(m => m.type === 'state')).toHaveLength(6);
    console.log('FAKE UNITY: 5 state broadcasts (plus 1 initial state); 400 agents');
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
  it('keeps live connectivity but clears telemetry after hibernation', async () => {
    const twin = await connect('twin');
    twin.ws.send(JSON.stringify(envelope('sim.status', {running:true,scenario:'S2',arm:'A',coverage:.5,seed:42,speed:60,simTime:1,agents:0})));
    await expect.poll(async () => (await (await request('/api/sim')).json() as any).simTime).toBe(1);
    await mf.unsafeEvictDurableObject('unity','Tower',{name:'tower',webSockets:'hibernate'});
    expect(await (await request('/api/sim')).json()).toMatchObject({connected:true,lastSeen:null,counts:{},actions:{}});
    expect(await (await request('/api/sim/agents')).json()).toEqual([]);
  });
});

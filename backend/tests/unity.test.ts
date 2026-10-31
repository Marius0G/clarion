import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createControlTower } from '../src/server.js';
const dir = mkdtempSync(join(tmpdir(), 'unity-'));
let server: ReturnType<typeof createControlTower>, base: string;
const sockets: WebSocket[] = [];
const envelope = (type: string, data = {}) => ({ type, ts: new Date().toISOString(), data });
beforeAll(async () => {
  vi.stubEnv('STATE_FILE', join(dir, 'state.json')); vi.stubEnv('DEMO_TOKEN', 'test-unity');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', ''); vi.stubEnv('SIM_SPEED', '0.001');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
  server = createControlTower(); vi.unstubAllGlobals();
  await new Promise<void>(r => server.http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.http.address() as any).port}`;
});
afterAll(async () => { for (const ws of sockets) ws.terminate(); await server.stop(); rmSync(dir, {recursive:true}); vi.unstubAllEnvs(); });
function request(path: string, body?: unknown) { return fetch(base+path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-unity' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
async function unauthorized(path: string, body?: unknown) {
  if (path.startsWith('/ws')) return new Promise<{status:number}>(r => {
    const ws = new WebSocket(base.replace('http','ws')+path); ws.on('error', () => {});
    ws.on('unexpected-response', (_req, res) => { res.resume(); r({status:res.statusCode!}); });
  });
  return fetch(base+path, {method:body === undefined ? 'GET':'POST',body:body === undefined ? undefined:JSON.stringify(body)});
}
async function connect(client: string) {
  const ws = new WebSocket(`${base.replace('http','ws')}/ws?client=${client}&token=test-unity`);
  sockets.push(ws); const messages: any[] = [];
  ws.on('message', m => messages.push(JSON.parse(m.toString())));
  await expect.poll(() => messages.some(m => m.type === 'state')).toBe(true);
  return {ws,messages};
}
describe('Node Unity integration', () => {

  it('connects fake Unity with token, 400 agents, incident, telemetry and targeted commands', async () => {
    for (const client of ['console', 'twin']) expect((await unauthorized(`/ws?client=${client}`)).status).toBe(401);
    for (const path of ['/api/action', '/api/sim/command']) expect((await unauthorized(path, {})).status).toBe(401);
    for (const auth of ['Bearer wrong', 'test-unity', 'Bearer test-unity2']) expect((await fetch(base+'/api/action', { method: 'POST', headers: { Authorization: auth }, body: '{}' })).status).toBe(401);
    expect((await unauthorized('/ws?client=twin&token=wrong')).status).toBe(401);
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
});

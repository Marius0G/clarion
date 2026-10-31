#!/usr/bin/env node
// Node 22+ supplies fetch and WebSocket. Run only against an explicitly chosen test environment.
const base = new URL(process.env.CLARION_URL || 'https://clarion-backend.bogdan-c-2206.workers.dev');
const token = process.env.DEMO_TOKEN || '';
const sockets = [];
let original;
let staffApplied = false;
let twin;
let vision;
let failed = false;
const timeout = 10000;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function api(path, body) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(timeout),
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
async function poll(read, accepts, label) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
async function step(label, run) {
  try { const value = await run(); console.log(`PASS ${label}`); return value; }
  catch (error) { console.error(`FAIL ${label}: ${error.message}`); failed = true; throw error; }
}
async function connect(client) {
  const url = new URL('/ws', base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('client', client);
  if (token) url.searchParams.set('token', token);
  const ws = new WebSocket(url);
  const messages = [];
  let error;
  ws.addEventListener('message', event => {
    try { messages.push(JSON.parse(String(event.data))); } catch (e) { error = e; }
  });
  ws.addEventListener('error', () => { error = new Error(`${client} socket error`); });
  sockets.push(ws);
  await poll(() => { if (error) throw error; return messages; }, list => list.some(m => m.type === 'state'), `${client} initial state`);
  return { ws, messages, send: (type, data) => ws.send(JSON.stringify({ type, ts: new Date().toISOString(), data })) };
}
async function command(delta) {
  const { command } = await api('/api/ops/command', { type: 'staff', zone: 'security', delta });
  if (delta === 1) staffApplied = true;
  for (const socket of [twin, vision]) {
    await poll(() => socket.messages, list => list.some(m => m.type === 'ops.command' && m.data.id === command.id), 'ops.command delivery');
  }
  twin.send('ops.ack', { id: command.id });
  await poll(() => api('/api/sim'), sim => sim.ops.some(op => op.id === command.id && op.status === 'acked'), 'ops.ack');
}
try {
  original = await step('snapshot initial state', () => api('/api/sim'));
  // Avoid changing another simulator's schedule or messaging its subscribers.
  assert(!original.connected && !original.vision, 'Use an isolated backend: twin or vision is already connected');
  twin = await step('connect twin', () => connect('twin'));
  vision = await step('connect vision', () => connect('vision'));
  await step('send telemetry and verify /api/sim', async () => {
    twin.send('sim.status', { running: true, scenario: 'e2e-smoke', arm: 'B', coverage: 0, seed: 42, speed: 60, simTime: 25200, agents: 0 });
    // A unique flight avoids notifying existing subscribers during the smoke run.
    twin.send('flight.update', { flights: [{ flight: 'E2 9999', airline: 'E2', destination: 'Smoke test', std: '09:40', gate: 'gate_2', checkIn: 'check_in:2', checkInDesks: [], gateCloseAt: '09:10', status: 'scheduled', delayMin: 0, pax: 1 }] });
    vision.send('flow.report', { zones: [{ zone: 'security', waiting: 12, waitMin: 7, coverage: 1, forecast: [{ inMin: 30, waitMin: 10 }] }] });
    await poll(() => api('/api/sim'), sim => sim.connected && sim.vision && sim.simTime === 25200 && sim.flights.some(f => f.flight === 'E2 9999') && sim.flow.security?.waitMin === 7, 'telemetry');
  });
  await step('staff command delivered, acknowledged and lane incremented', async () => {
    const lanes = original.lanes.security;
    assert(Number.isInteger(lanes) && lanes < 50, 'Security lanes unavailable or at limit');
    await command(1);
    await poll(() => api('/api/sim'), sim => sim.lanes.security === lanes + 1, 'lane increment');
  });
  await step('/api/join issues token and WhatsApp link', async () => {
    const joined = await api('/api/join', { flight: 'E2 9999' });
    assert(typeof joined.token === 'string' && joined.token.length > 0 && decodeURIComponent(joined.waLink).includes(`START E2 9999 ${joined.token}`), 'Invalid join response');
  });
  await step('/health', async () => { const health = await api('/health'); assert(health.ok === true && health.service === 'clarion', 'Unhealthy backend'); });
} catch (error) {
  console.error(`FAIL smoke: ${error.message}`); failed = true;
} finally {
  if (staffApplied) {
    try {
      await step('restore security lanes', async () => {
        await command(-1);
        await poll(() => api('/api/sim'), sim => sim.lanes.security === original.lanes.security, 'restored lanes');
      });
    } catch { /* step reports cleanup failure */ }
  }
  if (twin && original) {
    try {
      await step('restore available telemetry', async () => {
        twin.send('flight.update', { flights: original.flights });
        if (vision && original.flow.security) vision.send('flow.report', { zones: [original.flow.security] });
        if (original.run?.scenario && original.simTime !== null) twin.send('sim.status', {
          ...original.run, running: false, speed: original.speed || 60, simTime: original.simTime, agents: 0,
        });
        await poll(() => api('/api/sim'), sim => JSON.stringify(sim.flights) === JSON.stringify(original.flights), 'restored flights');
      });
    } catch { /* step reports cleanup failure */ }
  }
  for (const ws of sockets) ws.close();
  // Do not let an unresponsive remote close handshake keep the process alive.
  await Promise.race([Promise.all(sockets.map(ws => ws.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise(resolve => ws.addEventListener('close', resolve, { once: true })))), new Promise(resolve => setTimeout(resolve, 1000))]);
  process.exit(failed ? 1 : 0);
}

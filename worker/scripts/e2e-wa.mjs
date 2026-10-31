#!/usr/bin/env node
// Node 22+. Never logs credentials, boarding passes, join tokens or passenger links.
import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
let vars = '';
try { vars = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
function secret(name) {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))`, 'm').exec(vars);
  return process.env[name] || m?.[1] || m?.[2] || m?.[3];
}
const token = secret('DEMO_TOKEN'), appSecret = secret('WHATSAPP_APP_SECRET');
const base = process.env.CLARION_URL || 'https://clarion-backend.bogdan-c-2206.workers.dev';
const web = process.env.CLARION_WEB_URL || 'https://clarion-craiova.pages.dev';
const available = process.argv.includes('--available');
const phone = `lab-e2e-${randomUUID()}`;
// +999 is deliberately not an assigned country code; never use a plausible passenger number.
const fake = `999000000${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
const masked = '•••' + fake.slice(-3);
const assert = (ok, reason) => { if (!ok) throw Error(reason); };
let failures = 0, skipped = 0, hooks, original, twin, joined, start, flight, pageToken, closed = false, injected = false, fakeUsed = false;
const sockets = [];
async function request(path, body, options = {}) {
  try { return await fetch(new URL(path, options.web ? web : base), {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(options.timeout || (path === '/lab/run' ? 180000 : 15000)),
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...options.headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }); } catch (e) { throw Error(`${path.split('?')[0]} network request failed (${e.cause?.code || e.name})`); }
}
async function api(path, body) {
  const r = await request(path, body);
  assert(r.ok, `${path.split('?')[0]} returned HTTP ${r.status}`);
  return r.json();
}
async function poll(read, accept, reason, ms = 45000) {
  const end = Date.now() + ms;
  do {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(r => setTimeout(r, 350));
  } while (Date.now() < end);
  throw Error(`Timed out: ${reason}`);
}
async function step(label, work) {
  try { const note = await work(); console.log(`PASS ${label}${note ? ': ' + note : ''}`); }
  catch (e) { failures++; console.error(`FAIL ${label}: ${e.message}`); }
}
function skip(label, reason) { skipped++; console.log(`SKIP ${label}: ${reason}`); }
async function connect() {
  const url = new URL('/ws', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('client', 'twin'); url.searchParams.set('token', token);
  const ws = new WebSocket(url); sockets.push(ws);
  const messages = []; let error;
  ws.addEventListener('message', e => { try { messages.push(JSON.parse(String(e.data))); } catch { error = true; } });
  ws.addEventListener('error', () => { error = true; });
  await poll(() => { assert(!error, 'Test twin connection failed'); return messages; }, a => a.some(m => m.type === 'state'), 'test twin initial state');
  return { send: (type, data) => ws.send(JSON.stringify({ type, ts: new Date().toISOString(), data })), messages };
}
async function signed(text) {
  assert(appSecret, 'WHATSAPP_APP_SECRET missing from .dev.vars/environment');
  const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { messages: [{
    id: `e2e-wa-${randomUUID()}`, from: fake, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text },
  }] } }] }] });
  const r = await request('/webhooks/whatsapp', raw, { headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex') } });
  assert(r.status === 200, `Signed webhook returned HTTP ${r.status}, expected 200`);
}
const events = async () => (await api('/lab/events')).events;
const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3/u;
try {
  await step('setup', async () => {
    assert(token, 'DEMO_TOKEN missing from .dev.vars/environment');
    original = await api('/api/sim');
    const r = await request('/lab/capabilities');
    if (r.status === 404) return 'deployed lab has no E2E hooks';
    assert(r.ok, `/lab/capabilities returned HTTP ${r.status}`);
    hooks = await r.json();
    assert(hooks.e2e === 1, 'Unsupported lab capabilities');
    if (available) return 'available checks only; schedule unchanged';
    assert(hooks.safeToMutate && !original.connected && !original.vision, 'Backend in use; refusing flight/gate mutations or passenger fan-out. Use --available for read-only and fake-webhook checks');
    flight = `E2 ${Math.floor(1000 + Math.random() * 9000)}`;
    assert(!original.flights.some(f => f.flight === flight), 'Test flight collision; rerun');
    twin = await connect();
    injected = true;
    twin.send('flight.update', { flights: [...original.flights, { flight, airline: 'E2', destination: 'LTN', std: '23:55', gate: 'gate_2', checkIn: 'check_in:2', checkInDesks: [], gateCloseAt: '23:30', status: 'scheduled', delayMin: 0, pax: 1 }] });
    await poll(() => api('/api/sim'), s => s.flights.some(f => f.flight === flight), 'unique test flight');
    return 'isolated test flight added; lanes unchanged';
  });
  await step('1 web join, boarding pass, WhatsApp and Wallet', async () => {
    const r = await request('/join', undefined, { web: true });
    assert(r.status === 200, `/join returned HTTP ${r.status}`);
    const html = await r.text();
    const bundle = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    assert(bundle, '/join has no app bundle');
    const js = await request(bundle, undefined, { web: true });
    assert(js.ok && /javascript/.test(js.headers.get('content-type') || '') && (await js.text()).length > 100, 'App bundle unavailable');
    joined = await api('/api/join/demo', { ...(flight && { flight }), lang: 'ro' });
    assert(/^[a-f0-9]{48}$/.test(joined.token), 'Missing/invalid join token');
    const link = new URL(joined.waLink);
    start = link.searchParams.get('text');
    assert(link.origin === 'https://wa.me' && /^\/\d+$/.test(link.pathname) && start?.endsWith(` ${joined.token}`), 'Invalid WhatsApp START link/token');
    flight = start.slice(6, -(joined.token.length + 1));
    const b = joined.bcbp;
    assert(typeof b === 'string' && b.length >= 60 && /^M1/.test(b) && b.slice(30, 33) === 'CRA' && /^[A-Z]{3}$/.test(b.slice(33, 36)) && /^\d{5}$/.test(b.slice(39, 44)) && Number(b.slice(44, 47)) >= 1 && Number(b.slice(44, 47)) <= 366 && b.slice(58, 60) === '00', 'Invalid mandatory BCBP fields');
    assert(`${b.slice(36, 39).trim()} ${Number(b.slice(39, 44))}` === flight, 'BCBP flight differs from START');
    assert(/^https:\/\/pay\.google\.com\/gp\/v\/save\/.+/.test(joined.walletUrl), 'Missing Google Wallet save URL');
    return 'page and bundle 200; issued BCBP and matching START token; Google save URL';
  });
  await step('2 webhook security', async () => {
    for (const headers of [{}, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }]) {
      const r = await request('/webhooks/whatsapp', { entry: [] }, { headers });
      assert(r.status === 403, `Webhook returned HTTP ${r.status}, expected 403`);
    }
    const r = await request('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=invalid-e2e&hub.challenge=123');
    assert(r.status === 403, `Wrong verification token returned HTTP ${r.status}, expected 403`);
  });
  if (!hooks || available || !twin) skip('3 captured WhatsApp join and conversation', !hooks ? 'requires deployed E2E lab hooks' : 'full isolated run required (omit --available)');
  else await step('3 captured WhatsApp join and conversation', async () => {
    assert(start, 'Step 1 did not issue a START link');
    const r = (await api('/lab/run', { phone, keep: true, texts: [start, 'Care este poarta mea?', 'Cât se așteaptă la securitate?', 'Cum ajung la poartă?', 'English', 'What is my gate?'] })).results.custom;
    assert(r.kept && r.stored.profile?.verified && r.stored.profile.flight === flight, 'Issued START token did not bind verified test flight');
    const turns = r.transcript;
    assert(turns.length === 6 && turns.every(t => t.replies.some(s => s.trim() && !s.startsWith('[react]'))), 'Missing text replies');
    assert(turns[0].replies.join(' ').includes(flight), 'Flight not recognised');
    assert(/poart|gate/i.test(turns[1].replies.join(' ')), 'Gate absent');
    assert(turns[2].tools.includes('queues') && /secur|cozi|queue/i.test(turns[2].replies.join(' ')), 'Security queue answer/tool absent');
    assert(turns[3].tools.includes('routeTo'), 'Gate route tool absent');
    assert(turns[5].lang === 'en' && /gate/i.test(turns[5].replies.join(' ')), 'English gate reply absent after switch');
    pageToken = /\/m\/([a-f0-9-]{36})/.exec(turns.flatMap(t => t.replies).join(' '))?.[1];
    assert(pageToken, 'Passenger page link absent');
    assert(!r.violations.length, `Lab violations: ${r.violations.map(v => `turn ${v.turn} ${v.rule}`).join(', ')}`);
  });
  if (!pageToken) skip('4 passenger API and web page', 'requires kept profile/link from step 3');
  else await step('4 passenger API and web page', async () => {
    const p = await api(`/api/me?token=${pageToken}`);
    assert(p.flight?.flight === flight && p.flight.gate === 'gate_2', 'Passenger flight/gate mismatch');
    assert(p.queues?.some(q => q.zone === 'security' && Object.hasOwn(q, 'nowMin')), 'Passenger queues absent');
    assert((await request(`/m/${pageToken}`, undefined, { web: true })).status === 200, 'Passenger page did not return 200');
  });
  await step('5 real signed webhook and outbound attempt', async () => {
    const since = new Date().toISOString();
    fakeUsed = true;
    // On older production this also consumes the demo token, avoiding an orphan join record.
    await signed(!pageToken && start ? start : 'English');
    const rows = await poll(events, es => es.some(e => e.phone === masked && e.kind === 'turn' && e.at >= since), 'fake inbound turn recorded');
    const ours = rows.filter(e => e.phone === masked && e.at >= since);
    assert(ours.some(e => e.kind === 'inbound'), 'No inbound event for fake number (allowlist may filter it)');
    const attempts = ours.filter(e => ['outbound', 'send-failure'].includes(e.kind) && ['text', 'interactive'].includes(e.type));
    assert(attempts.length, 'No outbound text attempt recorded');
    assert(!ours.some(e => e.kind === 'agent-error'), 'Handler recorded an agent error');
    assert(attempts.every(e => (e.kind === 'outbound' && e.ok && !e.dryRun) || (e.code === 131030 && /allowed list/i.test(e.explanation))), `Delivery failed: ${attempts.map(e => `${e.code ?? 'no code'} ${e.explanation || (e.dryRun ? 'dry run' : 'sent')}`).join('; ')}`);
    return attempts.some(e => e.code === 131030) ? 'attempted, Meta refused: not in allowed list (131030)' : 'Meta accepted outbound';
  });
  if (!pageToken || !twin) skip('6 admin decision reaches captured passenger', 'requires deployed hooks and isolated full run');
  else await step('6 admin decision reaches captured passenger', async () => {
    assert(!original.blocked.includes('gate_2'), 'Test gate already closed; refusing to alter it');
    await api('/lab/alert-ready', { phone });
    closed = true; // Restore even if the response is lost after the command was accepted.
    const r = await api('/api/ops/command', { type: 'close', zone: 'gate_2' });
    assert(r.command?.type === 'close', 'Close command not accepted');
    await poll(events, es => es.some(e => e.phone === phone && e.kind === 'lab-out' && e.type === 'text'), 'captured admin alert');
    const p = await poll(() => api(`/api/me?token=${pageToken}`), p => p.alerts.some(a => a.kind === 'admin'), 'persisted passenger admin alert');
    const alert = p.alerts.find(a => a.kind === 'admin');
    assert(/closed|închis/i.test(alert.text) && /gate|poart/i.test(alert.text), 'Alert does not describe gate closure');
    assert(!emoji.test(alert.text), 'Urgent gate alert contains emoji (D25)');
    return 'real ops command produced captured text and persisted passenger alert, without emoji';
  });
} finally {
  await step('7 cleanup', async () => {
    const errors = [];
    const clean = async (label, fn) => { try { await fn(); } catch (e) { errors.push(`${label}: ${e.message}`); } };
    if (closed) await clean('reopen gate', async () => { await api('/api/ops/command', { type: 'open', zone: 'gate_2' }); });
    if (hooks && !available) await clean('remove lab passenger', async () => {
      await api('/lab/cleanup', { phone });
      if (pageToken) assert((await request(`/api/me?token=${pageToken}`)).status === 404, 'Passenger page token still active');
    });
    if (fakeUsed) await clean('delete fake webhook profile', async () => {
      const count = (await events()).filter(e => e.phone === masked && e.kind === 'turn').length;
      await signed('delete my data');
      await poll(events, es => es.filter(e => e.phone === masked && e.kind === 'turn').length > count, 'fake profile deletion turn');
    });
    if (injected) await clean('restore flights', async () => {
      twin.send('flight.update', { flights: original.flights });
      await poll(() => api('/api/sim'), s => JSON.stringify(s.flights) === JSON.stringify(original.flights), 'original flights restored');
    });
    if (original) await clean('verify lanes and gates unchanged', async () => {
      const s = await api('/api/sim');
      assert(JSON.stringify(s.lanes) === JSON.stringify(original.lanes) && JSON.stringify(s.blocked) === JSON.stringify(original.blocked), 'Lanes or gates differ from initial state');
    });
    for (const ws of sockets) ws.close();
    assert(!errors.length, errors.join('; '));
    return 'test profiles removed; flights, gates and lanes restored (diagnostic events retained)';
  });
  console.log(`E2E WhatsApp: ${failures} failed, ${skipped} skipped${skipped ? ' (full run incomplete)' : ''}`);
  process.exitCode = failures ? 1 : skipped && !available ? 2 : 0;
  // Bound remote WebSocket close handshakes.
  if (sockets.length) setTimeout(() => process.exit(process.exitCode), 1000).unref();
}

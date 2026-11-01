import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
let mf: Miniflare;
const sent: any[] = [];
beforeAll(() => {
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'auth-test', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    bindings: { WHATSAPP_APP_SECRET: 'auth-secret', WHATSAPP_TOKEN: 'token', WHATSAPP_PHONE_NUMBER_ID: 'PN1',
      WA_ALLOWLIST: '+40712345678,+40711111111', STAFF_PHONES: '0711 111 111' },
    outboundService: async request => {
      if (request.url.includes('graph.facebook.com')) sent.push(await request.json());
      if (request.url.includes('anthropic')) throw new Error('LOGIN must bypass the agent');
      return Response.json(request.url.includes('graph.facebook.com') ? { messages: [{ id: 'out' }] } : []);
    },
  }));
});
afterAll(async () => { await mf.dispose(); });
const post = (path: string, body: unknown, session?: string) => mf.dispatchFetch(`https://worker.example${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(session && { Authorization: `Bearer ${session}` }) }, body: JSON.stringify(body),
});
const me = (session?: string) => mf.dispatchFetch('https://worker.example/api/auth/me', { headers: session ? { Authorization: `Bearer ${session}` } : {} });
let id = 0;
async function webhook(text: string, phone = '40712345678', signed = true) {
  const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' },
    messages: [{ id: `auth-${++id}`, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
  } }] }] });
  return mf.dispatchFetch('https://worker.example/webhooks/whatsapp', { method: 'POST', body: raw,
    headers: { 'X-Hub-Signature-256': signed ? 'sha256=' + createHmac('sha256', 'auth-secret').update(raw).digest('hex') : 'sha256=bad' } });
}
async function login(phone = '40712345678') {
  const pending = await (await post('/api/auth/login-code', {})).json() as any;
  expect(await (await mf.dispatchFetch(`https://worker.example/api/auth/login-code/${pending.pollToken}`)).json()).toEqual({ status: 'pending' });
  expect((await webhook(`LOGIN ${pending.code}`, phone)).status).toBe(200);
  let result: any;
  await expect.poll(async () => {
    result = await (await mf.dispatchFetch(`https://worker.example/api/auth/login-code/${pending.pollToken}`)).json();
    return result.status;
  }).toBe('ok');
  return { ...result, pollToken: pending.pollToken };
}
it('uses signed reverse login, consumes polls and revokes bearer sessions', async () => {
  expect((await me()).status).toBe(401);
  const pending = await (await post('/api/auth/login-code', {})).json() as any;
  expect((await webhook(`LOGIN ${pending.code}`, undefined, false)).status).toBe(403);
  expect(await (await mf.dispatchFetch(`https://worker.example/api/auth/login-code/${pending.pollToken}`)).json()).toEqual({ status: 'pending' });
  const result = await login();
  expect(await (await me(result.session)).json()).toEqual({ phone: '+40712345678', role: 'passenger' });
  await expect.poll(() => sent.some(m => m.text?.body === 'Gata, ești conectat pe site.')).toBe(true);
  expect((await mf.dispatchFetch(`https://worker.example/api/auth/login-code/${result.pollToken}`)).status).toBe(410);
  expect((await post('/api/auth/logout', {}, result.session)).status).toBe(200);
  expect((await me(result.session)).status).toBe(401);
});
it('accepts inbound LOGIN outside the outbound allowlist and reads STAFF_PHONES', async () => {
  const outsider = await login('40722222222');
  expect((await me(outsider.session)).status).toBe(200);
  expect(sent.some(m => m.to === '40722222222')).toBe(false);
  const staff = await login('40711111111');
  expect(await (await me(staff.session)).json()).toMatchObject({ role: 'staff' });
});
it('delivers OTP only inside the window, hides it, verifies once and validates input', async () => {
  expect(await (await post('/api/auth/otp', { phone: '0799 999 999' })).json()).toEqual({ sent: false, reason: 'window' });
  const response = await post('/api/auth/otp', { phone: '0712 345 678' });
  expect(await response.json()).toEqual({ sent: true });
  const code = /Cod Clarion: (\d{6})/.exec(sent.find(m => m.text?.body.startsWith('Cod Clarion:'))?.text.body ?? '')?.[1];
  expect(code).toBeTruthy();
  const verified = await (await post('/api/auth/verify', { phone: '+40712345678', code })).json() as any;
  expect((await me(verified.session)).status).toBe(200);
  expect((await post('/api/auth/verify', { phone: '+40712345678', code })).status).toBe(401);
  expect((await post('/api/auth/otp', { phone: 'bad' })).status).toBe(400);
  expect((await post('/api/auth/link', { token: 'bad' })).status).toBe(401);
});
it('links a signed-in join to its phone with only the personal map link in START', async () => {
  const result = await login();
  const joined = await (await post('/api/join', { flight: 'W6 3751' }, result.session)).json() as any;
  expect(await (await me(result.session)).json()).toMatchObject({ flight: 'W6 3751' });
  await webhook(`START W6 3751 ${joined.token}`);
  await expect.poll(() => sent.some(m => m.text?.body.includes('/m/')), { timeout: 10000 }).toBe(true);
  expect(sent.some(m => m.text?.body.includes('/join?login='))).toBe(false);
  expect((await me(result.session)).status).toBe(200);
});
it('keeps STAFF_CODE roles and supports auth CORS preflights', async () => {
  await webhook('STAFF CRAIOVA2026');
  const result = await login();
  await expect.poll(async () => (await (await me(result.session)).json() as any).role).toBe('staff');
  for (const origin of ['http://localhost:5173', 'https://clarion-craiova.pages.dev']) {
    const response = await mf.dispatchFetch('https://worker.example/api/auth/login-code', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Headers': 'Authorization' } });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  }
  expect((await mf.dispatchFetch('https://worker.example/api/auth/me', { headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
});

it('serves shared web reports behind D3 while denying the staff API to passengers', async () => {
  const result = await login('40733333333');
  expect((await post('/api/join', { flight: 'W6 3751' }, result.session)).status).toBe(201);
  const headers = { Authorization: `Bearer ${result.session}` };
  expect((await post('/api/chat', { text: 'Cozi?' })).status).toBe(401);
  const sendsBefore = sent.length;
  expect((await post('/api/chat', { text: 'Cozi?' }, result.session)).status).toBe(200);
  expect(sent).toHaveLength(sendsBefore);
  const chat = await (await mf.dispatchFetch('https://worker.example/api/chat', { headers })).json() as any;
  expect(chat.history).toContainEqual(expect.objectContaining({ role: 'user', text: 'Cozi?', channel: 'web' }));

  expect((await mf.dispatchFetch('https://worker.example/api/staff', { headers })).status).toBe(403);
  expect((await post('/api/staff/tasks/no/confirm', {}, result.session)).status).toBe(403);
  const response = await post('/api/reports', { type: 'medical', place: { node: 'gate_2', name: 'Poarta 2' }, text: 'Incident' }, result.session);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ source: 'passenger', phone: '+40733333333', priority: 'P1', state: 'sent' });
  const page = await (await mf.dispatchFetch('https://worker.example/api/me', { headers })).json() as any;
  expect(page.reports).toHaveLength(1);
  const staff = await login('40711111111');
  expect((await mf.dispatchFetch('https://worker.example/api/staff', { headers: { Authorization: `Bearer ${staff.session}` } })).status).toBe(200);
});

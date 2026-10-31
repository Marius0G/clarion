import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';

let mf: Miniflare;
beforeAll(() => {
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'join-test', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    bindings: { WAVES_ENABLED: 'false', WHATSAPP_NUMBER: '+40 712 345 678' },
    outboundService: async () => Response.json([]),
  }));
});
afterAll(async () => { await mf.dispose(); });
const post = (path: string, body: unknown) => mf.dispatchFetch(`https://worker.example${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
it('validates flights, creates distinct tokens and formats the configured WhatsApp link', async () => {
  expect((await post('/api/join', {})).status).toBe(400);
  expect((await post('/api/join', { flight: 123 })).status).toBe(400);
  expect((await post('/api/join', { flight: 'W6 3751', name: {} })).status).toBe(400);
  expect((await post('/api/join', { flight: 'XX 9999' })).status).toBe(404);
  const response = await post('/api/join', { flight: 'w63751', name: 'Ana' });
  expect(response.status).toBe(201);
  const result = await response.json() as { token: string; waLink: string };
  expect(result.token).toMatch(/^[a-f0-9]{48}$/);
  expect(result.waLink).toBe(`https://wa.me/40712345678?text=START%20W6%203751%20${result.token}`);
  const next = await post('/api/join', { flight: 'W6 3751' }).then(r => r.json()) as { token: string };
  expect(next.token).not.toBe(result.token);
  const pass = await post('/api/wallet/pass', { joinToken: result.token }).then(r => r.json()) as { saveUrl: string; demo: boolean };
  expect(pass.demo).toBe(true);
  expect(new URL(pass.saveUrl, 'https://app.example').searchParams.get('waLink')).toBe(result.waLink);
  expect((await post('/api/wallet/pass', { joinToken: 'unknown' })).status).toBe(400);
});

it('validates against Unity flights once the current schedule arrives', async () => {
  const response = await mf.dispatchFetch('https://worker.example/ws?client=twin', { headers: { Upgrade: 'websocket' } });
  const ws = response.webSocket!;
  ws.accept();
  try {
    ws.send(JSON.stringify({ type: 'flight.update', ts: new Date().toISOString(), data: { flights: [{
      flight: 'W4 1234', airline: 'W4', destination: 'Roma', std: '18:00', gate: 'gate_1',
      checkIn: 'check_in:1', checkInDesks: [], gateCloseAt: '17:30', status: 'scheduled', delayMin: 0, pax: 180,
    }] } }));
    await expect.poll(async () => (await post('/api/join', { flight: 'W4 1234' })).status).toBe(201);
    expect((await post('/api/join', { flight: 'W6 3751' })).status).toBe(404);
  } finally { ws.close(); }
});

it('validates demo inputs and emits a BCBP even without Wallet credentials', async () => {
  for (const input of [null, [], { flight: 123 }, { name: 123 }, { name: '1'.repeat(81) }])
    expect((await post('/api/join/demo', input)).status).toBe(400);
  expect((await post('/api/join/demo', { flight: 'XX 9999' })).status).toBe(404);
  // This suite may have received a Unity schedule from a prior test; use an isolated tower name.
  const fresh = new Miniflare(convertV4MiniflareOptions({
    name: 'demo-join-test', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } }, outboundService: async () => Response.json([]),
  }));
  try {
    const response = await fresh.dispatchFetch('https://worker.example/api/join/demo', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flight: 'w63401', name: 'Ionescu/Ana' }) });
    expect(response.status).toBe(201);
    const demo = await response.json() as { bcbp: string; token: string; waLink: string; walletUrl: string };
    expect(demo.bcbp.slice(2, 22).trim()).toBe('IONESCU/ANA');
    expect(demo.bcbp.slice(30, 44)).toBe('CRABGYW6 03401');
    expect(new URL(demo.walletUrl, 'https://app.example').pathname).toBe('/join/wallet-demo');
    expect(new URL(demo.walletUrl, 'https://app.example').searchParams.get('waLink')).toBe(demo.waLink);
  } finally { await fresh.dispose(); }
});

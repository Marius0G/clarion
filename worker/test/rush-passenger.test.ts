import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { scheduleForDay } from '../../backend/scripts/feed-math.js';
import { route } from '../../backend/src/routing.js';
import { terminalGraph } from '../../backend/src/terminal.js';
let mf: Miniflare;
const sockets: { close(): void }[] = [], outbound: any[] = [];
const path = route(terminalGraph, 'check_in:1', 'gate_6')!;
beforeAll(() => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'rush-passenger', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    bindings: { DEMO_TOKEN: 'op', SIM_SPEED: '10', APP_URL: 'https://passenger.example', WHATSAPP_APP_SECRET: 'secret', WHATSAPP_TOKEN: 'token', WHATSAPP_PHONE_NUMBER_ID: 'PN' },
    outboundService: async request => {
      if (request.url.endsWith('/routes/index.json')) return Response.json({ points: [], routes: { 'check_in:1__gate_6': { file: 'gate-6.png', walkSec: path.totalSec, nodes: path.nodes } } });
      if (request.url.startsWith('https://graph.facebook.com')) outbound.push(await request.json());
      return Response.json([]);
    } }));
});
afterAll(async () => { sockets.forEach(ws => ws.close()); await mf.dispose(); });
const api = (path: string, data?: unknown) => mf.dispatchFetch(`https://worker.example${path}`, { method: data === undefined ? 'GET' : 'POST',
  headers: { Authorization: 'Bearer op', 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
async function connect(client: string) {
  const r = await mf.dispatchFetch(`https://worker.example/ws?client=${client}&token=op`, { headers: { Upgrade: 'websocket' } });
  expect(r.status).toBe(101);
  const ws = r.webSocket!, messages: any[] = [];
  ws.addEventListener('message', e => messages.push(JSON.parse(String(e.data)))); ws.accept(); sockets.push(ws);
  await expect.poll(() => messages.some(m => m.type === 'state')).toBe(true);
  return (type: string, data: unknown) => ws.send(JSON.stringify({ type, ts: new Date().toISOString(), data }));
}
const texts = () => outbound.filter(b => b.type === 'text').map(b => b.text.body as string);
const payloads = () => outbound.filter(b => ['text', 'interactive', 'image'].includes(b.type));
const sim = async (): Promise<any> => (await api('/api/sim')).json();
it('delivers the D18 rush, recovery, delay and gate change to WhatsApp and web history', async () => {
  const twin = await connect('twin'), vision = await connect('vision');
  const status = async (minute: number) => {
    twin('sim.status', { running: true, scenario: 'rush', arm: 'B', coverage: 1, seed: 1, speed: 10, simTime: 54000 + minute * 60, agents: 0 });
    await expect.poll(async () => (await sim()).simTime).toBe(54000 + minute * 60);
  };
  const flight = scheduleForDay(0).find(f => f.flight === 'W4 3625')!;
  // Camera observations in the same shape as demo-terminal, deliberately crossing the target at 15:10.
  const report = async (waitMin: number, forecastMin: number) => {
    vision('flow.report', { zones: [
      { zone: 'U_SECURITY_QUEUE', waiting: Math.round(waitMin * 4.6), waitingSd: 1.9, density: 0.5, coverage: 1, waitMin, waitMinP90: waitMin + 2,
        forecast: [30, 60, 90, 120].map(inMin => ({ inMin, waitMin: forecastMin })) },
      { zone: 'check_in:1', waiting: 3, waitMin: 1, coverage: 1, density: 0.1, forecast: [30, 60, 90, 120].map(inMin => ({ inMin, waitMin: 1 })) },
    ] });
    await expect.poll(async () => (await sim()).flow.U_SECURITY_QUEUE.waitMin).toBe(waitMin);
  };
  await status(-5); twin('flight.update', { flights: [flight] });
  await expect.poll(async () => (await sim()).flights[0]?.flight).toBe(flight.flight);
  await report(2, 3);
  const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN' },
    messages: [{ id: 'wamid.rush.start', from: '40712345678', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'START W4 3625' } }] } }] }] });
  expect((await mf.dispatchFetch('https://worker.example/webhooks/whatsapp', { method: 'POST', body: raw,
    headers: { 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'secret').update(raw).digest('hex') } })).status).toBe(200);
  await expect.poll(() => outbound.some(b => b.type === 'interactive'), { timeout: 15000 }).toBe(true);
  const token = /\/m\/([^\s]+)/.exec(texts().join('\n'))![1];
  const page = async (): Promise<any> => (await api(`/api/me?token=${token}`)).json();
  expect((await page()).stage).toBe('public');
  const initial = payloads().length;
  await status(0);
  twin('truth.report', { zones: [{ zone: 'U_SECURITY_QUEUE', waiting: 999, waitMin: 99 }] });
  await status(9); await report(9, 24);
  expect(payloads()).toHaveLength(initial);
  await status(10); await report(11, 24);

  await expect.poll(() => texts().some(t => t.includes('~24 min')), { timeout: 10000 }).toBe(true);
  await expect.poll(async () => (await page()).timeline.some((e: any) => e.at === '15:10')).toBe(true);
  const afterFlow = payloads().length;
  await status(15);
  expect((await api('/api/ops/command', { type: 'staff', zone: 'U_SECURITY_QUEUE', delta: 1 })).status).toBe(202);
  await report(8, 4); expect(payloads()).toHaveLength(afterFlow);
  await status(25); await report(7, 3);
  await expect.poll(() => texts().some(t => t.includes('Coada este așteptată să scadă')), { timeout: 10000 }).toBe(true);
  const afterRecovery = payloads().length;
  await report(7, 3); expect(payloads()).toHaveLength(afterRecovery);
  await status(26);
  const delayed = { ...flight, status: 'delayed', delayMin: 30 };
  twin('flight.update', { flights: [delayed] }); twin('flight.update', { flights: [delayed] });
  await expect.poll(() => texts().filter(t => t.includes('întârziere de 30 min')).length, { timeout: 10000 }).toBe(1);
  await status(27);
  twin('flight.update', { flights: [{ ...delayed, gate: 'gate_6' }] }); twin('flight.update', { flights: [{ ...delayed, gate: 'gate_6' }] });
  await expect.poll(() => outbound.filter(b => b.type === 'image').length, { timeout: 10000 }).toBe(1);
  await expect.poll(async () => (await page()).timeline.filter((e: any) => e.kind === 'route').length).toBe(1);
  const timeline = (await page()).timeline, joined = timeline.map((e: any) => e.text).join('\n');
  const phases = ['~24 min', 'Coada este așteptată să scadă', 'întârziere de 30 min', 'poarta s-a schimbat la 6'].map(p => { expect(joined).toContain(p); return joined.indexOf(p); });
  expect(phases).toEqual([...phases].sort((a, b) => a - b));
  expect(joined).not.toMatch(/99 min|demo|simul|pleacă acum|fii la|disclaimer|expected|Flight /iu);
  const times = [...new Set(timeline.filter((e: any) => ['arrive', 'admin'].includes(e.kind)).map((e: any) => e.at))] as string[];
  for (let i = 1; i < times.length; i++) {
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    expect(minutes(times[i]!) - minutes(times[i - 1]!)).toBeGreaterThanOrEqual(10);
  }
  for (const e of timeline.filter((e: any) => e.kind === 'flight')) expect(e.text).not.toMatch(/\p{Extended_Pictographic}/u);
  expect(texts().filter(t => t.includes('poarta s-a schimbat'))).toHaveLength(1);
  expect(new Set(timeline.map((e: any) => `${e.at}:${e.text}`)).size).toBe(timeline.length);
  for (const b of outbound.filter(b => b.type === 'text')) expect(b.text.body.length).toBeLessThanOrEqual(180);
  for (const e of timeline) expect(payloads().some(b => b.text?.body === e.text || b.image?.caption === e.text)).toBe(true);
  const scenario = payloads().slice();
  const transcript = scenario.map(b => ({ recipient: b.to, type: b.type === 'interactive' ? 'buttons' : b.type,
    text: b.text?.body ?? b.interactive?.body.text ?? b.image?.caption }));
  expect(transcript).toEqual([
    { recipient: '40712345678', type: 'text', text: 'Gata ✈️ Te-am conectat la zborul W4 3625 spre Birmingham.' },
    { recipient: '40712345678', type: 'text', text: 'Zborul W4 3625 spre Birmingham. Nu e coadă la Check-in, grupul 1 acum. Nu e coadă la securitate acum. De la securitate până la poarta 3 ~2 min de mers, ~4 min de stat la coadă.' },
    { recipient: '40712345678', type: 'text', text: 'Poarta 3 se închide la 16:30. Pleacă spre securitate până la 16:10.' },
    { recipient: '40712345678', type: 'text', text: `https://passenger.example/m/${token}` },
    { recipient: '40712345678', type: 'buttons', text: 'Ai bagaj de cală?' },
    { recipient: '40712345678', type: 'text', text: 'Coada la securitate a crescut: ~11 min acum, ~24 min în jur de 15:40. Până la poartă ai nevoie de ~25 min.' },
    { recipient: '40712345678', type: 'text', text: 'Control de securitate: s-a deschis o linie în plus. Coada este așteptată să scadă la ~3 min până la 15:55.' },
    { recipient: '40712345678', type: 'text', text: 'Zborul W4 3625 are o întârziere de 30 min. Pleacă la 17:10, poarta se închide la 17:00.' },
    { recipient: '40712345678', type: 'text', text: 'Zborul W4 3625: poarta s-a schimbat la 6.' },
    { recipient: '40712345678', type: 'image', text: 'Traseu spre poarta 6' },
  ]);
  expect(transcript.filter(m => m.text.includes('/m/'))).toHaveLength(1);
  expect(transcript.slice(5).every(m => !m.text.includes('Check-in'))).toBe(true);
  expect(scenario.at(-1).image.link).toBe('https://passenger.example/routes/gate-6.png');

  await api('/api/auth/otp', { phone: '+40712345678' });
  const code = /Cod Clarion: (\d{6})/.exec(texts().at(-1)!)![1];
  const session: any = await (await api('/api/auth/verify', { phone: '+40712345678', code })).json();
  const chatResponse = await mf.dispatchFetch('https://worker.example/api/chat', { headers: { Authorization: `Bearer ${session.session}` } });
  expect(chatResponse.status).toBe(200);
  const chat: any = await chatResponse.json();
  for (const b of scenario) {
    const text = b.text?.body ?? b.interactive?.body.text ?? b.image?.caption;
    expect(chat.history.filter((e: any) => e.text === text), text).toHaveLength(scenario.filter(v => (v.text?.body ?? v.interactive?.body.text ?? v.image?.caption) === text).length);
    if (b.image) expect(chat.history.find((e: any) => e.text === text).image).toBe(b.image.link);
  }
  console.log('RUSH_TRANSCRIPT\n' + scenario.map(b => JSON.stringify({ recipient: b.to, type: b.type === 'interactive' ? 'buttons' : b.type,
    text: b.text?.body ?? b.interactive?.body.text ?? b.image?.caption, ...(b.image && { image: b.image.link }), ...(b.interactive && { buttons: b.interactive.action.buttons.map((v: any) => v.reply) }) })).join('\n'));
}, 45000);

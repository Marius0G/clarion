import { expect, it } from 'vitest';
import { evacuationRoute, exitSide } from '../../backend/src/evacuation.js';
import { nodeName } from '../src/wa/texts.js';
import { WhatsAppAgent, type WaStore } from '../src/wa/index.js';
import { airportView } from '../src/wa/tower.js';
class Store implements WaStore {
  data = new Map<string, unknown>();
  async get<T>(key: string) { return this.data.get(key) as T | undefined; }
  async put(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
}
it.each([
  ['public', 54000, undefined, 'check_in:1', 'landside'],
  ['airside', 58000, undefined, 'airside', 'airside'],
  ['gate', 59200, undefined, 'gate_3', 'airside'],
  ['landmark', 54000, { node: 'gate_6', at: 54000000 }, 'gate_6', 'airside'],
  ['expired landmark', 54000, { node: 'gate_6', at: 53000000 }, 'check_in:1', 'landside'],
] as const)('shares %s fallback routes, assembly and images between WhatsApp and /m', async (_name, simTime, position, from, side) => {
  const store = new Store(), sent: any[] = [];
  const f = { flight: 'W4 3625', airline: 'W4', destination: 'Birmingham', std: 60000, gateCloseAt: 59400, gate: 'gate_3', checkIn: 'check_in:1', checkInDesks: [], status: 'scheduled', delayMin: 0, pax: 193 };
  const view = airportView({ snapshot: () => ({ simTime, flights: [f], flow: {}, blocked: [] }) }, () => true);
  const expected = evacuationRoute(from)!;
  expect(exitSide(expected.exit)).toBe(side);
  const agent = new WhatsAppAgent({ APP_URL: 'https://passenger.example', WA_TOKEN: 't', WA_PHONE_NUMBER_ID: 'PN' }, store, view,
    { pause: 0, evacWaitMs: 0, fetcher: async (url, init) => {
      if (url.endsWith('/routes/index.json')) return Response.json({ points: [], routes: {}, evac: { [from]: { exit: expected.exit, assembly: expected.assembly, file: `${from}.png`, caption: 'Ieșire și adunare' } } });
      sent.push(JSON.parse(String(init?.body))); return Response.json({});
    } });
  const phone = '+40712345678';
  await store.put(`wa:profile:${phone}`, { phone, role: 'passenger', flight: f.flight, lang: 'ro', ...(position && { position }) });
  await store.put(`wa:last:${phone}`, Date.now()); await agent.messaging.addPhone(phone);
  const token = (await agent.messaging.pageLink({ channel: 'whatsapp', phone })).split('/').at(-1)!;
  await agent.messaging.evacuate([], 'fallback');
  const text = sent.filter(b => b.type === 'text').map(b => b.text.body).join(' ');
  expect(text).toContain(`Ieși pe ${nodeName(expected.exit)}`);
  expect(text).toContain(`Punct de adunare: ${nodeName(expected.assembly)}`);
  expect(text).not.toMatch(/\p{Extended_Pictographic}|demo|simul/iu);
  expect(sent.find(b => b.type === 'image').image).toEqual({ link: `https://passenger.example/routes/${from}.png`, caption: 'Ieșire și adunare' });
  const page = await agent.messaging.passenger(token);
  expect(page?.evacuation.route).toEqual({ exit: nodeName(expected.exit), steps: [...expected.route.nodes, expected.assembly].map(n => nodeName(n)) });
  expect(page?.routeImage).toBe(`https://passenger.example/routes/${from}.png`);
  expect(page?.assembly).toBe(expected.assembly);
  expect((await agent.chatHistory(phone)).some(e => e.text === 'Ieșire și adunare' && 'image' in e)).toBe(true);
});

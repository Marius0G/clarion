import { describe, expect, it, vi } from 'vitest';
import { WhatsAppAgent, type WaStore } from '../src/wa/index.js';
import { toolsFor, arrivalPlan, situationText, type Profile, type AirportView } from '../src/wa/tools.js';
import { airportInfo, RouteImages, resolveLandmark, LANDMARK_TTL_MS } from '../src/wa/airport-info.js';
import { check, runLab } from '../src/wa/lab.js';
const flight = { flight: 'W4 106', airline: 'W4', destination: 'Dortmund', std: 21600, gateCloseAt: 21000, gate: 'gate_10', checkIn: 'check_in:1', checkInDesks: ['checkin_1'], status: 'scheduled' as const, delayMin: 0 };
const forecast = [30, 60, 90, 120].map(inMin => ({ inMin, waitMin: 0 }));
const view: AirportView = { clock: () => ({ now: 3 * 3600, sim: true }), flights: () => [flight], flow: () => ({ security: { waiting: 0, waitMin: 0, forecast }, 'check_in:1': { waiting: 0, waitMin: 0, forecast } }), provisional: () => false };
class Store implements WaStore {
  data = new Map<string, unknown>();
  async get<T>(k: string) { return this.data.get(k) as T | undefined; }
  async put(k: string, v: unknown) { this.data.set(k, structuredClone(v)); }
  async delete(k: string) { return this.data.delete(k); }
}
function harness(index: unknown = null) {
  const store = new Store(), sends: any[] = [];
  const agent = new WhatsAppAgent({ APP_URL: 'https://site.test', WHATSAPP_TOKEN: 'capture', WHATSAPP_PHONE_NUMBER_ID: 'p' }, store, view, { pause: 0,
    fetcher: async (url, init) => {
      if (url.includes('/routes/')) return index ? Response.json(index) : new Response('', { status: 404 });
      sends.push(JSON.parse(String(init?.body))); return Response.json({});
    } });
  const receive = (text: string, replyId: string | null = null) => agent.receive({ id: crypto.randomUUID(), phone: '+40712345678', name: '', type: replyId ? 'interactive' : 'text', text, replyId, at: Date.now() });
  return { store, sends, agent, receive };
}
function tools(initial: Partial<Profile> = {}, now = () => 1000, airport = view) {
  let profile: Profile = { phone: '+40712345678', role: 'passenger', flight: flight.flight, ...initial };
  return { get: () => profile, tools: toolsFor({ view: airport, profile: () => profile, save: async patch => { profile = { ...profile, ...patch }; }, now }) };
}
describe('WhatsApp passenger quality regressions', () => {
  it('6: airport knowledge includes floors and security sides for every amenity', async () => {
    for (const query of ['Unde e toaleta?', 'where can I eat', 'ATM', 'info', 'Duty free']) {
      const r = airportInfo({ query });
      expect(r.found, query).toBe(true);
      expect(r.facts[0]?.text).toMatch(/parter|etajul 1/);
      expect(r.facts[0]?.text).toMatch(/înainte|după/);
    }
    expect(await tools().tools.routeTo!({ to: 'toilet', from: 'Hol central' })).toMatchObject({ status: 'ready', to: 'G_WC' });
    expect(await tools().tools.routeTo!({ to: 'food', from: 'Duty free' })).toMatchObject({ status: 'ready', to: 'U_CAFE' });
    expect(await tools().tools.routeTo!({ to: 'ATM', from: 'Hol central' })).toMatchObject({ status: 'ready' });
  });
  it('6: D9 picks an airside amenity from flight time without reading passenger truth', async () => {
    const airport = { ...view, clock: () => ({ now: 5 * 3600 + 5 * 60, sim: true }) };
    expect(await tools({}, undefined, airport).tools.routeTo!({ to: 'toilet' })).toMatchObject({ status: 'ready', from: 'airside', to: 'U_WC' });
    const gate = { ...view, clock: () => ({ now: 5 * 3600 + 40 * 60, sim: true }) };
    expect(await tools({}, undefined, gate).tools.routeTo!({ to: 'food' })).toMatchObject({ status: 'ready', from: 'gate_10', to: 'U_CAFE' });
  });
  it('6: a named landmark destination stays the destination', async () => {
    const h = harness(); await h.receive('START W4 106'); h.sends.length = 0;
    await h.receive('Sunt la Intrare plecări. Cum ajung la Hol central?');
    expect(h.sends.some(s => s.text?.body.includes('Hol central:'))).toBe(true);
  });
  it('7: uses explicit landmark, retains it for ten minutes, then asks one short question', async () => {
    let now = 1000;
    const h = tools({}, () => now);
    expect(resolveLandmark('Sunt la Hol central. Cum ajung la poartă?')).toBe('G_CENTER');
    expect(await h.tools.routeTo!({ to: 'gate' })).toMatchObject({ status: 'needs_location', buttons: expect.any(Array) });
    expect(await h.tools.routeTo!({ to: 'gate', from: 'Hol central' })).toMatchObject({ status: 'ready', from: 'G_CENTER' });
    expect(h.get().position).toEqual({ node: 'G_CENTER', at: 1000 });
    now += LANDMARK_TTL_MS - 1;
    expect(await h.tools.routeTo!({ to: 'toilet' })).toMatchObject({ status: 'ready', from: 'G_CENTER' });
    now++;
    expect(await h.tools.routeTo!({ to: 'toilet' })).toMatchObject({ status: 'needs_location' });
  });
  it('7: an amenity name alone never becomes the current position', async () => {
    const h = harness(); await h.receive('ATM');
    expect((await h.agent.profile('+40712345678'))?.position).toBeUndefined();
    expect(h.sends.some(s => s.type === 'interactive')).toBe(true);
  });
  it('7: a location button resumes the pending route', async () => {
    const h = harness(); await h.receive('START W4 106'); h.sends.length = 0;
    await h.receive('Cum ajung la poartă?');
    expect(h.sends.find(s => s.type === 'interactive').interactive.body.text).toBe('Unde ești acum?');
    h.sends.length = 0;
    await h.receive('Intrare plecări', 'loc:entrance');
    expect(h.sends.some(s => s.text?.body?.includes('min de mers'))).toBe(true);
    expect((await h.agent.profile('+40712345678'))?.position?.node).toBe('entrance');
  });
  it('8: missing index, missing route and present route attach/skip without disrupting text', async () => {
    for (const index of [null, { points: [], routes: {} }, { points: [], routes: { G_CENTER__G_WC: { file: 'toilet.png', walkSec: 42, steps: [] } } }]) {
      const h = harness(index); await h.receive('Unde e toaleta? Sunt la Hol central.');
      const images = h.sends.filter(s => s.type === 'image');
      expect(images.length).toBe(index && Object.keys(index.routes).length ? 1 : 0);
      expect(h.sends.some(s => s.text?.body?.includes('Toalete'))).toBe(true);
      if (images.length) {
        expect(h.sends.at(-1)).toBe(images[0]);
        expect(images[0].image).toEqual({ link: 'https://site.test/routes/toilet.png', caption: 'Toalete · ~1 min' });
      }
    }
  });
  it('8: caches indexes, accepts aliases, and handles network and malformed indexes', async () => {
    const fetcher = vi.fn(async () => Response.json({ points: [{ id: 'G_CENTER', name: { ro: 'Hol central', en: 'Central hall' }, aliases: ['lobby'] }], routes: {} }));
    const images = new RouteImages('https://site.test', fetcher);
    expect(resolveLandmark('I am at lobby', await images.index())).toBe('G_CENTER');
    await images.image('a', 'b'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await new RouteImages('https://site.test', async () => { throw Error('offline'); }).image('a', 'b')).toBeNull();
    expect(await new RouteImages('https://site.test', async () => Response.json({ points: [null], routes: {} })).index()).toBeNull();
  });
  it('lab rejects all prohibited disclaimers and exercises amenities and stated routes', async () => {
    for (const text of ['ora simulării', 'simulation time', '(estimare)', 'demo']) {
      expect(check([{ user: 'salut', replies: [text], tools: [], ms: 0, lang: 'ro' }]).map(v => v.rule)).toContain('no-disclaimer');
    }
    for (const script of ['toilet', 'food', 'landmarkRoute']) {
      const result = await runLab({}, view, { script }, new Store(), async () => new Response('', { status: 404 }));
      expect(result.results[script]?.violations, script).toEqual([]);
    }
  });
});

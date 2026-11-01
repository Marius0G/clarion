import { describe, expect, it, vi } from 'vitest';
import { reply, contextBlock } from '../src/wa/agent.js';
import { clockFrom } from '../src/wa/flights.js';
import { copy } from '../src/wa/texts.js';
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
function harness(index: unknown = null, airport = view, model = false) {
  const store = new Store(), sends: any[] = [];
  let modelCalls = 0;
  const agent = new WhatsAppAgent({ ...(model && { ANTHROPIC_API_KEY: 'test' }), APP_URL: 'https://site.test', WHATSAPP_TOKEN: 'capture', WHATSAPP_PHONE_NUMBER_ID: 'p' }, store, airport, { pause: 0, evacWaitMs: 0,
    fetcher: async (url, init) => {
      if (url.includes('anthropic.com')) return Response.json(++modelCalls === 1
        ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r', name: 'routeTo', input: { to: 'gate', from: 'entrance' } }] }
        : { content: [{ type: 'text', text: 'Traseul pornește de la intrare și trece prin Holul central.' }] });
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
  it('7: landmark age follows simulation time, including a paused or reset clock', async () => {
    let simSec = 100;
    const airport = { ...view, clock: () => ({ now: simSec, sim: true }) };
    let profile: Profile = { phone: '+40712345678', role: 'passenger', flight: flight.flight };
    const t = toolsFor({ view: airport, profile: () => profile, save: async patch => { profile = { ...profile, ...patch }; } });
    await t.routeTo!({ to: 'gate', from: 'Hol central' });
    expect(profile.position?.at).toBe(100_000);
    simSec += 599;
    expect(await t.routeTo!({ to: 'gate' })).toMatchObject({ status: 'ready', from: 'G_CENTER' });
    simSec++;
    expect(await t.routeTo!({ to: 'gate' })).toMatchObject({ status: 'needs_location' });
    simSec = 50;
    expect(await t.routeTo!({ to: 'gate' })).toMatchObject({ status: 'needs_location' });
    const h = harness(null, airport);
    await h.receive('Sunt la Hol central.');
    expect((await h.agent.profile('+40712345678'))?.position?.at).toBe(50_000);
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
    const live = await tools().tools.routeTo!({ to: 'toilet', from: 'Hol central' }) as any;
    for (const index of [null, { points: [], routes: {} }, { points: [], routes: { G_CENTER__G_WC: { file: 'toilet.png', walkSec: 42, steps: live.nodes } } }]) {
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
  it('8: rejects blocked, changed, flagged and unrecorded static paths', async () => {
    const nodes = ['G_CENTER', 'U_SECURITY', 'gate_10'];
    const index = { points: [], routes: { G_CENTER__gate_10: { file: 'gate.png', walkSec: 42, steps: nodes } } };
    const images = new RouteImages('https://site.test', async () => Response.json(index));
    expect(await images.image('G_CENTER', 'gate_10', { nodes })).toMatchObject({ link: 'https://site.test/routes/gate.png' });
    expect(await images.image('G_CENTER', 'gate_10', { nodes }, ['security'])).toBeNull();
    expect(await images.image('G_CENTER', 'gate_10', { nodes }, ['U_SECURITY_QUEUE'])).toBeNull();
    expect(await images.image('G_CENTER', 'gate_10', { nodes, rerouted: true })).toBeNull();
    expect(await images.image('G_CENTER', 'gate_10', { nodes, reroute: true })).toBeNull();
    expect(await images.image('G_CENTER', 'gate_10', { nodes: ['G_CENTER', 'gate_10'] })).toBeNull();
    index.routes.G_CENTER__gate_10.steps = [];
    expect(await new RouteImages('https://site.test', async () => Response.json(index)).image('G_CENTER', 'gate_10', { nodes })).toBeNull();
  });
  it('8: camera closures or impassable density suppress normal previews but preserve text', async () => {
    const live = await tools().tools.routeTo!({ to: 'toilet', from: 'Hol central' }) as any;
    const index = { points: [], routes: { G_CENTER__G_WC: { file: 'toilet.png', walkSec: 42, steps: live.nodes } } };
    for (const airport of [
      { ...view, blocked: () => ['G_WC'] },
      { ...view, flow: () => ({ ...view.flow(), G_WC: { waiting: 100, waitMin: 10, density: 5.4 } }) },
    ]) {
      const h = harness(index, airport);
      await h.receive('Unde e toaleta? Sunt la Hol central.');
      expect(h.sends.some(s => s.type === 'text')).toBe(true);
      expect(h.sends.filter(s => s.type === 'image')).toHaveLength(0);
    }
  });
  it('8: an active evacuation replaces a matching normal preview with evac[zone]', async () => {
    const live = await tools().tools.routeTo!({ to: 'toilet', from: 'Hol central' }) as any;
    const index = { points: [], routes: { G_CENTER__G_WC: { file: 'toilet.png', walkSec: 42, steps: live.nodes } },
      evac: { G_CENTER: { file: 'evac.png', exit: 'exit_west', assembly: 'ASSEMBLY_LANDSIDE_WEST' } } };
    const h = harness(index);
    await h.store.put('msg:evacuation', { active: true, zones: ['G_CENTER'] });
    await h.receive('Unde e toaleta? Sunt la Hol central.');
    expect(h.sends.filter(s => s.type === 'image').map(s => s.image.link)).toEqual(['https://site.test/routes/evac.png']);
    expect(h.sends.findIndex(s => s.type === 'text')).toBeLessThan(h.sends.findIndex(s => s.type === 'image'));
  });
  it('8: caches indexes, accepts aliases, and handles network and malformed indexes', async () => {
    const fetcher = vi.fn(async () => Response.json({ points: [{ id: 'G_CENTER', name: { ro: 'Hol central', en: 'Central hall' }, aliases: ['lobby'] }], routes: {} }));
    const images = new RouteImages('https://site.test', fetcher);
    expect(resolveLandmark('I am at lobby', await images.index())).toBe('G_CENTER');
    await images.image('a', 'b'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await new RouteImages('https://site.test', async () => { throw Error('offline'); }).image('a', 'b')).toBeNull();
    expect(await new RouteImages('https://site.test', async () => Response.json({ points: [null], routes: {} })).index()).toBeNull();
  });
  it('9: follows English and Romanian messages and remembers each switch', async () => {
    const h = harness();
    await h.receive('Is my flight on time?');
    expect((await h.agent.profile('+40712345678'))?.lang).toBe('en');
    expect(h.sends.some(s => s.text?.body?.includes('flight number'))).toBe(true);
    h.sends.length = 0;
    await h.receive('Where can I eat something?');
    expect(h.sends.some(s => s.interactive?.body?.text === 'Where are you now?')).toBe(true);
    await h.receive('Cum ajung la poarta mea?');
    expect((await h.agent.profile('+40712345678'))?.lang).toBe('ro');
    await h.receive('English');
    await h.receive('Unde este poarta mea?');
    expect((await h.agent.profile('+40712345678'))?.lang).toBe('en');
    await h.receive('Română');
    await h.receive('Where is my gate?');
    expect((await h.agent.profile('+40712345678'))?.lang).toBe('ro');
  });
  it('10: model context, tool inputs and reply use 05:12 despite wall time 09:44', async () => {
    const real = Date.UTC(2026, 10, 1, 7, 44);
    const clock = clockFrom(5 * 3600 + 12 * 60, false, real);
    expect(clock).toEqual({ now: 18720, sim: true });
    expect(clockFrom(null, false, real)).toEqual({ now: 0, sim: true });
    const requests: any[] = [], inputs: any[] = [];
    const memory = { history: [], notes: [{ at: '2026-11-01T09:44:00Z', tool: 'myFlight', note: 'checked' }], alerts: [{ at: '2026-11-01T09:44:00Z', kind: 'flight', text: 'gate 10' }] };
    const profile: Profile = { phone: '+40712345678', role: 'passenger', lang: 'en', flight: flight.flight };
    expect(contextBlock(profile, clock, memory)).not.toContain('09:44');
    const airport = { ...view, clock: () => clock };
    const actual = tools({}, undefined, airport).tools;
    const result = await reply({ env: { ANTHROPIC_API_KEY: 'test' }, profile, clock, memory, history: [], text: 'Is my flight on time?',
      tools: { myFlight: async input => { inputs.push(input); return actual.myFlight!(input); } },
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        return Response.json(requests.length === 1 ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'myFlight', input: {} }] }
          : { content: [{ type: 'text', text: `It is 05:12. Gate closes at ${JSON.parse(body.messages.at(-1).content[0].content).gateCloseAt}.` }] });
      } });
    expect(JSON.stringify({ requests, inputs, result })).not.toContain('09:44');
    expect(result.bubbles.join(' ')).toContain('05:12');
    expect(await actual.whenToArrive!({})).toMatchObject({ late: false });
  });
  it('11: starts the exact reported gate route at the stated landmark, including index aliases', async () => {
    const h = harness({ points: [{ id: 'G_CENTER', name: { ro: 'Hol central', en: 'Central hall' }, aliases: ['lobby'] }], routes: {} });
    await h.receive('START W4 106'); h.sends.length = 0;
    await h.receive('Sunt la Hol central, cum ajung la poarta mea?');
    expect((await h.agent.profile('+40712345678'))?.position?.node).toBe('G_CENTER');
    expect(h.sends.some(s => s.text?.body?.startsWith('Hol central →'))).toBe(true);
    h.sends.length = 0;
    await h.receive('I am at lobby, how do I get to my gate?');
    expect(h.sends.some(s => s.text?.body?.startsWith('Central hall →'))).toBe(true);
    expect(h.sends.some(s => /from the entrance|de la intrare/i.test(s.text?.body ?? ''))).toBe(false);
  });
  it('11: a model cannot replace the stated origin with entrance in the tool or route text', async () => {
    const h = harness(null, view, true);
    await h.store.put('wa:profile:+40712345678', { phone: '+40712345678', role: 'passenger', flight: flight.flight, lang: 'ro' });
    await h.receive('Sunt la Hol central, cum ajung la poarta mea?');
    expect(h.sends.some(s => s.text?.body?.startsWith('Hol central →'))).toBe(true);
    expect(h.sends.some(s => s.text?.body?.includes('pornește de la intrare'))).toBe(false);
    expect((await h.agent.profile('+40712345678'))?.position?.node).toBe('G_CENTER');
  });
  it('12: neutral zone grammar and consistent singular register contain no emoji', () => {
    const text = copy.evacuation('ro', ['G_CENTER']) + copy.evacuationRoad('ro', null);
    expect(text).toContain('Zona Hol central este închisă');
    expect(text).toContain('Dacă ești');
    expect(text).not.toMatch(/sunteți|veniți|Vă|\p{Extended_Pictographic}/u);
  });
  it('12: sends named exit, assembly and optional image, then delivers the reopening follow-up', async () => {
    for (const hasImage of [true, false]) {
      let blocked = ['G_CENTER'];
      const h = harness({ points: [], routes: {}, evac: { G_CENTER: { exit: 'exit_west', assembly: 'ASSEMBLY_LANDSIDE_WEST', ...(hasImage && { file: 'evac.png' }) } } }, { ...view, blocked: () => blocked });
      await h.receive('START W4 106'); h.sends.length = 0;
      await h.agent.messaging.evacuate(blocked, 'e1');
      const text = h.sends.find(s => s.text)?.text.body;
      expect(text).toContain('exit_west');
      expect(text).toContain('Punct de adunare:');
      expect(text).not.toMatch(/\p{Extended_Pictographic}|sunteți|Vă/u);
      expect(h.sends.filter(s => s.type === 'image')).toHaveLength(hasImage ? 1 : 0);
      if (hasImage) expect(h.sends.at(-1).image).toEqual({ link: 'https://site.test/routes/evac.png', caption: 'Traseu de evacuare' });
      blocked = []; h.sends.length = 0;
      await h.agent.messaging.adminChanged({ type: 'open', zone: 'G_CENTER' } as any);
      expect(h.sends.some(s => s.text?.body?.includes('s-a redeschis'))).toBe(true);
    }
  });
  it('12: missing evacuation indexes still send text and retain the all-clear audience', async () => {
    const h = harness(null, { ...view, blocked: () => ['G_CENTER'] });
    await h.receive('START W4 106'); h.sends.length = 0;
    await h.agent.messaging.evacuate(['G_CENTER'], 'missing');
    expect(h.sends.some(s => s.text?.body?.startsWith('Evacuare:'))).toBe(true);
    expect(h.sends.filter(s => s.type === 'image')).toHaveLength(0);
  });
  it('12: vision routes name the assembly point and partial reopening reaches evacuated passengers', async () => {
    let blocked = ['G_CENTER', 'security'];
    const h = harness(null, { ...view, blocked: () => blocked });
    await h.receive('START W4 106'); h.sends.length = 0;
    await h.agent.messaging.plan({ id: 'vision', blocked, clearSec: 60, exits: [], routes: [{ from: 'entrance', exit: 'exit_1', nodes: ['entrance', 'exit_1', 'ASSEMBLY_LANDSIDE_WEST'] }] });
    expect(h.sends.some(s => s.text?.body?.includes('Punct de adunare:'))).toBe(true);
    h.sends.length = 0; blocked = ['security'];
    await h.agent.messaging.adminChanged({ type: 'open', zone: 'G_CENTER' } as any);
    expect(h.sends.some(s => s.text?.body?.includes('Zona Hol central s-a redeschis'))).toBe(true);
    expect(h.sends.some(s => s.text?.body?.includes('Alte zone rămân închise'))).toBe(true);
    h.sends.length = 0; blocked = [];
    await h.agent.messaging.adminChanged({ type: 'open', zone: 'security' } as any);
    expect(h.sends.some(s => s.text?.body?.includes('Terminalul s-a redeschis'))).toBe(true);
  });
  it('13: files a passenger lost-item report with description and place before confirming', async () => {
    const h = harness();
    await h.receive('Am pierdut un rucsac negru la securitate');
    const reports = await h.agent.reports.list();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: 'altele', node: 'security', text: 'Am pierdut un rucsac negru la securitate' });
    const text = h.sends.filter(s => s.text).map(s => s.text.body).join(' ');
    expect(text).toContain('personalul de securitate');
    expect(text).toContain('Lost & Found este la Informații');
    expect(text).toContain('Am transmis');
    expect(text).not.toContain('Recuperarea nu este garantată');
    expect(await tools().tools.reportIssue!({ text: 'incident' })).toMatchObject({ error: 'unavailable' });
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

import { describe, expect, it, vi } from 'vitest';
import { WhatsAppAgent, type WaStore } from '../src/wa/index.js';
import { toolsFor, arrivalPlan, situationText, type Profile, type AirportView } from '../src/wa/tools.js';
import { clockFrom } from '../src/wa/flights.js';
import { copy, queueBand, waitBand, queueText, passengerText, say } from '../src/wa/texts.js';
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
describe('Passenger text regressions', () => {
  it('1: START delivers confirmation, details, baggage question, including repeated START', async () => {
    const h = harness();
    await h.receive('START W4 106');
    const messages = h.sends.filter(s => ['text', 'interactive'].includes(s.type));
    expect(messages.slice(0, -1).every(s => s.type === 'text' && s.text.body.length <= 180)).toBe(true);
    expect(messages[0].text.body).toMatch(/^Gata ✈️ Te-am conectat/);
    expect(messages[0].text.body).not.toMatch(/coadă|https?:/);
    expect(messages.slice(1, -1).map(s => s.text.body).join(' ')).toContain('/m/');
    expect(messages.at(-1).interactive.body.text).toBe('Ai bagaj de cală?');
    h.sends.length = 0; await h.receive('START W4 106');
    expect(h.sends.find(s => s.type === 'text').text.body).toMatch(/^Gata ✈️/);
    expect(h.sends.filter(s => s.type === 'text').every(s => !s.text.body.includes('/m/'))).toBe(true);
  });
  it('2: Romanian and English output has no clock or estimate disclaimers', async () => {
    for (const lang of ['ro', 'en'] as const) {
      const plan = arrivalPlan(flight, view.flow(), view.clock(), false);
      for (const text of [situationText(plan, lang), say(lang, 'startConnected', 'W4 106', 'Dortmund', '10', '05:50', 'simulation time'), say(lang, 'bagQuestion'), say(lang, 'provisional'), say(lang, 'simClock'), say(lang, 'realClock')]) {
        expect(text).not.toMatch(/simulăr|simulation|estimare|demo|ora locală|local time/i);
      }
    }
    expect(passengerText('Poarta 10 (ora simulării).')).toBe('Poarta 10.');
  });
  it('3: START details have exactly one personal link, without login', async () => {
    const h = harness(); await h.receive('START W4 106');
    const details = h.sends.filter(s => s.type === 'text').map(s => s.text.body).join(' ');
    expect(details.match(/https?:\/\/\S+/g)).toHaveLength(1);
    expect(details).not.toMatch(/Conectare:|Sign in:|Log in:/);
    for (const s of h.sends.filter(s => s.type === 'text')) {
      expect(s.text.body.match(/https?:\/\/\S+/g)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(s.text.body).not.toContain('/join?');
    }
  });
  it('4: separates walking and queues from gate closing time and internal margin', () => {
    const text = situationText(arrivalPlan(flight, view.flow(), view.clock(), false));
    expect(text).toMatch(/~\d+ min de mers, fără coadă/);
    expect(text).toContain('Poarta 10 se închide la 05:50.');
    expect(text).not.toMatch(/marjă|inclusiv/);
  });
  it('5: uses zero, low, moderate and high bands with a complete forecast horizon', () => {
    expect(queueText('securitate', 0.4, forecast)).toBe('Nu e coadă la securitate acum.');
    expect(waitBand(3)).toBe('fără coadă');
    expect(waitBand(4)).toBe('coadă moderată, ~4 min');
    expect(waitBand(10)).toBe('coadă moderată, ~10 min');
    expect(waitBand(11)).toBe('coadă mare, ~11 min');
    expect(queueText('security', 0, forecast.slice(0, 1), 'en')).not.toContain('2 hours');
    expect(queueText('security', 0, [{ inMin: 60, waitMin: 15 }], 'en')).toContain('long queue, ~15 min');
  });
});

it.each([[3, 'none'], [4, 'moderate'], [10, 'moderate'], [11, 'large']] as const)('queue band boundary %i', (min, band) => {
  expect(queueBand(min)).toBe(band);
});
it('includes a forecast only across bands, even when a smaller future point crosses the band', () => {
  expect(queueText('Check-in, grupul 1', 1, [{ inMin: 30, waitMin: 3 }])).toBe('Nu e coadă la Check-in, grupul 1 acum.');
  expect(queueText('Securitate', 7, [{ inMin: 30, waitMin: 10 }])).toBe('Securitate: coadă moderată, ~7 min.');
  expect(queueText('Securitate', 11, [{ inMin: 30, waitMin: 24 }])).toBe('Securitate: coadă mare, ~11 min.');
  expect(queueText('Securitate', 7, [{ inMin: 30, waitMin: 11 }])).toBe('Securitate: coadă moderată, ~7 min acum; coadă mare, ~11 min peste 30 min.');
  expect(queueText('Securitate', 11, [{ inMin: 30, waitMin: 24 }, { inMin: 60, waitMin: 2 }])).toContain('fără coadă peste 60 min');
});
it('keeps the map link one-time across a messaging restart and proactive updates', async () => {
  const h = harness(); await h.receive('START W4 106');
  const profile = await h.agent.profile('+40712345678');
  const { Messaging } = await import('../src/wa/messaging.js');
  const restarted = new Messaging({ store: h.store, wa: h.agent.wa, view, toUnity: () => true });
  expect(profile?.pageToken).toBeTruthy();
  await restarted.arrive({ channel: 'whatsapp', phone: '+40712345678' }, flight, false, true);
  expect(h.sends.filter(s => s.type === 'text' && s.text.body.includes('/m/'))).toHaveLength(1);
});
it('spells out time spent queuing', () => {
  const busy = { ...view.flow(), security: { waiting: 4, waitMin: 4 } };
  expect(situationText(arrivalPlan(flight, busy, view.clock(), false))).toContain('~4 min de stat la coadă');
});

it('answers an English question in English even after an explicit Romanian choice', async () => {
  const h = harness();
  await h.receive('Română');
  await h.receive('START W4 106');
  h.sends.length = 0;
  await h.receive('Is there a queue at security?');
  const text = h.sends.filter(s => s.text).map(s => s.text.body).join(' ');
  expect(text).toContain('There is no queue at security now.');
  expect(text).not.toMatch(/coadă|securitate|acum/);
  expect((await h.agent.profile('+40712345678'))?.lang).toBe('en');
});
it('keeps the simulation clock through disconnects and unrelated wall-clock dates', async () => {
  expect(clockFrom(null, false, Date.UTC(2026, 10, 1, 9, 44))).toEqual({ now: 0, sim: true });
  expect(clockFrom(10800, false, Date.UTC(2026, 10, 1, 9, 44))).toEqual({ now: 10800, sim: true });
  const profile: Profile = { phone: '+40712345678', role: 'passenger', flight: flight.flight };
  const tools = toolsFor({ profile: () => profile, save: async () => {}, view });
  expect(await tools.myFlight!({})).toMatchObject({ now: '03:00', departure: '06:00', clock: '' });
});
it.each(['ro', 'en'] as const)('evacuates in %s with a named exit and assembly point, without emoji or formal address', lang => {
  const text = copy.evacuationRoute(lang, copy.blockedAreas(lang, { blocked: ['G_CENTER'] } as any), {
    from: 'G_CENTER', exit: 'exit_1', nodes: ['G_CENTER', 'exit_1', 'ASSEMBLY_LANDSIDE_WEST'], assembly: 'ASSEMBLY_LANDSIDE_WEST',
  });
  expect(text).toContain(lang === 'ro' ? 'Zona Hol central este închisă' : 'Central hall');
  expect(text).toContain(lang === 'ro' ? 'Ieșirea 1' : 'Exit 1');
  expect(text).toContain(lang === 'ro' ? 'Punct de adunare:' : 'Assembly point:');
  expect(text).not.toMatch(/dumneavoastră|\bvă\b|\p{Extended_Pictographic}/u);
});
it('files a lost backpack in the shared journal before sending the lost-property confirmation', async () => {
  const h = harness();
  await h.receive('Am pierdut un rucsac negru la securitate');
  expect(await h.agent.reports.list()).toEqual([expect.objectContaining({ type: 'lost item', source: 'passenger', node: 'security', text: 'Am pierdut un rucsac negru la securitate' })]);
  expect(h.sends.filter(s => s.text).at(-1).text.body).toBe('Am transmis la obiecte pierdute. Te anunțăm aici dacă apare.');
  expect(await h.store.get('wa:report:+40712345678')).toBeUndefined();
});
it.each(['ro', 'en'] as const)('provides walking and a security deadline in %s without exposing the buffer', lang => {
  const plan = arrivalPlan(flight, view.flow(), view.clock(), false);
  const text = situationText(plan, lang);
  expect(text).toContain(plan.beAtEntranceAt);
  expect(text).toContain(lang === 'ro' ? 'Pleacă spre securitate până la' : 'Leave for security by');
  expect(text).not.toMatch(/marjă|margin|estimare|estimate|simul/);
});
it('removes clock suffixes, internal margins and estimate explanations in both languages', () => {
  expect(passengerText('Poarta 10 (ora României).')).toBe('Poarta 10.');
  expect(passengerText('Gate 10 (estimate).')).toBe('Gate 10.');
  expect(passengerText('Drumul ia ~5 min, inclusiv 10 min marjă.')).toBe('Drumul ia ~5 min.');
  expect(passengerText('Estimarea include cozile și mersul. Poarta 10.')).toBe('Poarta 10.');
});

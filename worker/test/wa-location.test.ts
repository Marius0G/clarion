import { describe, expect, it } from 'vitest';
import manifest from '../../app/public/routes/index.json' with { type: 'json' };
import { WhatsAppAgent, type WaStore } from '../src/wa/index.js';
import { locationChoices, resolvePlace, resolveOrigin } from '../src/wa/location.js';
import { runLab } from '../src/wa/lab.js';
import { parseWebhook } from '../src/wa/transport.js';
import { toolsFor, type AirportView, type Profile } from '../src/wa/tools.js';
const phone = '+40712345678';
function harness() {
  const data = new Map<string, unknown>(), sends: any[] = [];
  const store: WaStore = { get: async <T>(k: string) => data.get(k) as T, put: async (k,v) => { data.set(k, structuredClone(v)); }, delete: async k => data.delete(k) };
  let now = 100;
  const view: AirportView = { clock: () => ({ now, sim: true }), flow: () => ({}), flights: () => [], provisional: () => false };
  const agent = new WhatsAppAgent({ APP_URL: 'https://site.test', WA_TOKEN: 't', WA_PHONE_NUMBER_ID: 'p' }, store, view, { pause: 0, fetcher: async (url, init) => {
    if (url.includes('/routes/')) return Response.json(manifest);
    sends.push(JSON.parse(String(init?.body))); return Response.json({});
  } });
  const receive = (text: string, replyId: string | null = null) => agent.receive({ id: crypto.randomUUID(), phone, name: '', text, replyId, type: replyId ? 'interactive' : 'text', at: Date.now() });
  return { agent, store, sends, receive, advance: (sec: number) => { now += sec; }, view };
}
const envelope = { messaging_product: 'whatsapp', recipient_type: 'individual', to: '40712345678' };
describe('catalogue location conversation', () => {
  it('sends the exact Graph list, resumes a list tap, then sends text before the exact route image', async () => {
    const h = harness();
    await h.receive('unde e toaleta');
    expect(h.sends.find(s => s.type === 'interactive')).toEqual({ ...envelope, type: 'interactive', interactive: {
      type: 'list', body: { text: 'Unde ești acum?' }, action: { button: 'Repere', sections: [{ rows: [
        { id: 'loc:door_departures', title: 'Intrare plecări' }, { id: 'loc:G_CHECKIN_QUEUE', title: 'Check-in' },
        { id: 'loc:G_CENTER', title: 'Hol central' }, { id: 'loc:G_INFO', title: 'Informații' },
        { id: 'loc:G_CAFE', title: 'Cafenea' }, { id: 'loc:G_WC', title: 'Toalete parter' },
        { id: 'loc:atm_bcr', title: 'Bancomat BCR' }, { id: 'loc:other', title: 'Altceva' },
      ] }] } } });
    const parsed = parseWebhook({ entry: [{ changes: [{ value: { messages: [{ id: 'tap', from: '40712345678', type: 'interactive', interactive: { list_reply: { id: 'loc:G_CENTER', title: 'Hol central' } } }] } }] }] })[0]!;
    expect(parsed.replyId).toBe('loc:G_CENTER');
    h.sends.length = 0;
    await h.receive(parsed.text!, parsed.replyId);
    expect(h.sends.at(-1)).toEqual({ ...envelope, type: 'image', image: { link: 'https://site.test/routes/G_CENTER__G_WC.png', caption: 'Toalete parter · ~1 min' } });
    expect(h.sends.findIndex(s => s.type === 'text')).toBeLessThan(h.sends.findIndex(s => s.type === 'image'));
  });
  it('uses an explicit ATM origin in the same message without asking, with a matching image', async () => {
    const h = harness(); await h.receive('sunt lângă bancomat, cum ajung la poarta 3');
    expect(h.sends.some(s => s.type === 'interactive')).toBe(false);
    expect(h.sends.at(-1)).toEqual({ ...envelope, type: 'image', image: { link: 'https://site.test/routes/atm_bcr__U_GATE_3.png', caption: 'Poarta 3 · ~3 min' } });
  });
  it('sends the exact evacuation Graph image after text', async () => {
    const h = harness(); await h.store.put('msg:evacuation', { active: true, zones: ['G_CENTER'] });
    await h.receive('Unde e toaleta? Sunt la Hol central.');
    expect(h.sends.at(-1)).toEqual({ ...envelope, type: 'image', image: { link: 'https://site.test/routes/evac/G_CENTER.png', caption: 'Traseu de evacuare' } });
    expect(h.sends.findIndex(s => s.type === 'text')).toBeLessThan(h.sends.findIndex(s => s.type === 'image'));
  });
  it('shares list rows as web history chips, including Other and free text', async () => {
    const h = harness(), entries = await h.agent.chat(phone, 'unde e toaleta');
    expect(entries.find(e => e.buttons)?.buttons).toEqual(locationChoices('public', undefined));
    expect((await h.agent.chatHistory(phone)).some(e => 'buttons' in e && e.buttons?.length === 8)).toBe(true);
    await h.agent.chat(phone, 'Altceva', 'loc:other');
    const result = await h.agent.chat(phone, 'sunt la hol central');
    expect(result.some(e => e.image?.endsWith('G_CENTER__G_WC.png'))).toBe(true);
    expect(h.sends).toEqual([]);
  });
  it('does not repeat the list for ten simulated minutes and accepts an ambiguous confirmation', async () => {
    const h = harness(); await h.receive('unde e toaleta'); h.sends.length = 0;
    await h.receive('unde e toaleta'); expect(h.sends.some(s => s.type === 'interactive')).toBe(false);
    await h.receive('poarta 1 poarta 2');
    expect(h.sends.at(-1).interactive.action.buttons.map((b: any) => b.reply.id)).toEqual(['loc:yes', 'loc:no']);
    await h.receive('Da', 'loc:yes'); expect((await h.agent.profile(phone))?.position?.node).toBe('U_GATE_1');
    h.advance(600); h.sends.length = 0; await h.receive('unde e toaleta');
    expect(h.sends.some(s => s.interactive?.type === 'list')).toBe(true);
  });
  it('answers in English after security, and filters stage choices', async () => {
    const h = harness(); await h.receive('English'); h.sends.length = 0;
    await h.receive('where can I eat? I am at Duty free');
    expect(h.sends.some(s => s.text?.body.includes('first floor'))).toBe(true);
    expect(h.sends.at(-1).image.link).toContain('U_DUTY_FREE__U_CAFE');
    const rows = locationChoices('airside', 'gate_3', 'en');
    expect(rows.some(r => r.id === 'loc:U_GATE_3')).toBe(true);
    expect(rows.some(r => r.id === 'loc:door_departures')).toBe(false);
    expect(rows.length).toBeLessThanOrEqual(10);
  });
  it('runs the three lab scenarios against the real route manifest with images', async () => {
    const h = harness();
    for (const script of ['toilet', 'atmGate', 'food']) {
      const result = await runLab({}, h.view, { script }, h.store, async () => Response.json(manifest));
      expect(result.results[script]?.violations, script).toEqual([]);
      expect(result.results[script]?.transcript.at(-1)?.images, script).toHaveLength(1);
    }
  });
  it('resolves catalogue typos and returns position and nearest-on-route facts', async () => {
    const h = harness(); let profile: Profile = { phone, role: 'passenger' };
    const tools = toolsFor({ view: h.view, profile: () => profile, save: async patch => { profile = { ...profile, ...patch }; } });
    expect(resolveOrigin('I am at Info. Where is Gourmet Bar?')?.id).toBe('G_INFO');
    expect(resolvePlace('poarat 3')?.id).toBe('U_GATE_3');
    const result = await tools.airportInfo!({ query: 'unde e Gourmet Bar' }) as any;
    expect(result.facts[0].text).toContain(resolvePlace('Gourmet Bar')!.position);
    expect(result.nearest.some((n: any) => n.kind === 'wc')).toBe(true);
  });
});

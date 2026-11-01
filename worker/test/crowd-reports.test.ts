import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../backend/tests/personal-contract.js';
import { WhatsAppAgent } from '../src/wa/index.js';
import { Reports, classifyIssue, crowdNote } from '../src/wa/reports.js';
import { toolsFor, type AirportView } from '../src/wa/tools.js';
import { PROVISIONAL_FLIGHTS } from '../src/wa/flights.js';
import { fallbackReply } from '../src/wa/agent.js';
const note = 'Personalul semnalează aglomerație la securitate.';
function setup() {
  const store = new MemoryStore(), sent: any[] = [], unity: any[] = [];
  const view: AirportView = { clock: () => ({ now: 7 * 3600, sim: true }), provisional: () => true, flights: () => PROVISIONAL_FLIGHTS,
    flow: () => ({ security: { waiting: 62, waitMin: 12, forecast: [{ inMin: 30, waitMin: 20 }] } }) };
  const agent = new WhatsAppAgent({ WA_TOKEN: 't', WA_PHONE_NUMBER_ID: 'PN', STAFF_ASSIGNMENTS: JSON.stringify({ '+40711111111': { zone: 'gate_3', role: 'hall_agent' } }) }, store, view,
    { pause: 0, toUnity: (type, data) => { unity.push({ type, data }); return true; }, fetcher: async (url, init) => {
      if (url.includes('/routes/')) return Response.json({ points: [] });
      sent.push(JSON.parse(String(init?.body))); return Response.json({ messages: [{ id: 'sent' }] });
    } });
  const reports = agent.reports;
  return { store, view, agent, sent, unity, reports };
}
describe('staff crowd observations', () => {
  it.each(['e prea multă lume la securitate', 'crowded at security', 'too many people at security'])('classifies location wording as crowd: %s', text => {
    expect(classifyIssue(text)).toBe('aglomerare');
  });
  it.each(['bătaie la securitate, aglomerație', 'cineva a leșinat în aglomerație', 'bagaj abandonat la securitate'])('keeps explicit threats and medical reports above crowd: %s', text => {
    expect(classifyIssue(text)).not.toBe('aglomerare');
  });
  it('accepts the inclusive 15-minute boundary, excluding expired, future, closed and passenger reports', async () => {
    const h = setup(), now = Date.now();
    const r = await h.reports.add({ kind: 'aglomerare', type: 'crowd', node: 'U_SECURITY_QUEUE', text: 'Prea multă lume' }, now - 15 * 60_000, false);
    expect(crowdNote([r], 'security', 'ro', now)).toBe(note);
    expect(crowdNote([r], 'security', 'ro', now + 1)).toBeUndefined();
    expect(crowdNote([r], 'gate_3', 'ro', now)).toBeUndefined();
    expect(crowdNote([{ ...r, at: new Date(now + 1).toISOString() }], 'security', 'ro', now)).toBeUndefined();
    expect(crowdNote([{ ...r, source: 'passenger' }], 'security', 'ro', now)).toBeUndefined();
    expect(crowdNote([{ ...r, status: 'closed', state: 'resolved' }], 'security', 'ro', now)).toBeUndefined();
    expect(crowdNote([r], 'security', 'en', now)).toBe('Staff report crowding at security.');
  });
  it('confirms WhatsApp crowd reports briefly, using a stated landmark or assigned zone and no capacity commands', async () => {
    const h = setup(), phone = '+40711111111';
    await h.store.put(`wa:profile:${phone}`, { phone, role: 'staff' });
    const receive = (text: string) => h.agent.receive({ phone, id: crypto.randomUUID(), name: '', type: 'text', text, replyId: null, at: Date.now() });
    await receive('e prea multă lume la securitate');
    expect(await h.reports.list()).toMatchObject([{ type: 'crowd', kind: 'aglomerare', node: 'security', priority: 'P2', source: 'staff' }]);
    expect(h.sent.filter(m => m.type === 'text').map(m => m.text.body)).toEqual(['Am transmis. Dispeceratul decide.']);
    await receive('prea multă lume aici');
    expect((await h.reports.list())[1]).toMatchObject({ type: 'crowd', node: 'gate_3' });
    expect(h.unity).toEqual([]);
  });
  it('shares recent observations across queue answers, arrival answers, passenger tiles and automatic updates after restart', async () => {
    const h = setup(), phone = '+40712345678';
    await h.store.put(`wa:profile:${phone}`, { phone, role: 'passenger', flight: 'W6 3751' });
    await h.store.put(`wa:last:${phone}`, Date.now());
    const r = await h.reports.add({ kind: 'aglomerare', type: 'crowd', node: 'security', text: 'Prea multă lume' }, Date.now(), false);
    const p = { phone, role: 'passenger' as const, flight: 'W6 3751' };
    const tools = toolsFor({ view: h.view, profile: () => p, save: async () => {}, reports: () => new Reports(h.store).list() });
    expect((await fallbackReply('e lume la securitate?', tools)).join(' ')).toContain(note);
    expect((await fallbackReply('când să vin?', tools)).join(' ')).toContain(note);
    const restarted = new WhatsAppAgent({}, h.store, h.view, { toUnity: () => true });
    expect((await restarted.messaging.passenger('', phone))!.queues!.find(q => q.zone === 'security')!.staffCrowd).toBe(note);
    await h.agent.messaging.arrive({ channel: 'whatsapp', phone }, PROVISIONAL_FLIGHTS[0]!, undefined, true);
    expect(h.sent.filter(m => m.type === 'text').map(m => m.text.body).join(' ')).toContain(note);
    await h.reports.close(r.id);
    expect((await restarted.messaging.passenger('', phone))!.queues!.find(q => q.zone === 'security')!.staffCrowd).toBeUndefined();
    expect((await fallbackReply('e lume la securitate?', tools)).join(' ')).not.toContain(note);
  });
  it('drops stale observations from passenger pages and answers even while the report remains open', async () => {
    const h = setup(), phone = '+40712345678';
    await h.store.put(`wa:profile:${phone}`, { phone, role: 'passenger', flight: 'W6 3751' });
    await h.reports.add({ kind: 'aglomerare', type: 'crowd', node: 'security', text: 'Crowd' }, Date.now() - 900_001, false);
    const tools = toolsFor({ view: h.view, profile: () => ({ phone, role: 'passenger', flight: 'W6 3751' }), save: async () => {}, reports: () => h.reports.list() });
    expect((await fallbackReply('e lume la securitate?', tools)).join(' ')).not.toContain(note);
    expect((await h.agent.messaging.passenger('', phone))!.queues!.find(q => q.zone === 'security')!.staffCrowd).toBeUndefined();
  });
  it('shares observations in simulated updates and gate tiles without inventing waits', async () => {
    const h = setup(), sub = { channel: 'sim' as const, agentId: 'crowd-agent', role: 'passenger', flight: 'W6 3751' };
    await h.reports.add({ kind: 'aglomerare', type: 'crowd', node: 'gate_2', text: 'Crowd at gate' }, Date.now(), false);
    await h.agent.messaging.registerSims([sub]);
    const text = h.unity.filter(m => m.type === 'agent.message').map(m => m.data.text).join(' ');
    expect(text).toContain('Personalul semnalează aglomerație la poarta 2.');
    const token = (await h.agent.messaging.pageLink(sub)).split('/').at(-1)!;
    expect((await h.agent.messaging.passenger(token))!.gateCrowd).toBe('Personalul semnalează aglomerație la poarta 2.');
    const tools = toolsFor({ view: h.view, profile: () => ({ phone: '+40712345678', role: 'passenger', flight: 'W6 3751' }), save: async () => {}, reports: () => h.reports.list() });
    expect((await fallbackReply('cum e la poartă?', tools)).join(' ')).toContain('Personalul semnalează aglomerație la poarta 2.');
  });
  it('mentions staff observations even when camera waits are unavailable', async () => {
    const h = setup();
    await h.reports.add({ kind: 'aglomerare', type: 'crowd', node: 'security', text: 'Crowd' }, Date.now(), false);
    const tools = toolsFor({ view: { ...h.view, flow: () => ({}) }, profile: () => ({ phone: '+40712345678', role: 'passenger' }), save: async () => {}, reports: () => h.reports.list() });
    const result = (await fallbackReply('coadă la securitate?', tools)).join(' ');
    expect(result).toContain(note);
    expect(result).not.toMatch(/\d+ min/);
  });

});

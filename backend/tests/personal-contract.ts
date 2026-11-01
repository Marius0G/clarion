import { describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { personalRoute } from '../src/personal-routes.js';
import { SimStore, opsWire } from '../src/sim.js';
import { airportView } from '../../worker/src/wa/tower.js';
import { Reports, REPORT_TYPES, kindForType } from '../../worker/src/wa/reports.js';
import { WhatsAppAgent, type WaStore } from '../../worker/src/wa/index.js';
import index from '../../app/public/routes/index.json' with { type: 'json' };
export class MemoryStore implements WaStore {
  rows = new Map<string, unknown>();
  async get<T>(key: string) { const v = this.rows.get(key); return v === undefined ? undefined : structuredClone(v) as T; }
  async put(key: string, value: unknown) { this.rows.set(key, structuredClone(value)); }
  async delete(key: string) { return this.rows.delete(key); }
}
function setup() {
  const store = new MemoryStore(), sim = new SimStore(), sends: any[] = [];
  sim.status({ running: true, scenario: 'rush', arm: 'B', coverage: 1, seed: 1, simTime: 7 * 3600, speed: 10, agents: 0 });
  const view = airportView(sim, () => true);
  const agent = new WhatsAppAgent({ APP_URL: 'https://app.example', WA_TOKEN: 't', WA_PHONE_NUMBER_ID: 'PN' }, store, view, {
    pause: 0, reportsChanged: rows => sim.reports(rows), fetcher: async (url, init) => {
      if (String(url).includes('/routes/index.json')) return Response.json(index);
      sends.push(JSON.parse(String(init?.body ?? '{}'))); return Response.json({ messages: [{ id: 'out' }] });
    },
  });
  const env: { STAFF_ASSIGNMENTS?: string } = {};
  const call = (path: string, session?: string, body?: unknown, operator = false) => personalRoute(new Request(`https://api.example${path}`, {
    headers: session ? { Authorization: `Bearer ${session}` } : {}, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { store, sim, view, agent, env, operator });
  const input = { type: 'medical', place: { node: 'gate_2', name: 'Poarta 2' }, text: 'O persoană a leșinat' };
  async function login(phone = '+40712345678', profile = {}) {
    await store.put(`wa:profile:${phone}`, { phone, role: 'passenger', flight: 'W6 3751', ...profile });
    await store.put(`wa:last:${phone}`, Date.now());
    return (await new Auth(store).createSession(phone)).session;
  }
  return { store, sim, sends, agent, call, input, login, env };
}
export function personalContract() {
  describe('shared D33/D34 contract', () => {
    it.each(REPORT_TYPES)('assigns backend priority for %s for either source', async type => {
      const store = new MemoryStore(), reports = new Reports(store);
      const result = await reports.add({ type, kind: kindForType(type), node: 'gate_2', text: 'Incident', source: 'passenger', phone: '+40712345678' }, 1000);
      expect(result).toMatchObject({ type, priority: ['security', 'medical'].includes(type) ? 'P1' : type === 'crowd' ? 'P2' : 'P3', state: 'sent', source: 'passenger', timestamps: { sent: new Date(1000).toISOString() } });
    });
    it('serializes ids, survives reconstruction and allows only forward timestamped transitions', async () => {
      const store = new MemoryStore(), notifications: string[] = [], reports = new Reports(store, undefined, async r => { notifications.push(r.state); });
      const input = { kind: 'medical' as const, node: 'gate_2', text: 'Incident' };
      const [a, b] = await Promise.all([reports.add(input), reports.add(input)]);
      expect(a.id).not.toBe(b.id);
      await expect(reports.transition(a.id, 'resolved')).rejects.toThrow('Invalid report transition');
      for (const state of ['taken', 'en_route', 'resolved'] as const) await reports.transition(a.id, state, 2000);
      await reports.transition(a.id, 'resolved', 3000);
      expect(notifications).toEqual(['sent', 'sent', 'taken', 'en_route', 'resolved']);
      const saved = (await new Reports(store).list())[0]!;
      expect(saved).toMatchObject({ state: 'resolved', status: 'closed', timestamps: { taken: new Date(2000).toISOString(), en_route: new Date(2000).toISOString(), resolved: new Date(2000).toISOString() } });
      await expect(reports.transition(a.id, 'taken')).rejects.toThrow();
    });
    it('rejects missing session and passenger access to staff reads and mutations', async () => {
      const h = setup(), session = await h.login();
      expect((await h.call('/api/me'))?.status).toBe(401);
      expect((await h.call('/api/reports', undefined, h.input))?.status).toBe(401);
      expect((await h.call('/api/staff'))?.status).toBe(401);
      expect((await h.call('/api/staff', session))?.status).toBe(403);
      expect((await h.call('/api/staff/tasks/no/confirm', session, {}))?.status).toBe(403);
    });
    it('shares web reports, journal alerts, reporter ownership, WhatsApp notifications and timeline', async () => {
      const h = setup(), session = await h.login(), other = await h.login('+40711111111');
      const response = await h.call('/api/reports', session, { ...h.input, source: 'staff', phone: '+40711111111', priority: 'P3' });
      expect(response?.status).toBe(201);
      const r = await response!.json() as any;
      expect(r).toMatchObject({ phone: '+40712345678', source: 'passenger', priority: 'P1', state: 'sent' });
      expect(r.etaMin).toBeGreaterThanOrEqual(0);
      expect(h.sim.reportSnapshot()).toHaveLength(1);
      expect(h.sim.alertSnapshot().some(a => a.active && a.priority === 'P1')).toBe(true);
      expect((await (await h.call('/api/me', other))!.json() as any).reports).toEqual([]);
      expect((await h.call(`/api/reports/${r.id}/state`, session, { state: 'taken' }))?.status).toBe(401);
      for (const state of ['taken', 'en_route', 'resolved']) expect((await h.call(`/api/reports/${r.id}/state`, undefined, { state }, true))?.status).toBe(200);
      const data = await (await h.call('/api/me', session))!.json() as any;
      expect(data.reports[0].state).toBe('resolved');
      expect(data.timeline.map((a: any) => a.text).join(' ')).toMatch(/Trimis.*Preluat.*Echipa pe drum.*Rezolvat/);
      expect(h.sends.filter(m => m.type === 'text')).toHaveLength(4);
    });
    it('validates graph places, type, text and photo before storing', async () => {
      const h = setup(), session = await h.login();
      for (const patch of [{ type: 'invalid' }, { text: null }, { text: 'x'.repeat(501) }, { place: { node: 'unknown', name: 'x' } }, { photo: 'javascript:evil' }]) {
        expect((await h.call('/api/reports', session, { ...h.input, ...patch }))?.status).toBe(400);
      }
      expect(await h.agent.reports.list()).toEqual([]);
    });
    it('accepts optional details while preserving type, place and priority', async () => {
      const h = setup(), session = await h.login();
      const response = await h.call('/api/reports', session, { ...h.input, text: '' });
      expect(response?.status).toBe(201);
      expect(await response!.json()).toMatchObject({ type: 'medical', text: '', priority: 'P1', place: h.input.place });
    });
    it('returns the staff profile language', async () => {
      const h = setup(), session = await h.login('+40711111111', { role: 'staff', lang: 'en' });
      expect(await (await h.call('/api/staff', session))!.json()).toMatchObject({ lang: 'en' });
    });
    it('assigns tasks by executor and zone, validates completion, and updates console records without changing Unity wire', async () => {
      const h = setup(), staff = await h.login('+40711111111', { role: 'staff' });
      const lane = h.sim.sent({ type: 'staff', zone: 'security', delta: 1 });
      h.sim.sent({ type: 'redirect', from: 'security', to: 'entrance' });
      h.sim.sent({ type: 'staff', zone: 'check_in:2', delta: 1 });
      let data = await (await h.call('/api/staff', staff))!.json() as any;
      expect(data.tasks.map((t: any) => t.id)).toEqual([lane.id]);
      expect((await h.call(`/api/staff/tasks/${lane.id}/done`, staff, {}))?.status).toBe(400);
      expect((await h.call(`/api/staff/tasks/${lane.id}/confirm`, staff, {}))?.status).toBe(200);
      expect((await h.call(`/api/staff/tasks/${lane.id}/done`, staff, {}))?.status).toBe(200);
      data = await (await h.call('/api/staff', staff))!.json() as any;
      expect(data.tasks[0]).toMatchObject({ staffState: 'done', status: 'sent' });
      expect(h.sim.snapshot(false, {}).ops.find(t => t.id === lane.id)!.staffState).toBe('done');
      expect(opsWire(h.sim.snapshot(false, {}).ops.find(t => t.id === lane.id)!)).toEqual({ type: 'staff', zone: 'security', delta: 1, id: lane.id });
    });
    it.each([['hall_agent', 'redirect'], ['incident_commander', 'evacuate']] as const)('assigns %s its own tasks and only local alerts', async (role, type) => {
      const h = setup(), session = await h.login('+40711111111', { role: 'staff', staffRole: role, zone: 'security' });
      const redirect = h.sim.sent({ type: 'redirect', from: 'security', to: 'entrance' });
      const evac = h.sim.sent({ type: 'evacuate', zones: ['gate_2'] });
      h.sim.flow({ zones: [{ zone: 'security', waiting: 40, waitMin: 20, coverage: 1 }, { zone: 'check_in:2', waiting: 40, waitMin: 20, coverage: 1 }] }, 'vision');
      const data = await (await h.call('/api/staff', session))!.json() as any;
      expect(data.tasks.map((t: any) => t.id)).toEqual([type === 'redirect' ? redirect.id : evac.id]);
      expect(data.alerts.length).toBeGreaterThan(0);
      expect(data.alerts.every((a: any) => a.zoneId === 'security')).toBe(true);
      expect((await h.call(`/api/staff/tasks/${type === 'redirect' ? evac.id : redirect.id}/confirm`, session, {}))?.status).toBe(404);
    });
    it('uses only exit imagery and the assembly point during evacuation', async () => {
      const h = setup(), session = await h.login();
      await h.agent.messaging.plan({ id: 'E1', blocked: ['security'], clearSec: 30,
        exits: [{ exit: 'door_emergency_east', people: 1, clearSec: 30 }],
        routes: [{ from: 'G_CHECKIN_DESKS', exit: 'door_emergency_east', nodes: ['G_CHECKIN_DESKS', 'G_CAFE', 'door_emergency_east'], assembly: 'ASSEMBLY_LANDSIDE_EAST' }] });
      const data = await (await h.call('/api/me', session))!.json() as any;
      expect(data.evacuation.active).toBe(true);
      expect(data.routeImage).toMatch(/\/routes\/evac\/G_CHECKIN_DESKS.png$/);
      expect(data.assembly).toBe('ASSEMBLY_LANDSIDE_EAST');
    });
    it('uses server-configured staff assignments and accepts an optional report photo', async () => {
      const h = setup(), phone = '+40711111111', session = await h.login(phone, { role: 'staff' });
      h.env.STAFF_ASSIGNMENTS = JSON.stringify({ [phone]: { role: 'hall_agent', zone: 'G_CENTER' } });
      const task = h.sim.sent({ type: 'redirect', from: 'G_CENTER', to: 'entrance' });
      const data = await (await h.call('/api/staff', session))!.json() as any;
      expect(data.tasks[0].id).toBe(task.id);
      const response = await h.call('/api/reports', session, { ...h.input, photo: 'https://photos.example/incident.jpg' });
      expect(await response!.json()).toMatchObject({ source: 'staff', phone, photo: 'https://photos.example/incident.jpg' });
    });
    it('keeps legacy token reads, selects a real route image and caps only delivered timeline entries', async () => {
      const h = setup(); await h.login();
      const phone = '+40712345678', sub = { channel: 'whatsapp' as const, phone };
      const token = (await h.agent.messaging.pageLink(sub)).split('/').at(-1)!;
      for (let i = 0; i < 53; i++) await h.agent.messaging.notify(sub, { kind: 'flight', text: `Schimbare ${i}`, requested: true });
      const data = await (await h.call(`/api/me?token=${token}`))!.json() as any;
      expect(data.timeline).toHaveLength(50); expect(data.timeline[0].text).toBe('Schimbare 3');
      expect(data.routeImage).toMatch(/\/routes\/door_departures__U_GATE_2.png$/);
      await h.store.delete(`wa:last:${phone}`);
      await h.agent.messaging.notify(sub, { kind: 'flight', text: 'Outside window' });
      expect((await h.agent.messaging.passenger(token))!.timeline!.at(-1)!.text).toBe('Schimbare 52');
    });
    it('asks for missing fields with buttons and submits passenger free-text problems once', async () => {
      const h = setup(); await h.login();
      let i = 0;
      const receive = (text: string, replyId: string | null = null) => h.agent.receive({ id: `r${++i}`, phone: '+40712345678', name: '', type: 'text', text, replyId, at: Date.now() });
      await receive('raportează');
      expect(h.sends.filter(m => m.interactive?.type === 'button')).toHaveLength(2);
      await receive('Medical', 'rep:type:medical');
      expect(await h.agent.reports.list()).toHaveLength(0);
      await receive('Intrare', 'rep:loc:door_departures');
      await receive('O persoană a leșinat');
      expect(await h.agent.reports.list()).toMatchObject([{ source: 'passenger', type: 'medical', node: 'door_departures' }]);
      await receive('Este murdar la poarta 2');
      expect(await h.agent.reports.list()).toHaveLength(2);
    });
  });
}

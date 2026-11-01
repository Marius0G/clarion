import { describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { consumeChatTicket, personalRoute } from '../src/personal-routes.js';
import { MemoryStore } from './personal-contract.js';
import { WhatsAppAgent } from '../../worker/src/wa/index.js';
import { airportView } from '../../worker/src/wa/tower.js';
import { SimStore } from '../src/sim.js';

export function ticketContract() {
  describe('chat tickets', () => {
    it('keeps redacted alert ids across replay and emits reports even when WhatsApp confirmation is suppressed', async () => {
      const store = new MemoryStore(), sim = new SimStore(), view = airportView(sim, () => false), events: { phone: string; event: any }[] = [];
      const phone = '+40712345678';
      const agent = new WhatsAppAgent({}, store, view, { pause: 0, personEvent: (phone, event) => events.push({ phone, event }) });
      await store.put(`wa:last:${phone}`, Date.now());
      await store.put(`wa:profile:${phone}`, { phone, role: 'staff' });
      for (const kind of ['flight', 'evacuate'] as const) {
        await agent.messaging.notify({ channel: 'whatsapp', phone }, { kind, text: '4111111111111111', requested: true });
      }
      const emitted = events.filter(e => e.event.type === 'chat');
      expect(emitted).toHaveLength(2);
      expect(emitted.every(e => e.phone === phone && e.event.entry.text === '[număr de card eliminat]')).toBe(true);
      const history = await agent.chatHistory(phone);
      expect(history.map(e => e.id)).toEqual(emitted.map(e => e.event.entry.id));
      await store.put(`wa:profile:${phone}`, { phone, role: 'staff', pageToken: '12345678-abcd-4abc-abcd-123456789abc' });
      const link = 'https://clarion-craiova.pages.dev/m/12345678-abcd-4abc-abcd-123456789abc';
      await agent.messaging.notify({ channel: 'whatsapp', phone }, { kind: 'admin', text: link + ' 4111111111111111', requested: true });
      expect(events.at(-1)!.event.entry.text).toBe(link + ' [număr de card eliminat]');
      expect((await agent.chatHistory(phone)).at(-1)!.text).toBe(link + ' [număr de card eliminat]');
      const report = await agent.reports.add({ kind: 'medical', node: 'gate_2', text: 'Incident', phone, source: 'staff' }, Date.now(), false);
      expect(events.filter(e => e.event.type === 'report')).toMatchObject([{ phone, event: { type: 'report', report: { id: report.id, state: 'sent' } } }]);
      await store.put(`wa:ctx:${phone}`, { history: [{ role: 'user', text: 'Salut', at: '08:00' }] });
      const a = await agent.chatHistory(phone), b = await agent.chatHistory(phone);
      expect(a).toEqual(b);
      expect(a.find(e => e.text === 'Salut')!.id).toMatch(/^legacy:/);
    });

    it('requires D3, binds staff role, consumes atomically, rejects expiry, reuse, revocation and role changes', async () => {
      const store = new MemoryStore(), sim = new SimStore(), view = airportView(sim, () => false);
      const agent = new WhatsAppAgent({}, store, view);
      const phone = '+40711111111', env = { STAFF_PHONES: phone };
      const session = (await new Auth(store).createSession(phone)).session;
      const issue = (token?: string) => personalRoute(new Request('https://example/api/chat/ticket', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} }), { store, agent, sim, view, env, operator: false });
      expect((await issue())!.status).toBe(401);
      const issued = await (await issue(session))!.json() as any;
      expect(issued.expiresIn).toBe(60);
      const consumed = await Promise.all([consumeChatTicket(store, issued.ticket, env), consumeChatTicket(store, issued.ticket, env)]);
      expect(consumed.filter(Boolean)).toEqual([{ phone, role: 'staff', session }]);
      expect(await consumeChatTicket(store, issued.ticket, env)).toBeNull();
      expect(await consumeChatTicket(store, 'invalid', env)).toBeNull();
      const expired = await (await issue(session))!.json() as any;
      const key = `chat:ticket:${expired.ticket}`;
      const value = await store.get<any>(key);
      expect(value.expiresAt - Date.now()).toBeGreaterThan(59_000);
      await store.put(key, { ...value, expiresAt: Date.now() });
      expect(await consumeChatTicket(store, expired.ticket, env)).toBeNull();
      const changed = await (await issue(session))!.json() as any;
      expect(await consumeChatTicket(store, changed.ticket, {})).toBeNull();
      const revoked = await (await issue(session))!.json() as any;
      await new Auth(store).endSession(session);
      expect(await consumeChatTicket(store, revoked.ticket, env)).toBeNull();
    });
  });
}
export interface Peer { events: any[]; send(value: unknown): void; close(): void; closed: Promise<number> }
export interface ChatHarness {
  post(path: string, body: unknown, session?: string): Promise<{ status: number; json(): Promise<any> }>;
  get(path: string, session: string): Promise<any>;
  open(ticket: string): Promise<Peer>;
  webhook(text: string, phone: string): Promise<void>;
  hibernate?(): Promise<void>;
}
export function socketContract(harness: () => ChatHarness) {
  describe('personal WebSocket transport', () => {
    it('fans out WhatsApp and web turns, replays stable ids, isolates phones, pushes reports/alerts and shares rate limits', async () => {
      const h = harness();
      async function login(phone: string) {
        const pending = await (await h.post('/api/auth/login-code', {})).json();
        await h.webhook(`LOGIN ${pending.code}`, phone);
        let result: any;
        await expect.poll(async () => { result = await h.get(`/api/auth/login-code/${pending.pollToken}`, ''); return result.status; }).toBe('ok');
        return result.session as string;
      }
      const phone = '40712345678';
      const session = await login(phone), otherSession = await login('40722222222');
      const issue = async (sid = session) => (await (await h.post('/api/chat/ticket', {}, sid)).json()).ticket;
      expect((await h.post('/api/chat/ticket', {})).status).toBe(401);
      const ticket = await issue();
      const a = await h.open(ticket), b = await h.open(await issue()), other = await h.open(await issue(otherSession));
      expect(await (await h.open(ticket)).closed).toBe(4401);
      expect(await (await h.open('invalid')).closed).toBe(4401);
      await expect.poll(() => a.events.some(e => e.type === 'history')).toBe(true);
      expect(a.events[0]).toEqual({ type: 'history', entries: [] });
      a.send({ type: 'ping' });
      await expect.poll(() => a.events.some(e => e.type === 'pong')).toBe(true);
      await h.webhook('romana', phone);
      await expect.poll(() => a.events.filter(e => e.type === 'chat').length).toBe(2);
      await expect.poll(() => b.events.filter(e => e.type === 'chat').length).toBe(2);
      expect(a.events.filter(e => e.type === 'chat')).toEqual(b.events.filter(e => e.type === 'chat'));
      expect(a.events.filter(e => e.type === 'chat').map(e => e.entry)).toMatchObject([{ role: 'user', channel: 'whatsapp', text: 'romana' }, { role: 'clarion', channel: 'whatsapp' }]);
      expect(a.events.filter(e => e.type === 'typing')).toEqual([{ type: 'typing', on: true }, { type: 'typing', on: false }]);
      await h.hibernate?.();
      a.send({ type: 'chat', text: 'english' });
      await expect.poll(() => b.events.filter(e => e.type === 'chat').length).toBe(4);
      const history = await h.get('/api/chat', session);
      expect(history.history).toContainEqual(expect.objectContaining({ text: 'english', channel: 'web' }));
      const replay = await h.open(await issue());
      await expect.poll(() => replay.events.some(e => e.type === 'history')).toBe(true);
      expect(replay.events[0].entries.map((e: any) => e.id)).toEqual(b.events.filter(e => e.type === 'chat').map(e => e.entry.id));
      expect(new Set(history.history.map((e: any) => e.id)).size).toBe(4);
      await h.webhook('romana', phone);
      await expect.poll(() => b.events.filter(e => e.type === 'chat').length).toBe(6);
      const report = await (await h.post('/api/reports', { type: 'medical', place: { node: 'gate_2', name: 'Poarta 2' }, text: 'Incident' }, session)).json();
      await expect.poll(() => b.events.some(e => e.type === 'report' && e.report.id === report.id)).toBe(true);
      const before = b.events.filter(e => e.type === 'chat').length;
      expect((await h.post(`/api/reports/${report.id}/state`, { state: 'taken' })).status).toBe(200);
      await expect.poll(() => b.events.some(e => e.type === 'report' && e.report.state === 'taken')).toBe(true);
      await expect.poll(() => b.events.filter(e => e.type === 'chat').length).toBeGreaterThan(before);
      expect(b.events.some(e => e.type === 'chat' && /Preluat|Taken/i.test(e.entry.text))).toBe(true);
      expect(b.events.some(e => e.type === 'me')).toBe(true);
      expect(other.events.every(e => ['history', 'pong'].includes(e.type))).toBe(true);
      expect(a.events.some(e => e.type === 'state')).toBe(false);
      a.send({ type: 'chat', text: '' });
      await expect.poll(() => a.events.some(e => e.type === 'error' && e.status === 400)).toBe(true);
      // The web socket turn above used one of the HTTP session's twelve slots.
      for (let n = 0; n < 11; n++) expect((await h.post('/api/chat', { text: 'romana' }, session)).status).toBe(200);
      b.send({ type: 'chat', text: 'english' });
      await expect.poll(() => b.events.some(e => e.type === 'error' && e.status === 429 && e.retryAfter === 60)).toBe(true);
      expect((await h.post('/api/chat', { text: 'romana' }, session)).status).toBe(429);
      await h.post('/api/auth/logout', {}, session);
      a.send({ type: 'chat', text: 'english' });
      expect(await a.closed).toBe(4401);
      for (const p of [b, other, replay]) p.close();
    }, 30000);
  });
}

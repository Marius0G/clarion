import { describe, expect, it } from 'vitest';
import { Auth } from '../../backend/src/auth.js';
import { personalRoute, CHAT_PER_MINUTE } from '../../backend/src/personal-routes.js';
import { SimStore } from '../../backend/src/sim.js';
import { airportView } from '../../worker/src/wa/tower.js';
import { WhatsAppAgent } from '../../worker/src/wa/index.js';
import { MemoryStore } from '../../backend/tests/personal-contract.js';
import index from '../../app/public/routes/index.json' with { type: 'json' };
// Keep the worker contract local: route origins must come from the passenger.
function chatContract() {
  describe('shared web and WhatsApp conversation', () => {
    function setup() {
      const store = new MemoryStore(), sim = new SimStore(), calls: any[] = [], sends: any[] = [], events: any[] = [];
      const view = airportView(sim, () => true), env = { STAFF_PHONES: '', ANTHROPIC_API_KEY: 'test', WA_TOKEN: 'test', WA_PHONE_NUMBER_ID: 'PN', APP_URL: 'https://app.example' };
      let tool = 'queues', input = {};
      const agent = new WhatsAppAgent(env, store, view, { pause: 0, personEvent: (phone, event) => events.push({ phone, event }), fetcher: async (url, init) => {
        if (url.includes('/routes/index.json')) return Response.json(index);
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (url.includes('anthropic')) {
          calls.push(body);
          if (body.messages.at(-1)?.content?.[0]?.type === 'tool_result') return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Situația din terminal.' }] });
          return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-1', name: tool, input }] });
        }
        sends.push(body); return Response.json({ messages: [{ id: 'sent' }] });
      } });
      async function login(phone = '+40712345678', role = 'passenger') {
        await store.put(`wa:profile:${phone}`, { phone, role, lang: 'ro', flight: 'W6 3751' });
        return (await new Auth(store).createSession(phone)).session;
      }
      const request = (session?: string, body?: unknown) => personalRoute(new Request('https://api.example/api/chat', {
        method: body === undefined ? 'GET' : 'POST', headers: session ? { Authorization: `Bearer ${session}` } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { store, sim, view, env, agent, operator: false });
      return { store, sim, agent, calls, sends, events, login, request, choose: (name: string, args = {}) => { tool = name; input = args; } };
    }
    it('shares the exact prompt, tools, answer path and per-phone history in both directions', async () => {
      const h = setup(), session = await h.login(), phone = '+40712345678';
      await h.agent.receive({ id: 'wa-1', phone, name: '', type: 'text', text: 'Cozi?', replyId: null, at: Date.now() });
      expect((await (await h.request(session))!.json() as any).history).toContainEqual(expect.objectContaining({ text: 'Cozi?', channel: 'whatsapp' }));
      const outgoing = h.sends.length;
      const response = await h.request(session, { text: 'Securitate?' });
      expect(response!.status).toBe(200);
      expect((await response!.json() as any).bubbles).toMatchObject([{ role: 'clarion', text: 'Situația din terminal.', channel: 'web' }]);
      expect(h.calls[0].system[0]).toEqual(h.calls[2].system[0]);
      expect(h.calls[2].system[1].text).toContain('Recent lookups');
      expect(h.calls[0].tools).toEqual(h.calls[2].tools);
      expect(h.calls[3].messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tool-1' });
      expect(h.sends).toHaveLength(outgoing);
      expect((await h.store.get<any>(`wa:ctx:${phone}`)).history).toContainEqual(expect.objectContaining({ channel: 'web', text: 'Securitate?' }));
      await h.agent.receive({ id: 'wa-2', phone, name: '', type: 'text', text: 'Coada acum?', replyId: null, at: Date.now() });
      expect(JSON.stringify(h.calls[4].messages)).toContain('Securitate?');
      await h.agent.messaging.notify({ channel: 'whatsapp', phone }, { kind: 'flight', text: 'Poarta 4', requested: true });
      expect((await (await h.request(session))!.json() as any).history).toContainEqual(expect.objectContaining({ text: 'Poarta 4', channel: 'whatsapp' }));
    });
    it.each(['open', 'expired', 'missing'] as const)('confirms a web chat report once only in an open WhatsApp window (%s)', async window => {
      const h = setup(), session = await h.login(), phone = '+40712345678';
      const last = window === 'open' ? Date.now() : Date.now() - 24 * 60 * 60_000;
      if (window !== 'missing') await h.store.put(`wa:last:${phone}`, last);
      const text = 'Raportează: prea aglomerat la securitate';
      expect((await h.request(session, { text }))!.status).toBe(200);
      const messages = h.sends.filter(m => m.type === 'text');
      expect(h.sends).toHaveLength(window === 'open' ? 1 : 0);
      if (window === 'open') expect(messages).toMatchObject([{ to: '40712345678', text: { body: 'Raportul tău de pe site a fost trimis: Aglomerație · Securitate. Te anunț când echipa îl preia.' } }]);
      expect(await h.store.get(`wa:last:${phone}`)).toBe(window === 'missing' ? undefined : last);
      expect(await h.agent.reports.own(phone)).toHaveLength(1);
      expect(h.events).toContainEqual(expect.objectContaining({ phone, event: { type: 'chat', entry: expect.objectContaining({ role: 'user', text, channel: 'web' }) } }));
      expect((await h.agent.chatHistory(phone))).toContainEqual(expect.objectContaining({ role: 'user', text, channel: 'web' }));
    });
    it('confirms tool-filed web reports once and keeps plain web questions as shared context only', async () => {
      const h = setup(), session = await h.login(), phone = '+40712345678';
      await h.store.put(`wa:last:${phone}`, Date.now());
      await h.request(session, { text: 'Unde este securitatea?' });
      expect(h.sends).toHaveLength(0);
      h.choose('reportLostItem', { text: 'Am pierdut telefonul la securitate' });
      await h.request(session, { text: 'Ajută-mă cu obiectul' });
      expect(await h.agent.reports.own(phone)).toHaveLength(1);
      expect(h.sends).toHaveLength(1);
      expect(h.sends[0]).toMatchObject({ type: 'text', text: { body: 'Raportul tău de pe site a fost trimis: Obiect pierdut · Securitate. Te anunț când echipa îl preia.' } });
    });
    it('exposes no task tools to either role and rejects forged calls and web role promotion', async () => {
      const h = setup(), passenger = await h.login(), staff = await h.login('+40711111111', 'staff');
      const task = h.sim.sent({ type: 'staff', zone: 'security', delta: 1 });
      h.choose('staffTasks', { id: task.id, action: 'confirm' });
      await h.request(passenger, { text: 'Sarcini?' });
      expect(h.calls[0].tools.some((t: any) => t.name === 'staffTasks')).toBe(false);
      expect(h.calls[1].messages.at(-1).content[0]).toMatchObject({ is_error: true, content: 'Unknown tool: staffTasks' });
      expect(h.sim.snapshot(false, {}).ops[0]!.staffState).toBeUndefined();
      await h.request(passenger, { text: 'STAFF CRAIOVA2026' });
      expect((await h.agent.profile('+40712345678'))?.role).toBe('passenger');
      await h.request(staff, { text: 'Sarcini?' });
      expect(h.calls.at(-2).tools.some((t: any) => t.name === 'staffTasks')).toBe(false);
      expect(h.sim.snapshot(false, {}).ops[0]!.staffState).toBeUndefined();
    });
    it('returns chips and route PNGs, persists intermediate turns and avoids WhatsApp sends', async () => {
      const h = setup(), session = await h.login();
      let data = await (await h.request(session, { text: 'raportează' }))!.json() as any;
      expect(data.bubbles[0].buttons[0]).toMatchObject({ id: 'rep:type:security', title: 'Securitate' });
      data = await (await h.request(session, { text: 'Medical', replyId: 'rep:type:medical' }))!.json() as any;
      expect(data.bubbles[0].buttons[0].id).toMatch(/^rep:loc:/);
      expect(data.history.filter((e: any) => e.role === 'user')).toHaveLength(2);
      expect(h.sends).toHaveLength(0);
      const other = await h.login('+40711111111');
      h.choose('routeTo', { from: 'door_departures', to: 'gate' });
      const question = await (await h.request(other, { text: 'Traseu?' }))!.json() as any;
      expect(question.bubbles.some((b: any) => b.buttons?.some((row: any) => row.id === 'loc:other'))).toBe(true);
      expect(question.bubbles.some((b: any) => b.image)).toBe(false);
      const routed = await (await h.request(other, { text: 'Intrare plecări', replyId: 'loc:door_departures' }))!.json() as any;
      expect(routed.bubbles.some((b: any) => b.image?.endsWith('.png'))).toBe(true);
      expect(h.sends).toHaveLength(0);
    });
    it('requires D3, bounds messages, limits concurrent session turns and renews after one minute', async () => {
      const h = setup(), session = await h.login();
      expect((await h.request())!.status).toBe(401);
      for (const body of [{ text: '' }, { text: 42 }, { text: 'x'.repeat(2001) }, { text: 'ok', replyId: 42 }]) expect((await h.request(session, body))!.status).toBe(400);
      const responses = await Promise.all(Array.from({ length: CHAT_PER_MINUTE + 1 }, () => h.request(session, { text: 'ok' })));
      expect(responses.filter(r => r?.status === 200)).toHaveLength(CHAT_PER_MINUTE);
      expect(responses.filter(r => r?.status === 429)).toHaveLength(1);
      expect((await h.request(session))!.status).toBe(200);
      const second = (await new Auth(h.store).createSession('+40712345678')).session;
      expect((await h.request(second, { text: 'ok' }))!.status).toBe(200);
      await h.store.put(`chat:rate:${session}`, { start: Date.now() - 60_001, count: CHAT_PER_MINUTE });
      expect((await h.request(session, { text: 'ok' }))!.status).toBe(200);
    });
  });
}

chatContract();

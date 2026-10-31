import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The real Tower in workerd: signed webhook -> 200 at once -> agent turn in ctx.waitUntil -> Graph API calls.
let mf: Miniflare;
const outbound: { url: string; body: any }[] = [];
const claudeReplies: any[] = [];
beforeAll(() => {
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'wa', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    outboundService: async request => {
      const url = request.url;
      const body = request.method === 'POST' ? await request.json().catch(() => null) : null;
      outbound.push({ url, body });
      if (url.startsWith('https://api.anthropic.com')) return Response.json(claudeReplies.shift() ?? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Bine.' }] });
      if (url.startsWith('https://graph.facebook.com')) return Response.json({ messages: [{ id: 'wamid.out' }] });
      return Response.json([]);
    },
    bindings: { SIM_SPEED: '60', WHATSAPP_APP_SECRET: 'meta-secret', WHATSAPP_TOKEN: 'token', WHATSAPP_PHONE_NUMBER_ID: 'PN1', ANTHROPIC_API_KEY: 'key' },
  }));
});
afterAll(async () => { await mf.dispose(); });

function post(body: unknown) {
  const raw = JSON.stringify(body);
  return mf.dispatchFetch('https://worker.example/webhooks/whatsapp', {
    method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'meta-secret').update(raw).digest('hex') },
  });
}
const message = (id: string, text: string) => ({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: 'PN1' }, messages: [{ id, from: '40712345678', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
} }] }] });
const texts = () => outbound.filter(o => o.url.includes('graph.facebook.com') && o.body?.type === 'text').map(o => o.body.text.body as string);

describe('WhatsApp agent in the Tower', () => {
  it('binds START, answers through Claude, and answers a retried wamid once', async () => {
    const joined = await mf.dispatchFetch('https://worker.example/api/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flight: 'W6 3751' }),
    }).then(r => r.json()) as { token: string };
    expect((await post(message('wamid.a', `START W6 3751 ${joined.token}`))).status).toBe(200);
    await expect.poll(() => texts().some(t => t.includes('W6 3751 spre Londra Luton')), { timeout: 10000 }).toBe(true);
    expect(outbound.some(o => o.body?.type === 'interactive')).toBe(true);
    // The public endpoint and signed webhook share the same durable token store.
    expect((await mf.dispatchFetch('https://worker.example/api/wallet/pass', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ joinToken: joined.token }),
    })).status).toBe(400);

    claudeReplies.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fii la intrarea în terminal la 08:25.' }] });
    const q = message('wamid.b', 'cand sa vin?');
    expect((await post(q)).status).toBe(200);
    expect((await post(q)).status).toBe(200);
    await expect.poll(() => texts().filter(t => t === 'Fii la intrarea în terminal la 08:25.').length, { timeout: 10000 }).toBe(1);
    const claude = outbound.filter(o => o.url.startsWith('https://api.anthropic.com'));
    expect(claude).toHaveLength(1);
    expect(claude[0]!.body.system[1].text).toContain('Zbor: W6 3751');
    // Still one answer after the retry has had time to run.
    await new Promise(r => setTimeout(r, 1500));
    expect(texts().filter(t => t === 'Fii la intrarea în terminal la 08:25.')).toHaveLength(1);
  });
});

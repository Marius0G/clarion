import { Auth, bearer } from '../../backend/src/auth.js';
import { authRoute, type AuthEnv } from '../../backend/src/auth-routes.js';
import { allowed } from './wa/transport.js';
import { closeSocket } from './websocket-close.js';
import { runLab, validateInput, labPhone } from './wa/lab.js';
import { labPage } from './wa/labpage.js';
import { WaEvents } from './wa/events.js';
import { boardingFromSchedule } from './demo.js';
import { DurableObject } from 'cloudflare:workers';
import { createWhatsApp,verifyWhatsApp } from '../../backend/src/channels/whatsapp.js';
import { aircraftNearLrcv,FidsAdapter } from '../../backend/src/data/flights.js';
import { Engine } from '../../backend/src/engine.js';
import { agentRoute,opsCommand,opsWire,simCommand } from '../../backend/src/sim.js';
import type { Client,Envelope } from '../../backend/src/types.js';
import type { Wallet,WalletStore } from '../../backend/src/wallet.js';
import { createWallet,equalSecret,validWhatsAppSignature,type Secrets } from './channels.js';
import { createStoredEngine } from './storage.js';
import { WhatsAppAgent, type WaEnv } from './wa/index.js';
import { JoinTokens, JOIN_TTL_MS, joinKey, pendingJoin, waLink, type PendingJoin } from './join.js';
import { findFlight } from './wa/flights.js';
import { evacPlan, splitRegister } from './wa/messaging.js';
import { airportView } from './wa/tower.js';
import { CameraFeeds } from './cams.js';

export interface Env extends Secrets, WaEnv, AuthEnv {
  TOWER: DurableObjectNamespace<Tower>;
  DEMO_TOKEN?: string;
  WHATSAPP_NUMBER?: string;
  SIM_SPEED?: string; SIM_SEED?: string; AUTO_CONFIRM?: string;
}
const ALARM_SPACING_MS = 500;
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store' },
});
const packet = (type: string, data: unknown) => JSON.stringify({ type, ts: new Date().toISOString(), data });
function numeric(value: string | undefined, fallback: number, min: number, max = Infinity, integer = false) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    throw new Error('Invalid simulation configuration');
  return n;
}
function allowedOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return (url.protocol === 'https:' && url.hostname.endsWith('.pages.dev')) ||
      (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}
async function bodyText(request: Request, limit = 65536) {
  if (Number(request.headers.get('Content-Length')) > limit) throw new Error('Body exceeds limit');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('JSON body required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('Body exceeds limit'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    if (origin && !allowedOrigin(origin)) return json({ error: 'Origin not allowed' }, 403);
    const headers = new Headers({ 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Vary': 'Origin' });
    if (origin) headers.set('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    // All devices and transports coordinate through exactly one tower instance.
    const response = await env.TOWER.get(env.TOWER.idFromName('tower')).fetch(request);
    // Preserve the upgrade and its WebSocket when adding CORS headers.
    const result = new Response(response.body, response);
    headers.forEach((value, key) => result.headers.set(key, value));
    return result;
  },
} satisfies ExportedHandler<Env>;

export class Tower extends DurableObject<Env> {
  private engine!: Engine;
  private wallet!: Wallet;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Set<Promise<unknown>>();
  private seenWhatsApp: string[] = [];
  private whatsapp: WhatsAppAgent;
  private waEvents: WaEvents;
  // Invoke Workers' global fetch with its own receiver, not as an adapter method.
  private fids = new FidsAdapter((input, init) => fetch(input, init));
  private nextFidsRefresh = 0;
  private lastAlarm = 0;
  /** Latest camera.frame per camera (contract), in memory only. */
  private cams = new CameraFeeds();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.waEvents = new WaEvents(ctx.storage);
    this.whatsapp = new WhatsAppAgent(env, ctx.storage, airportView({ snapshot: (c, m) => this.engine.sim.snapshot(c, m) }, () => this.twins().length > 0),
      { toUnity: (type, data) => this.toTwins(type, data), observe: this.waEvents.record, reportsChanged: rows => this.engine.updateStaffReports(rows) });
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS engine_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
      const row = ctx.storage.sql.exec<{ value: string }>('SELECT value FROM engine_snapshot WHERE id = 1').toArray()[0];
      const saved = row ? JSON.parse(row.value) : undefined;
      this.wallet = createWallet(env, await ctx.storage.get<WalletStore>('wallet'),
        store => ctx.storage.put('wallet', store));
      this.seenWhatsApp = await ctx.storage.get<string[]>('whatsappIds') ?? [];
      this.engine = createStoredEngine(saved, store => {
        // SQLite writes are synchronous and participate in DO output gating.
        // Store JSON in SQL to avoid the KV API's smaller per-value limit.
        ctx.storage.sql.exec('INSERT INTO engine_snapshot (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', JSON.stringify(store));
      }, {
        emit: (type, data) => this.broadcast(type, data),
        adapters: {
          whatsapp: createWhatsApp({
            WHATSAPP_TOKEN: env.WHATSAPP_TOKEN ?? env.WA_TOKEN,
            WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID ?? env.WA_PHONE_NUMBER_ID,
          }),
        },
        simSpeed: numeric(env.SIM_SPEED, 60, 0.001), seed: env.SIM_SEED,
      });
      this.engine.updateStaffReports(await this.whatsapp.reports.list());
      await this.refreshFlights();
      this.engine.persist();
      // Never replace an existing alarm while waking for it.
      if (await ctx.storage.getAlarm() === null) await this.schedule();
    });
  }
  private background(work: Promise<unknown>) {
    this.pending.add(work);
    this.ctx.waitUntil(work.finally(() => this.pending.delete(work)));
  }
  private async reset() {
    const evacTimers = this.whatsapp.messaging.cancelPending();
    await Promise.allSettled([...this.pending]);
    const cleared = { ...await this.whatsapp.reset(), ...await new JoinTokens(this.ctx.storage).reset(),
      ...await this.wallet.reset(), ...this.engine.reset(), whatsappIds: this.seenWhatsApp.length, evacTimers };
    this.seenWhatsApp = [];
    await this.ctx.storage.delete('whatsappIds');
    this.toTwins('sim.command', { reset: true });
    return { ok: true, cleared };
  }
  private async refreshFlights() {
    const now = Date.now();
    const result = await this.fids.get(now);
    this.engine.updateFlights(result.flights, result.dataSource);
    this.nextFidsRefresh = now + 300000;
  }
  private async handle(event: Envelope, client: Client) {
    // Passenger messaging (SPEC-v2 D14, D17, A10) hooks in before and after the engine; see wa/messaging.ts.
    const msg = this.whatsapp.messaging;
    if (event?.type === 'evac.plan' && client !== 'viewer') { this.background(msg.plan(evacPlan(event.data))); return; }
    if (event?.type === 'agent.register' && client === 'twin') {
      const { sims, rest } = splitRegister(event.data);
      if (sims.length) this.background(msg.registerSims(sims));
      if (!rest) return;
      event = { ...event, data: rest };
    }
    await this.wallet.handle(this.engine, event, client);
    if (event.type === 'flow.report' && (client === 'vision' || client === 'twin')) this.background(msg.flowChanged());
    if (event.type === 'flight.update') this.background(msg.flightsChanged());
    // Reset rebuilds the fixture in the core. Restore the adapter's current
    // schedule immediately, without postponing the next polling deadline.
    if (event.type === 'console.reset') {
      const result = await this.fids.get();
      this.engine.updateFlights(result.flights, result.dataSource);
    }
  }
  private twins() { return this.ctx.getWebSockets('twin').filter(ws => ws.readyState === WebSocket.OPEN); }
  /** The camera service (D0). At most one: a new connection closes the previous one. */
  private visions() { return this.ctx.getWebSockets('vision').filter(ws => ws.readyState === WebSocket.OPEN); }
  /** Backend → Unity (ops.command, agent.route). False when Unity is not connected. */
  private toTwins(type: string, data: unknown) {
    const twins = this.twins();
    for (const ws of twins) ws.send(packet(type, data));
    return twins.length > 0;
  }
  private broadcast(type: string, data: unknown) {
    const value = packet(type, data);
    for (const ws of this.ctx.getWebSockets()) {
      if (type !== 'state' && ws.deserializeAttachment()?.client === 'viewer') continue;
      try { ws.send(value); } catch { /* Closed peer; runtime removes it. */ }
    }
  }
  private async schedule() {
    // One alarm multiplexes FIDS, seeded reads/actions and consent expiry.
    const due: number[] = [this.nextFidsRefresh, ...this.engine.subscriptions.map(s => Date.parse(s.expiresAt))];
    for (const r of this.engine.receipts) {
      if (!r.simulated) continue;
      if (!r.read && r.readAt) due.push(r.readAt);
      if (!r.acted && r.actAt) due.push(r.actAt);
    }
    const next = due.filter(Number.isFinite).reduce((a, b) => Math.min(a, b), Infinity);
    const current = await this.ctx.storage.getAlarm();
    if (next === Infinity) { if (current !== null) await this.ctx.storage.deleteAlarm(); return; }
    // SPEC §5.6: at most two persists/state broadcasts per second. Hundreds of
    // seeded reads fall due within seconds; coalesce them into one alarm per 500 ms.
    const at = Math.max(Date.now() + 1, this.lastAlarm + ALARM_SPACING_MS, Math.ceil(next));
    // Skip redundant alarm writes: every request and agent.batch reschedules.
    if (current !== at) await this.ctx.storage.setAlarm(at);
  }
  private ordered<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(async () => {
      try { return await this.engine.batch(work); }
      finally {
        await this.schedule();
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async alarm() {
    this.lastAlarm = Date.now();
    await this.ordered(async () => {
      this.engine.tick(); this.engine.expire();
      if (Date.now() >= this.nextFidsRefresh) await this.refreshFlights();
    });
  }
  /** Lab work must not hold the engine queue while waiting for model replies. */
  private async lab(request: Request, path: string): Promise<Response> {
    try {
      if (request.method === 'GET' && path === '/lab') return new Response(labPage(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      if (path.startsWith('/lab/')) {
        if (!this.env.DEMO_TOKEN || !await equalSecret(request.headers.get('Authorization'), `Bearer ${this.env.DEMO_TOKEN}`)) return json({ error: 'Operator token required' }, 401);
        if (request.method === 'GET' && path === '/lab/capabilities') return json({ e2e: 1, safeToMutate: !this.twins().length && !this.visions().length && !(await this.whatsapp.messaging.subscribers()).some(s => s.sub.channel !== 'whatsapp' || !labPhone(s.sub.phone)) && !this.engine.subscriptions.length });
        if (request.method === 'POST' && path === '/lab/alert-ready') {
          const { phone } = JSON.parse(await bodyText(request, 1024));
          if (!labPhone(phone) || !await this.whatsapp.profile(phone)) return json({ error: 'Expected a kept lab passenger' }, 400);
          // D22's 15-minute cooldown remains unchanged for real passengers.
          await this.ctx.storage.delete(`msg:last:wa:${phone}`);
          return json({ ok: true });
        }
        if (request.method === 'POST' && path === '/lab/cleanup') {
          const { phone } = JSON.parse(await bodyText(request, 1024));
          if (!labPhone(phone)) return json({ error: 'Expected lab-e2e-UUID' }, 400);
          const profile = await this.whatsapp.profile(phone);
          if (profile?.pageToken) await this.ctx.storage.delete(`page:${profile.pageToken}`);
          await this.whatsapp.messaging.removePhone(phone);
          for (const key of [`wa:profile:${phone}`, `wa:ctx:${phone}`, `wa:last:${phone}`, `lab:kept:${phone}`]) await this.ctx.storage.delete(key);
          return json({ ok: true });
        }
        if (request.method === 'GET' && path === '/lab/events') return json({ events: await this.waEvents.list() });
        if (request.method === 'POST' && path === '/lab/run') {
          if (Number(request.headers.get('content-length')) > 50000) return json({ error: 'Lab payload too large' }, 413);
          let input: unknown;
          try { input = JSON.parse(await bodyText(request, 50000)); validateInput(input); }
          catch (e) { return json({ error: String((e as Error).message) }, 400); }
          const snapshot = await this.ordered(() => {
            const view = airportView({ snapshot: (c, m) => this.engine.sim.snapshot(c, m) }, () => this.twins().length > 0);
            return structuredClone({ clock: view.clock(), flow: view.flow(), flights: view.flights(), provisional: view.provisional(), blocked: view.blocked?.() ?? [] });
          });
          return json(await runLab(this.env, { clock: () => snapshot.clock, flow: () => snapshot.flow,
            flights: () => snapshot.flights, provisional: () => snapshot.provisional, blocked: () => snapshot.blocked }, input, this.ctx.storage));
        }
        return json({ error: 'Unknown lab endpoint' }, 404);
      }
    } catch (e) { return json({ error: String((e as Error).message) }, 500); }
    return json({ error: 'Unknown lab endpoint' }, 404);
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/lab' || path.startsWith('/lab/')) return this.lab(request, path);
    if (path === '/cams' || path.startsWith('/cams/')) return this.camsRoute(request, new URL(request.url));
    return this.ordered(async () => {
      const url = new URL(request.url);
      const path = url.pathname;
      try {
        if (path.startsWith('/api/auth/')) return authRoute(request, {
          auth: new Auth(this.ctx.storage), env: this.env,
          profile: phone => this.whatsapp.profile(phone),
          withinWindow: phone => this.whatsapp.withinWindow(phone),
          sendOtp: async (phone, code) => {
            if (!allowed(this.env, phone)) return false;
            const result = await this.whatsapp.wa.sendText(phone, `Cod Clarion: ${code}. Valabil 5 minute.`);
            return result.ok && !result.dryRun;
          },
        });
        if (path.startsWith('/api/reports') && this.env.DEMO_TOKEN && !await equalSecret(request.headers.get('Authorization'), `Bearer ${this.env.DEMO_TOKEN}`)) return json({ error: 'Operator token required' }, 401);
        if (request.method === 'POST' && ['/api/action', '/api/sim/command', '/api/ops/command', '/api/alerts/command', '/api/agent/route', '/api/demo/reset'].includes(path) && this.env.DEMO_TOKEN && !await equalSecret(request.headers.get('Authorization'), `Bearer ${this.env.DEMO_TOKEN}`)) return json({ error: 'Operator token required' }, 401);
        if (path === '/ws') {
          const client = url.searchParams.get('client') as Client;
          if (!['twin', 'vision', 'console', 'viewer'].includes(client)) return json({ error: 'Invalid client' }, 400);
          if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426);
          if (client !== 'viewer' && this.env.DEMO_TOKEN && !await equalSecret(url.searchParams.get('token'), this.env.DEMO_TOKEN)) return json({ error: 'Operator token required' }, 401);
          if (client === 'vision') for (const old of this.ctx.getWebSockets('vision')) { try { old.close(4001, 'Replaced by a newer vision client'); } catch { /* Already closed. */ } }
          const pair = new WebSocketPair();
          this.ctx.acceptWebSocket(pair[1], [client]);
          pair[1].serializeAttachment({ client });
          pair[1].send(packet('state', this.engine.snapshot()));
          return new Response(null, { status: 101, webSocket: pair[0] });
        }
        if (request.method === 'GET') {
          if (path === '/api/me') {
            const data = await this.whatsapp.messaging.passenger(url.searchParams.get('token') ?? '');
            return data ? json(data) : json({ error: 'Unknown passenger' }, 404);
          }
          if (path === '/api/sim') return json(this.engine.sim.snapshot(this.twins().length > 0, this.engine.state.metrics, this.visions().length > 0));
          // D11: staff reports for the dashboard pins.
          if (path === '/api/reports') return json(await this.whatsapp.reports.list());
          if (path === '/api/sim/agents') return json(this.engine.sim.agents(url.searchParams));
          if (path === '/health') return json({ ok: true, service: 'clarion', whatsapp: this.env.WA_TOKEN || this.env.WHATSAPP_TOKEN ? 'live' : 'dry-run' });
          if (path === '/api/state') return json(this.engine.snapshot());
          if (path === '/api/aircraft') return json({ aircraft: await aircraftNearLrcv(), source: 'OpenSky (empty on timeout/unavailable)' });
          if (path === '/webhooks/whatsapp') {
            const challenge = verifyWhatsApp(url.searchParams, this.env.WHATSAPP_VERIFY_TOKEN);
            return challenge === undefined ? json({ error: 'Verification rejected' }, 403) : new Response(challenge);
          }
        }
        if (request.method === 'POST') {
          if (path === '/api/demo/reset') return json(await this.reset());
          if (path === '/api/join' || path === '/api/join/demo') {
            const demo = path === '/api/join/demo';
            const input = JSON.parse(await bodyText(request, 1024));
            if (!input || typeof input !== 'object' || Array.isArray(input) ||
              ((!demo || input.flight !== undefined) && (typeof input.flight !== 'string' || input.flight.length > 20)) ||
              (input.lang !== undefined && input.lang !== 'ro' && input.lang !== 'en') ||
              (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 80)))
              return json({ error: 'Flight and optional first name required' }, 400);
            const view = airportView(this.engine.sim, () => this.twins().length > 0);
            const flight = demo && input.flight === undefined
              ? view.flights().filter(f => f.status === 'scheduled').slice().sort((a, b) => a.std - b.std)[0]
              : findFlight(view.flights(), input.flight);
            if (!flight) return json({ error: 'Unknown flight' }, 404);
            const boarding = demo ? boardingFromSchedule(flight, input.name) : undefined;
            const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
            const pending: PendingJoin = { lang: input.lang ?? 'ro', flight: flight.flight, expiresAt: Date.now() + JOIN_TTL_MS,
              ...(input.name?.trim() && { name: input.name.trim().split(/\s+/)[0] }) };
            const link = waLink(flight.flight, token, this.env.WHATSAPP_NUMBER);
            const pass = boarding ? await this.wallet.boardingPass(token, boarding, new Date(pending.expiresAt).toISOString(), link) : undefined;
            await this.ctx.storage.put(joinKey(token), pending);
            const phone = await new Auth(this.ctx.storage).currentPhone(bearer(request.headers));
            if (phone && !demo) {
              const key = `wa:profile:${phone}`;
              await this.ctx.storage.put(key, { phone, role: 'passenger', ...await this.whatsapp.profile(phone),
                flight: flight.flight, lang: pending.lang, token, verified: true });
              await this.whatsapp.messaging.addPhone(phone);
            }
            return json({ token, waLink: link, ...(boarding && { bcbp: boarding.bcbp, walletUrl: pass!.saveUrl }) }, 201);
          }
          if (path === '/api/wallet/pass') {
            const input = JSON.parse(await bodyText(request));
            if (input?.joinToken !== undefined) {
              const pending = await pendingJoin(this.ctx.storage, input.joinToken);
              if (!pending) return json({ error: 'Active join token required' }, 400);
              return json(await this.wallet.joinPass(input.joinToken, pending.flight,
                new Date(pending.expiresAt).toISOString(), waLink(pending.flight, input.joinToken, this.env.WHATSAPP_NUMBER)));
            }
            return json(await this.wallet.pass(this.engine, input?.subscriptionId));
          }
          if (path === '/webhooks/whatsapp') {
            if (!this.env.WHATSAPP_APP_SECRET) return json({ error: 'WhatsApp app secret not configured' }, 503);
            const raw = await bodyText(request, 1048576);
            if (!await validWhatsAppSignature(raw, request.headers.get('X-Hub-Signature-256'), this.env.WHATSAPP_APP_SECRET))
              return json({ error: 'Invalid webhook signature' }, 403);
            const body = JSON.parse(raw);
            // Meta retries inbound messages. Status receipts are already idempotent
            // in the core; drop duplicate inbound IDs before confirmation sends.
            for (const entry of Array.isArray(body?.entry) ? body.entry : [])
              for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
                if (!Array.isArray(change.value?.messages)) continue;
                change.value.messages = change.value.messages.filter((m: { id?: string }) => !m.id || !this.seenWhatsApp.includes(m.id));
              }
            await this.engine.whatsappWebhook(body);
            // Clarion's agent answers after the 200, outside the request queue (SPEC-v2 D2).
            this.background(this.whatsapp.inbound(body));
            for (const entry of body?.entry ?? []) for (const change of entry.changes ?? [])
              for (const m of change.value?.messages ?? []) if (typeof m.id === 'string') this.seenWhatsApp.push(m.id);
            this.seenWhatsApp = this.seenWhatsApp.slice(-2000);
            await this.ctx.storage.put('whatsappIds', this.seenWhatsApp);
            return json({ ok: true });
          }
          if (path === '/api/subscribe') {
            const input = JSON.parse(await bodyText(request));
            const sub = this.engine.subscribe(input);
            await this.engine.confirmSubscription(sub);
            return json({ subscriptionId: sub.id }, 201);
          }
          const close = /^\/api\/reports\/([A-Za-z0-9_-]{1,40})\/close$/.exec(path);
          if (close) {
            const report = await this.whatsapp.reports.close(close[1]!);
            return report ? json(report) : json({ error: 'Unknown report' }, 404);
          }
          if (path === '/api/sim/command') {
            const data = simCommand(JSON.parse(await bodyText(request)));
            const twins = this.twins();
            for (const ws of twins) ws.send(packet('sim.command', data));
            return json({ connected: twins.length > 0 }, twins.length ? 202 : 409);
          }
          if (path === '/api/alerts/command') {
            const data = JSON.parse(await bodyText(request));
            await this.handle({ type: 'console.alert.command', ts: new Date().toISOString(), data }, 'console');
            return json({ alerts: this.engine.sim.alertSnapshot() });
          }
          if (path === '/api/ops/command') {
            // D12: Unity confirms with ops.ack { id }; nothing is recorded while Unity is offline.
            const command = opsCommand(JSON.parse(await bodyText(request)));
            if (!this.twins().length) return json({ connected: false }, 409);
            const record = this.engine.sim.sent(command);
            this.toTwins('ops.command', opsWire(record));
            // Vision gets every command too, to know the open lanes and blocked zones (contract v2).
            for (const ws of this.visions()) ws.send(packet('ops.command', opsWire(record)));
            // D10: passengers hear about it; vision's evac.plan brings the routes, else a generic message after 3 s.
            if (record.type === 'evacuate') this.background(this.whatsapp.messaging.evacuate(record.zones, record.id));
            else this.background(this.whatsapp.messaging.adminChanged(record));
            return json({ connected: true, command: record }, 202);
          }
          if (path === '/api/agent/route') {
            const sent = this.toTwins('agent.route', agentRoute(JSON.parse(await bodyText(request))));
            return json({ connected: sent }, sent ? 202 : 409);
          }
          if (path === '/api/action') {
            const event = JSON.parse(await bodyText(request)) as Envelope;
            if (!event?.type?.startsWith('console.')) throw new Error('Console action required');
            await this.handle(event, 'console');
            return json(this.engine.snapshot());
          }
        }
        return json({ error: 'Not found' }, 404);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Invalid request' }, 400);
      }
    });
  }
  /** GET /cams and GET /cams/<camera>.jpg, behind the console's token check (Bearer, or ?token= for an <img>). */
  private async camsRoute(request: Request, url: URL): Promise<Response> {
    if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
    if (this.env.DEMO_TOKEN && !await equalSecret(request.headers.get('Authorization'), `Bearer ${this.env.DEMO_TOKEN}`) &&
      !await equalSecret(url.searchParams.get('token'), this.env.DEMO_TOKEN)) return json({ error: 'Operator token required' }, 401);
    if (url.pathname === '/cams') return json(this.cams.list());
    const match = /^\/cams\/([a-z0-9_]{1,64})\.jpg$/.exec(url.pathname);
    const frame = match ? this.cams.meta(match[1]!) : undefined;
    if (!frame) return json({ error: 'Unknown camera' }, 404);
    return new Response(frame.jpeg, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Sim-Time': String(frame.simTime) } });
  }
  /** camera.frame from vision: kept and forwarded to consoles, outside the engine queue (no engine state, nothing persisted). */
  private cameraFrame(ws: WebSocket, event: Envelope) {
    try {
      if (ws.deserializeAttachment()?.client !== 'vision') throw new Error('Client cannot issue this event');
      if (!Number.isFinite(Date.parse(event.ts))) throw new Error('Invalid JSON envelope');
      const frame = this.cams.accept(event.data);
      if (!frame) return;
      const value = packet('camera.frame', frame);
      for (const console of this.ctx.getWebSockets('console')) { try { console.send(value); } catch { /* Closed peer. */ } }
    } catch (error) {
      ws.send(packet('error', { message: error instanceof Error ? error.message : 'Invalid camera.frame' }));
    }
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === 'string' && message.length <= 1048576 && message.includes('"camera.frame"')) {
      let event: Envelope | undefined;
      try { event = JSON.parse(message); } catch { /* Reported below like any invalid payload. */ }
      if (event?.type === 'camera.frame') { this.cameraFrame(ws, event); return; }
    }
    await this.ordered(async () => {
      try {
        if (typeof message !== 'string' || new TextEncoder().encode(message).length > 1048576) throw new Error('Invalid WebSocket payload');
        const client = ws.deserializeAttachment()?.client as Client | undefined;
        if (!client) throw new Error('Missing client attachment');
        await this.handle(JSON.parse(message), client);
      } catch (error) {
        ws.send(packet('error', { message: error instanceof Error ? error.message : 'Invalid event' }));
      }
    });
  }
  webSocketClose(ws: WebSocket, code: number) { closeSocket(ws, code); }
  webSocketError(ws: WebSocket) { ws.close(1011, 'WebSocket error'); }
}

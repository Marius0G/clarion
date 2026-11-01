import { personalRoute, consumeChatTicket, personAuthorized, chatTurn, type PersonSocket } from './personal-routes.js';
import { Auth, bearer } from './auth.js';
import { authRoute } from './auth-routes.js';
import { FileAuthStore } from './auth-store.js';
import { WhatsAppAgent } from '../../worker/src/wa/index.js';
import { allowed } from '../../worker/src/wa/transport.js';
import { airportView } from '../../worker/src/wa/tower.js';
import { validWhatsAppSignature } from '../../worker/src/channels.js';
import { findFlight } from '../../worker/src/wa/flights.js';
import { joinKey, JOIN_TTL_MS, waLink } from '../../worker/src/join.js';
import { createHash,timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer,type IncomingMessage } from "node:http";
import { dirname,resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocket,WebSocketServer } from "ws";
import { Wallet } from "./channels/wallet.js";
import { verifyWhatsApp,whatsapp } from "./channels/whatsapp.js";
import { aircraftNearLrcv,FidsAdapter } from "./data/flights.js";
import { Engine } from "./engine.js";
import "./node-runtime.js";
import { agentRoute,opsCommand,opsWire,simCommand } from "./sim.js";
import type { Client,Envelope } from "./types.js";
function numberEnv(name: string, fallback: number, min = 0, max = Infinity) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`Invalid ${name}`);
  return n;
}
function integerEnv(name: string, fallback: number, min: number, max: number) {
  const n = numberEnv(name, fallback, min, max);
  if (!Number.isInteger(n)) throw new Error(`Invalid ${name}: integer required`);
  return n;
}
async function rawBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 65536) throw new Error("Body exceeds 64 KiB");
  }
  return body;
}
async function jsonBody(req: IncomingMessage): Promise<any> { return JSON.parse(await rawBody(req)); }
export function loadBackendEnv(
  file = fileURLToPath(new URL("../.env", import.meta.url)),
) {
  // The compiled entry point lives under dist/backend/src, so resolve the package root too.
  const actual = file.replace("/dist/backend/.env", "/.env").replace("/dist/.env", "/.env");
  if (existsSync(actual)) loadEnvFile(actual);
  // Team WhatsApp account lives in repo-root .env; backend/exported values win.
  const teamEnv = resolve(dirname(actual), "../.env");
  if (existsSync(teamEnv)) loadEnvFile(teamEnv);
}
export function createControlTower() {
  const wallet = new Wallet(process.env, process.env.STATE_FILE
    ? `${process.env.STATE_FILE}.wallet.json`
    : fileURLToPath(new URL('../data/wallet.json', import.meta.url)).replace('/dist/data/', '/data/'));
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });
  const clients = new Map<WebSocket, Client>();
  const people = new Map<WebSocket, PersonSocket>();
  const toPerson = (phone: string, event: unknown) => {
    for (const [ws, person] of people) if (person.phone === phone && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };
  const emit = (type: string, data: any) => {
    const packet = JSON.stringify({ type, ts: new Date().toISOString(), data });
    for (const [ws, kind] of clients)
      if (
        ws.readyState === WebSocket.OPEN &&
        (type === "state" || kind !== "viewer")
      )
        ws.send(packet);
  };
  const stateFile = process.env.STATE_FILE ?? resolve(
    dirname(fileURLToPath(import.meta.url)),
    existsSync(new URL("../package.json", import.meta.url)) ? "../data/state.json" : "../../data/state.json",
  );
  const engine = new Engine({
    file: stateFile,
    emit,
    adapters: { whatsapp },
    simSpeed: numberEnv("SIM_SPEED", 60, 0.001),
    seed: process.env.SIM_SEED,
  });
  const authStore = new FileAuthStore(`${stateFile}.auth.json`);
  const auth = new Auth(authStore);
  const view = airportView(engine.sim, () => [...clients.values()].includes('twin'));
  const waAgent = new WhatsAppAgent(process.env, authStore, view, { pause: 0, personEvent: toPerson, reportsChanged: rows => engine.updateStaffReports(rows) });
  const reportsReady = waAgent.reports.list().then(rows => engine.updateStaffReports(rows));
  const webhookWork = new Set<Promise<void>>();
  // One ordered mutation queue prevents reset/actions interleaving with slow external sends.
  let queue = Promise.resolve();
  function ordered<T>(work: () => Promise<T> | T): Promise<T> {
    const result = queue.then(() => engine.batch(work));
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  let aircraft: unknown[] = [];
  // Constant-time operator token check; digests equalize lengths.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const operator = (actual: string | null | undefined) =>
    !process.env.DEMO_TOKEN || (typeof actual === "string" && timingSafeEqual(digest(actual), digest(process.env.DEMO_TOKEN)));
  const http = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin) {
      let allowed = false;
      try {
        const url = new URL(origin);
        allowed =
          (["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
          (url.protocol === "https:" && url.hostname.endsWith(".pages.dev"));
      } catch {}
      if (!allowed) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      await reportsReady;
      if (url.pathname === '/api/chat' || url.pathname === '/api/chat/ticket' || url.pathname === '/api/me' || url.pathname === '/api/staff' || url.pathname.startsWith('/api/staff/tasks/') ||
        (url.pathname === '/api/reports' && req.method === 'POST') || /^\/api\/reports\/[^/]+\/(state|close)$/.test(url.pathname)) {
        const personalBody = req.method === 'POST' ? await rawBody(req) : undefined;
        const response = await ordered(() => personalRoute(new Request(url, { method: req.method,
          headers: { Authorization: req.headers.authorization ?? '' }, ...(personalBody !== undefined && { body: personalBody }) }), {
          store: authStore, agent: waAgent, sim: engine.sim, view, env: process.env,
          operator: operator(req.headers.authorization?.replace(/^Bearer /, '')) }));
        if (response) { res.writeHead(response.status); res.end(await response.text()); return; }
      }
      if (req.method === "POST" && ["/api/action", "/api/sim/command", "/api/ops/command", "/api/alerts/command", "/api/reports", "/api/agent/route", "/api/demo/reset"].includes(url.pathname) && !operator(req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null)) {
        res.writeHead(401); res.end(JSON.stringify({ error: "Operator token required" })); return;
      }
      if (url.pathname.startsWith('/api/auth/')) {
        const request = new Request(url, { method: req.method, headers: { Authorization: req.headers.authorization ?? '' },
          ...(req.method === 'POST' && { body: await rawBody(req) }) });
        const response = await authRoute(request, {
          auth, env: process.env,
          profile: phone => waAgent.profile(phone),
          withinWindow: phone => waAgent.withinWindow(phone),
          sendOtp: async (phone, code) => {
            if (!allowed(process.env, phone)) return false;
            const result = await waAgent.wa.sendText(phone, `Cod Clarion: ${code}. Valabil 5 minute.`);
            return result.ok && !result.dryRun;
          },
        });
        res.writeHead(response.status); res.end(await response.text()); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/join') {
        const input = await jsonBody(req);
        if (!input || typeof input.flight !== 'string' || input.flight.length > 20 ||
          (input.lang !== undefined && !['ro', 'en'].includes(input.lang))) throw new Error('Invalid flight or language');
        const flight = findFlight(view.flights(), input.flight);
        if (!flight) { res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown flight' })); return; }
        const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        await authStore.put(joinKey(token), { flight: flight.flight, lang: input.lang ?? 'ro', expiresAt: Date.now() + JOIN_TTL_MS });
        const phone = await auth.currentPhone(bearer(new Headers({ Authorization: req.headers.authorization ?? '' })));
        if (phone) {
          await authStore.put(`wa:profile:${phone}`, { phone, role: 'passenger', ...await waAgent.profile(phone),
            flight: flight.flight, lang: input.lang ?? 'ro', token, verified: true });
          await waAgent.messaging.addPhone(phone);
          toPerson(phone, { type: 'me' });
        }
        res.writeHead(201); res.end(JSON.stringify({ token, waLink: waLink(flight.flight, token, process.env.WHATSAPP_NUMBER) })); return;
      }
      const open = (client: Client) => [...clients].filter(([ws, kind]) => kind === client && ws.readyState === WebSocket.OPEN);
      const twins = () => open("twin");
      if (req.method === 'POST' && url.pathname === '/api/demo/reset') {
        const cleared = await ordered(async () => ({ ...await wallet.reset(), ...engine.reset() }));
        for (const [ws] of twins()) ws.send(JSON.stringify({ type: 'sim.command', ts: new Date().toISOString(), data: { reset: true } }));
        res.end(JSON.stringify({ ok: true, cleared })); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/wallet/pass') {
        const body = await jsonBody(req);
        res.end(JSON.stringify(await ordered(() => wallet.pass(engine, body?.subscriptionId)))); return;
      }
      if (req.method === "GET" && url.pathname === "/api/sim") {
        res.end(JSON.stringify(engine.sim.snapshot(twins().length > 0, engine.state.metrics, open("vision").length > 0))); return;
      }
      if (req.method === "GET" && url.pathname === "/api/sim/flow") {
        // Light live crowding for the phone maps (/m, /s): camera rows only, no positions or truth (D0).
        const s = engine.sim.snapshot(twins().length > 0, null, open("vision").length > 0);
        res.end(JSON.stringify({ at: new Date().toISOString(), simTime: s.simTime, flow: s.flow, blocked: s.blocked })); return;
      }
      if (req.method === "GET" && url.pathname === "/api/sim/agents") {
        res.end(JSON.stringify(engine.sim.agents(url.searchParams))); return;
      }
      if (req.method === "POST" && url.pathname === "/api/sim/command") {
        const data = simCommand(await jsonBody(req));
        const open = twins();
        for (const [ws] of open) ws.send(JSON.stringify({ type: "sim.command", ts: new Date().toISOString(), data }));
        res.writeHead(open.length ? 202 : 409); res.end(JSON.stringify({ connected: open.length > 0 })); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/alerts/command') {
        const data = await jsonBody(req);
        await ordered(() => engine.handle({ type: 'console.alert.command', ts: new Date().toISOString(), data }, 'console'));
        res.end(JSON.stringify({ alerts: engine.sim.alertSnapshot() })); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/reports') {
        if (!operator(req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null)) { res.writeHead(401); res.end(JSON.stringify({ error: 'Operator token required' })); return; }
        res.end(JSON.stringify(await waAgent.reports.list())); return;
      }
      if (req.method === "POST" && url.pathname === "/api/ops/command") {
        // D12: Unity confirms with ops.ack { id }; nothing is recorded while Unity is offline.
        const command = opsCommand(await jsonBody(req));
        const open = twins(), visions = () => [...clients].filter(([ws, kind]) => kind === "vision" && ws.readyState === WebSocket.OPEN);
        if (!open.length) { res.writeHead(409); res.end(JSON.stringify({ connected: false })); return; }
        const record = engine.sim.sent(command);
        await waAgent.messaging.adminChanged(command);
        // Vision gets every command too, to know the open lanes and blocked zones (contract v2).
        for (const [ws] of [...open, ...visions()]) ws.send(JSON.stringify({ type: "ops.command", ts: new Date().toISOString(), data: opsWire(record) }));
        res.writeHead(202); res.end(JSON.stringify({ connected: true, command: record })); return;
      }
      if (req.method === "POST" && url.pathname === "/api/agent/route") {
        const data = agentRoute(await jsonBody(req));
        const open = twins();
        for (const [ws] of open) ws.send(JSON.stringify({ type: "agent.route", ts: new Date().toISOString(), data }));
        res.writeHead(open.length ? 202 : 409); res.end(JSON.stringify({ connected: open.length > 0 })); return;
      }
      if (url.pathname === "/webhooks/whatsapp") {
        if (req.method === "GET") {
          const challenge = verifyWhatsApp(url.searchParams, process.env.WHATSAPP_VERIFY_TOKEN);
          res.writeHead(challenge === undefined ? 403 : 200, {"Content-Type": "text/plain"});
          res.end(challenge ?? "Forbidden"); return;
        }
        if (req.method === "POST") {
          if (!process.env.WHATSAPP_APP_SECRET) { res.writeHead(503); res.end(JSON.stringify({ error: 'WhatsApp app secret not configured' })); return; }
          const raw = await rawBody(req);
          if (!await validWhatsAppSignature(raw, String(req.headers['x-hub-signature-256'] ?? ''), process.env.WHATSAPP_APP_SECRET)) {
            res.writeHead(403); res.end(JSON.stringify({ error: 'Invalid webhook signature' })); return;
          }
          const body = JSON.parse(raw);
          await ordered(async () => {
            const seen = await authStore.get<string[]>('whatsappIds') ?? [];
            for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) {
              if (!Array.isArray(change.value?.messages)) continue;
              const fresh = [];
              for (const message of change.value.messages) {
                if (typeof message.id !== 'string' || seen.includes(message.id)) continue;
                seen.push(message.id);
                fresh.push(message);
              }
              change.value.messages = fresh;
            }
            await authStore.put('whatsappIds', seen.slice(-2000));
            await engine.whatsappWebhook(body);
          });
          const work = waAgent.inbound(body);
          webhookWork.add(work);
          void work.finally(() => webhookWork.delete(work));
          res.end(JSON.stringify({ok: true})); return;
        }
      }
      if (req.method === "GET" && url.pathname === "/health") {
        res.end(
          JSON.stringify({
            ok: true,
            service: "clarion",
          }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        res.end(JSON.stringify(engine.snapshot()));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/aircraft") {
        res.end(
          JSON.stringify({
            aircraft,
            source: "OpenSky (empty on timeout/unavailable)",
          }),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/subscribe") {
        const body = await jsonBody(req);
        const sub = await ordered(async () => { const sub = engine.subscribe(body); await engine.confirmSubscription(sub); return sub; });
        res.writeHead(201);
        res.end(
          JSON.stringify({
            subscriptionId: sub.id,
          }),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/action") {
        const body = (await jsonBody(req)) as Envelope;
        if (!body.type?.startsWith("console."))
          throw new Error("Console action required");
        await ordered(() => wallet.handle(engine, body, "console"));
        res.end(JSON.stringify(engine.snapshot()));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Invalid request",
        }),
      );
    }
  });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const kind = url.searchParams.get("client");
    if (url.pathname === '/ws' && kind === 'person') {
      void ordered(async () => {
        const person = await consumeChatTicket(authStore, url.searchParams.get('ticket'), process.env);
        const entries = person ? (await waAgent.chatHistory(person.phone)).slice(-50) : [];
        sockets.handleUpgrade(req, socket, head, ws => {
          if (!person) { ws.close(4401, 'Session required'); return; }
          people.set(ws, person);
          ws.send(JSON.stringify({ type: 'history', entries }));
          ws.on('message', raw => {
            void ordered(async () => {
              try {
                if (!await personAuthorized(authStore, person, process.env)) { ws.close(4401, 'Session required'); return; }
                if (Buffer.byteLength(raw.toString()) > 16384) throw new Error('Invalid message');
                const event = JSON.parse(raw.toString());
                if (event?.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
                if (event?.type !== 'chat') throw new Error('Invalid message');
                const result = await chatTurn(authStore, waAgent, person.phone, person.session, event);
                if (result.status !== 200) ws.send(JSON.stringify({ type: 'error', status: result.status, ...result.body }));
              } catch (error) { ws.send(JSON.stringify({ type: 'error', status: 400, error: error instanceof Error ? error.message : 'Invalid message' })); }
            });
          });
          ws.on('close', () => people.delete(ws));
          ws.on('error', () => people.delete(ws));
        });
      }).catch(() => socket.destroy());
      return;
    }
    if (
      url.pathname !== "/ws" ||
      !["twin", "vision", "console", "viewer"].includes(kind ?? "")
    ) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (kind !== "viewer" && !operator(url.searchParams.get("token"))) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      // Exactly one camera service: a new vision connection replaces the old one.
      if (kind === "vision") for (const [old, k] of clients) if (k === "vision") { clients.delete(old); old.close(4001, "Replaced by a newer vision client"); }
      clients.set(ws, kind as Client);
      ws.send(
        JSON.stringify({
          type: "state",
          ts: new Date().toISOString(),
          data: engine.snapshot(),
        }),
      );
      ws.on("message", (raw) => {
        void ordered(async () => {
          try {
            const event = JSON.parse(raw.toString());
            const client = clients.get(ws);
            await wallet.handle(engine, event, client);
            if (event.type === 'sim.status' || event.type === 'flight.update') for (const [peer] of people) {
              if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'me' }));
            }
            if (client === 'vision' && event.type === 'flow.report') await waAgent.messaging.flowChanged();
            if (client === 'twin' && event.type === 'flight.update') await waAgent.messaging.flightsChanged();
            if (client === 'vision' && event.type === 'evac.plan') await waAgent.messaging.plan(event.data);
          } catch (error) {
            ws.send(
              JSON.stringify({
                type: "error",
                ts: new Date().toISOString(),
                data: {
                  message:
                    error instanceof Error ? error.message : "Invalid event",
                },
              }),
            );
          }
        });
      });
      ws.on("close", () => clients.delete(ws));
    });
  });
  // SPEC §5.6: due reads coalesce to at most two persists/state broadcasts per second.
  const tick = setInterval(() => {
    void ordered(() => engine.tick());
  }, 500);
  tick.unref();
  const expiry = setInterval(() => {
    void ordered(() => engine.expire());
  }, 60000);
  expiry.unref();
  const fids = new FidsAdapter();
  let stopped = false;
  const refreshFids = async () => {
    const result = await fids.get();
    if (!stopped) await ordered(() => engine.updateFlights(result.flights, result.dataSource));
  };
  void refreshFids();
  const fidsPoll = setInterval(() => { void refreshFids(); }, 300000);
  fidsPoll.unref();
  const refresh = () => {
    void aircraftNearLrcv().then((data) => {
      aircraft = data;
    });
  };
  refresh();
  const flights = setInterval(refresh, 60000);
  flights.unref();
  const stop = async () => {
    stopped = true;
    clearInterval(fidsPoll);
    clearInterval(tick);
    clearInterval(expiry);
    clearInterval(flights);
    for (const ws of people.keys()) ws.terminate();
    for (const ws of clients.keys()) ws.terminate();
    sockets.close();
    await queue;
    await Promise.allSettled([...webhookWork]);
    engine.persist();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return { http, engine, stop };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  loadBackendEnv();
  const server = createControlTower();
  const port = integerEnv("PORT", 8787, 1, 65535);
  server.http.listen(port, "0.0.0.0", () =>
    console.log(`Clarion listening on :${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void server.stop().then(() => process.exit(0));
    });
}

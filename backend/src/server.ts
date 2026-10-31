import "./node-runtime.js";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { Engine } from "./engine.js";
import { Telegram } from "./channels/telegram.js";
import { sms } from "./channels/sms.js";
import { whatsapp, verifyWhatsApp } from "./channels/whatsapp.js";
import { webpush } from "./channels/webpush.js";
import { wazeFeed } from "./channels/waze.js";
import { aircraftNearLrcv, FidsAdapter } from "./data/flights.js";
import type { Envelope } from "./types.js";
function numberEnv(name: string, fallback: number, min = 0, max = Infinity) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`Invalid ${name}`);
  return n;
}
function integerEnv(name: string, fallback: number, min: number, max: number) {
  const n = numberEnv(name, fallback, min, max);
  if (!Number.isInteger(n))
    throw new Error(`Invalid ${name}: integer required`);
  return n;
}
async function jsonBody(req: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 65536) throw new Error("Body exceeds 64 KiB");
  }
  return JSON.parse(body);
}
export function loadBackendEnv(
  file = fileURLToPath(new URL("../.env", import.meta.url)),
) {
  // The compiled entry point lives under dist/src, so resolve the package root too.
  const actual = file.replace("/dist/.env", "/.env");
  if (existsSync(actual)) loadEnvFile(actual);
  // Team WhatsApp account lives in repo-root .env; backend/exported values win.
  const teamEnv = resolve(dirname(actual), "../.env");
  if (existsSync(teamEnv)) loadEnvFile(teamEnv);
}
export function createControlTower() {
  const telegram = new Telegram();
  const telegramReady = telegram.initialize().catch(() => {
    console.warn(
      "Telegram startup identity check failed; check token / network",
    );
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });
  const clients = new Map<WebSocket, "twin" | "console" | "viewer">();
  const emit = (type: string, data: any) => {
    const packet = JSON.stringify({ type, ts: new Date().toISOString(), data });
    for (const [ws, kind] of clients)
      if (
        ws.readyState === WebSocket.OPEN &&
        (type === "state" || kind !== "viewer")
      )
        ws.send(packet);
  };
  const engine = new Engine({
    file:
      process.env.STATE_FILE ??
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        existsSync(new URL("../package.json", import.meta.url))
          ? "../data/state.json"
          : "../../data/state.json",
      ),
    emit,
    adapters: { telegram: (m) => telegram.send(m), sms, whatsapp, webpush },
    simSpeed: numberEnv("SIM_SPEED", 60, 0.001),
    seed: process.env.SIM_SEED,
    autoConfirm: process.env.AUTO_CONFIRM === "true",
    wavesEnabled: process.env.WAVES_ENABLED !== "false",
    waveCount: integerEnv("WAVE_COUNT", 3, 1, 20),
    waveMinutes: numberEnv("WAVE_MINUTES", 10, 0.01),
    taxiGroup: process.env.TELEGRAM_TAXI_GROUP_ID,
  });
  // One ordered mutation queue prevents reset/actions interleaving with slow external sends.
  let queue = Promise.resolve();
  function ordered<T>(work: () => Promise<T> | T): Promise<T> {
    const result = queue.then(work);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  let aircraft: unknown[] = [];
  const http = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin) {
      let allowed = false;
      try {
        const url = new URL(origin);
        allowed =
          origin === "http://localhost:5173" ||
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/webhooks/whatsapp") {
        if (req.method === "GET") {
          const challenge = verifyWhatsApp(url.searchParams, process.env.WHATSAPP_VERIFY_TOKEN);
          res.writeHead(challenge === undefined ? 403 : 200, {"Content-Type": "text/plain"});
          res.end(challenge ?? "Forbidden"); return;
        }
        if (req.method === "POST") {
          const body = await jsonBody(req);
          await ordered(() => engine.whatsappWebhook(body));
          res.end(JSON.stringify({ok: true})); return;
        }
      }
      if (req.method === "GET" && url.pathname === "/health") {
        res.end(
          JSON.stringify({
            ok: true,
            service: "clarion",
            telegram: process.env.TELEGRAM_BOT_TOKEN ? "live" : "dry-run",
          }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/telegram") {
        await telegramReady;
        res.end(JSON.stringify(telegram.status()));
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
      if (req.method === "GET" && url.pathname === "/waze/cifs.json") {
        res.end(JSON.stringify(wazeFeed(engine.state)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/subscribe") {
        const body = await jsonBody(req);
        await telegramReady;
        const sub = await ordered(async () => { const sub = engine.subscribe(body); await engine.confirmSubscription(sub); return sub; });
        res.writeHead(201);
        res.end(
          JSON.stringify({
            subscriptionId: sub.id,
            ...(sub.channel === "telegram"
              ? {
                  telegramLink: engine.telegramLink(
                    sub,
                    telegram.botUsername ??
                      process.env.TELEGRAM_BOT_USERNAME ??
                      "ClarionDemoBot",
                  ),
                }
              : {}),
          }),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/action") {
        const body = (await jsonBody(req)) as Envelope;
        if (!body.type?.startsWith("console."))
          throw new Error("Console action required");
        await ordered(() => engine.handle(body, "console"));
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
    if (
      url.pathname !== "/ws" ||
      !["twin", "console", "viewer"].includes(kind ?? "")
    ) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, kind as "twin" | "console" | "viewer");
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
            await engine.handle(JSON.parse(raw.toString()), clients.get(ws));
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
  const tick = setInterval(() => {
    void ordered(() => engine.tick());
  }, 100);
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
  void telegramReady.then(() =>
    telegram.poll(
      engine.telegramOffset,
      (chat, payload) => ordered(() => engine.telegramStart(chat, payload)),
      (id, chat) => {
        void ordered(() => { engine.markRead(id, chat); });
      },
      (offset) => {
        void ordered(() => {
          engine.telegramOffset = offset;
          engine.persist();
        });
      },
      (chat, text) => { void ordered(() => engine.updatePresence("telegram", chat, text)); },
    ),
  );
  const stop = async () => {
    stopped = true;
    clearInterval(fidsPoll);
    telegram.stop();
    clearInterval(tick);
    clearInterval(expiry);
    clearInterval(flights);
    for (const ws of clients.keys()) ws.terminate();
    sockets.close();
    await queue;
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

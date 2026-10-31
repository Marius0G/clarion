# Clarion Cloudflare backend

Cloudflare Worker `clarion-backend` routes every HTTP request and WebSocket to the same SQLite-backed Durable Object `Tower` (instance name `tower`). This is the internet counterpart of the Node backend. Only `worker/` belongs to this implementation; it imports the sibling `backend/src` engine, state types, templates, Telegram sender, WhatsApp sender/parser/handler, flight fixture and Waze adapter. Keep both folders when building or deploying.

## Local run and verification

Use a current Node release supported by Wrangler (Node 22.12+). From this directory:

```sh
npm install
npm run typecheck
npm test
npm run dev -- --ip 127.0.0.1 --port 8788
```

In another terminal:

```sh
cd ../backend
BACKEND_URL=http://127.0.0.1:8788 npm run demo
```

Port 8788 keeps the Worker separate from a Node backend on 8787. Without real credentials, channel sends are dry-run; the twin's simulated delivery/read still works. The demo resets incident state and registers simulated agents. It preserves phone subscriptions, so use a dedicated test instance when credentials are configured.

In a restricted shell, keep tool caches/logs/registry inside this directory:

```sh
npm install --cache .npm-cache
WRANGLER_REGISTRY_PATH=.wrangler/registry WRANGLER_LOG_PATH=.wrangler/logs npm run dev -- --ip 127.0.0.1 --port 8788
```

Tests use Vitest plus Miniflare/workerd, including real WebSocket upgrades, console actions, subscriptions, webhook authentication, CORS, alarm-driven reads, hibernation with connected sockets, and SQLite restart persistence. Miniflare 5 uses its exported v4 options converter in the test harness. Versions and transitive dependencies are locked in `package-lock.json`.

## Deploy (operator only)

No deployment is performed by the implementation or tests. From the repo root, the exact deployment command is:

```sh
cd /Users/bogdan/Developer/Hackathon/Craiova2026/worker && npm run deploy
```

Authenticate Wrangler to the intended Cloudflare account first. The `v1` migration creates `Tower` with SQLite-backed storage; preserve migration history on later releases. `compatibility_date = "2026-10-30"` matches the installed local runtime's latest supported date.

Wrangler prints the assigned HTTPS workers.dev URL after deployment. Use:

- Console HTTP origin: `https://clarion-backend.<account-subdomain>.workers.dev`
- Unity: `wss://clarion-backend.<account-subdomain>.workers.dev/ws?client=twin`
- Console socket: the same URL with `client=console`; read-only viewers use `client=viewer`.

The existing console backend selector supports `?backend=<HTTPS origin>`, persisted in browser local storage. For example, open `https://clarion-craiova.pages.dev/?backend=https%3A%2F%2Fclarion-backend.<account-subdomain>.workers.dev`; `/join?backend=...` selects the same API for subscriptions. For a default connection on every browser, set the Pages build variables `VITE_BACKEND_HTTP=https://<worker-host>` and `VITE_BACKEND_URL=wss://<worker-host>/ws?client=console`, then rebuild Pages. This task does not change or deploy Pages.

CORS and WebSocket Origin validation allow HTTPS `*.pages.dev` and HTTP/HTTPS localhost, 127.0.0.1 and ::1 on any port. Native Unity requests without Origin work. This retains the Node demo contract: client roles enforce which events a connection may send, but the console/twin roles themselves have no operator login.

## Secrets

Set deployment secrets only with `npx wrangler secret put NAME`, entered at its interactive prompt. Never put values in `wrangler.toml`, source, shell history, README, or committed environment files. No secrets are supplied with this implementation. Local `.dev.vars*`, `.env*`, dependencies, test state and Wrangler output are ignored; tests use synthetic values only.

| Name | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot API token; absent means dry-run. |
| `TELEGRAM_WEBHOOK_SECRET` | Required for webhook acceptance; must equal the `setWebhook` secret token. |
| `TELEGRAM_TAXI_GROUP_ID` | Optional opted-in group destination; also keep private. |
| `TELEGRAM_BOT_USERNAME` | Optional subscription-link fallback; not sensitive, but may be set as a secret. Live `getMe` discovery takes precedence. |
| `WHATSAPP_TOKEN` | Canonical Meta access token, as in root/backend `.env.example`. |
| `WHATSAPP_PHONE_NUMBER_ID` | Canonical sending phone ID, as in `.env.example`. |
| `WHATSAPP_WABA_ID` | WABA account ID from `.env.example`; retained for setup, not needed by message sending. |
| `WHATSAPP_VERIFY_TOKEN` | Private token chosen for Meta's GET verification callback. |
| `WHATSAPP_APP_SECRET` | Meta app secret for POST HMAC verification; webhook POSTs fail closed until configured. |
| `SMSLINK_CONNECTION_ID` | SMSLink connection ID. |
| `SMSLINK_PASSWORD` | SMSLink connection password. |

Legacy `WA_TOKEN` / `WA_PHONE_NUMBER_ID` remain accepted aliases for canonical WhatsApp names. Canonical names take precedence. `WA_API_VERSION` appeared in the previous backend example; the shared WhatsApp sender pins `v23.0`, so this variable is no longer used. Do not set both name families unnecessarily.

Examples (prompts receive the values):

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put WHATSAPP_APP_SECRET
npx wrangler secret put SMSLINK_CONNECTION_ID
npx wrangler secret put SMSLINK_PASSWORD
```

Simulation configuration is nonsecret and lives in `[vars]`: `SIM_SPEED`, `SIM_SEED`, `AUTO_CONFIRM`, `WAVES_ENABLED`, `WAVE_COUNT`, `WAVE_MINUTES`. Defaults match Node; auto-confirm stays off.

## Telegram webhook

The Worker never starts `poll()` or calls `getUpdates`. After deploying and setting the secrets, securely provide `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` in the helper process's ephemeral environment, then run:

```sh
npm run telegram:set-webhook -- https://clarion-backend.<account-subdomain>.workers.dev
```

The helper sets `/webhooks/telegram`, the secret token, `max_connections: 1`, and `allowed_updates: [message, callback_query]`. It preserves pending updates and prints no credentials. Wrangler secrets are write-only; the helper cannot retrieve them. Stop any Node long poller using the same bot before registration. Switching that bot back to Node requires deleting its webhook first.

The endpoint checks `X-Telegram-Bot-Api-Secret-Token`, accepts private `/start` deep links, forwards read acknowledgements with destination ownership checks to the shared engine, answers callbacks, and persists the update cursor. Retries with an older update ID are acknowledged without reprocessing. `/api/telegram` exposes exactly the same three public fields as Node; bot identity is discovered lazily with `getMe`, cached durably, and never includes the token or destination IDs.

## WhatsApp webhook

Set Meta's callback URL to `https://<worker-host>/webhooks/whatsapp`, use the same `WHATSAPP_VERIFY_TOKEN`, and subscribe to the `messages` field.

- GET checks `hub.mode=subscribe` and `hub.verify_token`, returning `hub.challenge` as plain text.
- POST verifies `X-Hub-Signature-256` over the exact request body with `WHATSAPP_APP_SECRET`, then calls `Engine.whatsappWebhook`. This handles Start codes, delivery/read statuses and location buttons using the existing catalog and engine.
- The most recent 2,000 inbound message IDs are persisted for retry deduplication; delivery/read statuses are idempotent in the shared engine. Deduplication is bounded, not an exactly-once delivery guarantee across an interrupted external send.

## State and scheduling

The storage adapter maps the engine's existing synchronous runtime seam to a SQLite JSON snapshot. It preserves private receipt/recipient sets, subscriptions and consent, simulated agents, Telegram cursor, drone location, pending read/action times, and incident counters. The synchronous seam is scoped to one stack frame; it never installs global environment credentials. No Node HTTP, filesystem or long-poll entry point is imported.

All mutations, including WS messages, webhook requests and alarms, share one ordered queue. State broadcasts use `ctx.getWebSockets()`; roles survive hibernation in socket attachments. Reset preserves real subscriptions and clears simulated incident state exactly as Node does.

One DO alarm targets the earliest pending simulated read/action or subscription expiry. Its handler calls the core `tick()`/`expire()` and reschedules the next deadline. There are no timer loops or `setTimeout`-based simulated reads. Persisted receipt flags make alarm retries idempotent. An inactive tower with no subscriptions or scheduled work has no alarm. DO alarms can run late; this is simulated latency, not a hard real-time guarantee. External sends remain best effort and are not retried automatically after interruption.

Routes: `GET /health`, `/api/state`, `/api/telegram`, `/api/aircraft`, `/waze/cifs.json`; `POST /api/action`, `/api/subscribe`, `/webhooks/telegram`, `/webhooks/whatsapp`; WhatsApp verification GET; `/ws?client=twin|console|viewer`. State envelopes and command validation come from the shared engine. As on Node, the flight fixture is explicitly labelled; there is no filesystem-backed sim-ab projection in the Worker, so `isuTimeToT2` remains null until a twin reports it. RO-Alert remains a draft, Waze remains simulated, web push remains dry-run.

## Verification recorded 2026-10-31

`npm install --cache .npm-cache` completed with zero reported vulnerabilities. `npm run typecheck` passed. `npm test` passed all 10 workerd integration tests, including connected-socket hibernation with a pending read alarm and persistent incident/metric restoration across a full Miniflare restart.

`WRANGLER_REGISTRY_PATH=.wrangler/registry WRANGLER_LOG_PATH=.wrangler/logs npx --no-install wrangler dev --ip 127.0.0.1 --port 8788 --inspector-port 9235` served `/health` successfully. Running `BACKEND_URL=http://127.0.0.1:8788 npm run demo` from `backend/` exited 0 with `DEMO PASS` and final phase `normal`. Channels were dry-run; no live Telegram, Meta or SMS credentials were used. The successful demo log is local ignored output at `.wrangler/demo.log`.

The first demo attempt targeted an existing Node listener on 8787 after Wrangler failed startup. It was stopped; that attempt issued demo actions against the Node instance. All successful Worker demo verification used isolated port 8788. No deploy, git commit or push was run.

Cloudflare implementation references: [hibernating WebSockets](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

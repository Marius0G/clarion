# Clarion Cloudflare backend

One SQLite Durable Object, `Tower`, coordinates HTTP, WebSockets and shared backend state. Keep sibling backend sources available. [SPEC-v2](../docs/SPEC-v2.md) is the contract.

```sh
npm ci
npm run typecheck
npm test
npm run dev -- --ip 127.0.0.1 --port 8788
# From backend/: BACKEND_URL=http://127.0.0.1:8788 npm run demo:terminal
```

`npm test` rebuilds dist before Miniflare/workerd tests. Deploy with `npm run deploy` after authenticating to the intended Cloudflare account. Preserve migration history.

`GET /health` returns `ok: true`, `service: "clarion"` and WhatsApp configuration status. State, aircraft, sim telemetry, subscription, Wallet, WhatsApp webhook, sim command, ops command, reports and passenger `/api/me` routes remain. Unity connects with `client=twin`, vision with `client=vision`; console and viewer roles remain. Telemetry is ephemeral across hibernation; subscription/receipt state persists in SQLite. Socket roles survive hibernation. An ordered mutation queue and alarm handle receipts, expiry and five-minute FIDS refreshes.

CORS permits HTTPS `*.pages.dev` and local origins. Optional `DEMO_TOKEN` protects operator HTTP calls with Bearer authentication and non-viewer sockets with `?token=`. App backend overrides and build configuration remain supported.

## Secrets

Use `npx wrangler secret put NAME`. Never commit values. `SIM_SPEED` and `SIM_SEED` are nonsecret vars.

- WhatsApp: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`. `WA_TOKEN` and `WA_PHONE_NUMBER_ID` remain aliases; the agent supports `WA_API_VERSION`.
- Agent: `ANTHROPIC_API_KEY`, optional `WA_ALLOWLIST`, `CLAUDE_MODEL`, `STAFF_CODE`.
- Wallet: `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SA_EMAIL`, `GOOGLE_WALLET_SA_KEY` (PKCS#8 PEM).

Set Meta's callback to `https://<worker>/webhooks/whatsapp`. GET verifies the token; POST verifies `X-Hub-Signature-256` against the raw body, deduplicates inbound IDs, acknowledges the webhook and runs the agent through `ctx.waitUntil`. Delivery/read receipts are idempotent. Sends remain best effort.

## Passenger messaging (SPEC-v2 D10, D11, D14, D17)

`src/wa/messaging.ts` is the one fan-out: `notify(subscriber, { kind, text })` sends to a real phone on WhatsApp (only inside the 24h window; outside it the message is skipped and logged, there is no approved template for these yet) or to a simulated subscriber as `agent.message { agentId, text, kind }` on the twin socket.

- `flight.update` replaces the provisional schedule in the agent (times in seconds or `HH:MM`, `checkIn: "check_in:<group>"` picks the desk-group queues). When a flight becomes `delayed` / `cancelled` or its `delayMin` changes, its subscribers get one `kind: "flight"` message per change; resending the same schedule sends nothing.
- `agent.register { agentId, role, channel: "sim", flight }` (alone or inside `agents[]`) registers a simulated subscriber and sends it the `arrive` message. The legacy shape is unchanged.
- `STAFF <code>` (see `STAFF_CODE`) gives the staff role; the agent's `reportIssue` stores reports. `GET /api/reports` → `[{ id, at, kind, node, text, status }]` and `POST /api/reports/:id/close`, both with `Authorization: Bearer <DEMO_TOKEN>`. `kind` ∈ `bagaj_abandonat | medical | securitate | aglomerare | altele`; `node` is the best-match provisional zone/node id or null.
- An `evacuate` ops.command waits 3 s for `evac.plan` (vision, A10; accepted from any non-viewer client until `client=vision` exists). With the plan, each subscriber gets the route for the node its stage (estimated from the clock, D9) maps to, and sim agents also get `agent.route`; without it, everyone gets the generic evacuation message.

## Google Wallet

`POST /api/join { flight }` issues a single-use flight token. `POST /api/wallet/pass { subscriptionId }` accepts an active subscription; `{ joinToken }` creates a pending-flight pass with its WhatsApp link and QR code, returning `{ saveUrl, demo }`. All three credentials enable signed Clarion save JWTs; otherwise the result is `/join/wallet-demo?sub=<id>`. Pass registrations and per-pass UTC daily attempt counters persist. OAuth token caching, status PATCHes and the three-notification attempt budget remain. The removed incident lifecycle no longer triggers updates. Keep the Google Wallet demo issuer, service account and test users configured.

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

## Passenger messaging (SPEC-v2 D10, D11, D14, D17, D22)

`src/wa/messaging.ts` is the one fan-out: `notify(subscriber, { kind, text })` sends to a real phone on WhatsApp (only inside the 24h window; outside it the message is skipped and logged, there is no approved template for these yet) or to a simulated subscriber as `agent.message { agentId, text, kind }` on the twin socket.

- `START` and new simulated passengers receive queues now and at their likely arrival time, gate close time and an entrance-to-gate estimate (including the A6 margin). Passenger text describes the situation without instructions; evacuation remains direct.
- Each `flow.report` evaluates only bound passengers. An `arrive` update is sent when the A6 total changes by at least 10 minutes from the last successfully sent estimate. Estimates and the per-passenger 15-minute wall-clock cooldown persist across restarts; unsuccessful deliveries do not advance them. `flight` and `evacuate` bypass the cooldown. Admin closure/redirect messages use the same delivery limit and target the affected flight queues/gate.
- `/api/me` retains `arriveBy` for compatibility and adds `queues` (now, forecast, forecast time/source) and `entranceToGateMin`. `/m/<token>` presents the situation and estimate instead of an arrival instruction.
- `flight.update` replaces the provisional schedule in the agent (times in seconds or `HH:MM`, `checkIn: "check_in:<group>"` picks the desk-group queues). When a flight becomes `delayed` / `cancelled` or its `delayMin` changes, its subscribers get one `kind: "flight"` message per change; resending the same schedule sends nothing.
- `agent.register { agentId, role, channel: "sim", flight }` (alone or inside `agents[]`) registers a simulated subscriber and sends it the `arrive` message. The legacy shape is unchanged.
- `STAFF <code>` (see `STAFF_CODE`) gives the staff role; the agent's `reportIssue` stores reports. `GET /api/reports` → `[{ id, at, kind, node, text, status }]` and `POST /api/reports/:id/close`, both with `Authorization: Bearer <DEMO_TOKEN>`. `kind` ∈ `bagaj_abandonat | medical | securitate | aglomerare | altele`; `node` is the best-match provisional zone/node id or null.
- An `evacuate` ops.command waits 3 s for `evac.plan` (vision, A10; accepted from any non-viewer client until `client=vision` exists). With the plan, each subscriber gets the route for the node its stage (estimated from the clock, D9) maps to, and sim agents also get `agent.route`; without it, everyone gets the generic evacuation message.

## Google Wallet

`POST /api/join { flight }` issues a single-use flight token. `POST /api/wallet/pass { subscriptionId }` accepts an active subscription; `{ joinToken }` creates a pending-flight pass with its WhatsApp link and QR code, returning `{ saveUrl, demo }`. All three credentials enable signed Clarion save JWTs; otherwise the result is `/join/wallet-demo?sub=<id>`. Pass registrations and per-pass UTC daily attempt counters persist. OAuth token caching, status PATCHes and the three-notification attempt budget remain. The removed incident lifecycle no longer triggers updates. Keep the Google Wallet demo issuer, service account and test users configured.

## Full demo chain and live smoke

`npm test` includes `test/e2e-chain.test.ts`: all four D18 beats run in an isolated
Miniflare Tower with fake Unity/vision sockets, signed WhatsApp webhooks and mocked
Meta/Anthropic HTTP calls. Tool calculations and notification fan-out use the real worker.

The smoke script needs Node 22+ and no WhatsApp or Anthropic secrets. It mutates
telemetry, creates a pending join token and records staff commands, so use an isolated
backend with no other twin/vision connected. It refuses an already connected simulator.
It restores security lanes and the previous flights, plus the previous security flow
and simulation clock when available. Use `npm run demo:reset` below to clear pending join tokens, command history and
telemetry for a pristine run.

Run locally in two terminals from `worker/`:

```sh
# No .dev.vars with messaging credentials is needed. The script and server share this token.
npm run dev -- --ip 127.0.0.1 --port 8788 --var DEMO_TOKEN:local-smoke
CLARION_URL=http://127.0.0.1:8788 DEMO_TOKEN=local-smoke npm run e2e:live
```

For an intentional deployed smoke run, set `CLARION_URL` and `DEMO_TOKEN` to that
backend's URL and operator token. With no URL override the script targets
`https://clarion-backend.bogdan-c-2206.workers.dev`. Each step prints PASS/FAIL;
any failed step (including cleanup) exits nonzero. It never calls the WhatsApp webhook.

## Reset demo (D24)

From `worker/`, run `DEMO_TOKEN=<operator-token> npm run demo:reset`. Optional
`CLARION_URL` overrides `https://clarion-backend.bogdan-c-2206.workers.dev`.
The script prints the response and exits nonzero on an HTTP/network failure or missing token.

`POST /api/demo/reset` uses the same Bearer authentication as `/api/ops/command`
and returns `{ ok: true, cleared: { ...counts } }`. Counts describe removed records
(alert counts are passenger history keys). It drains pending messaging, cancels evacuation
timers, and clears WhatsApp/sim subscribers, profiles, page/join tokens, histories,
24h windows, deduplication, Wallet passes/daily rate limits, reports (IDs restart at R1),
evacuation, command history, agents, receipts, metrics and all sim telemetry. Lanes return
to the provisional plan; clearing Unity flights restores the provisional passenger schedule.
Connected Unity receives `sim.command { reset: true }`. Connections stay open.
There is no dashboard button. The Node backend mirrors reset for the state it owns.

## WhatsApp and web end-to-end checks

From `worker/`, run `npm run e2e:wa` with Node 22+. The script reads
`DEMO_TOKEN` and `WHATSAPP_APP_SECRET` from the environment or gitignored
`.dev.vars`; values, boarding passes and bearer links are never printed.
`CLARION_URL` and `CLARION_WEB_URL` override the production backend and web defaults.

Each numbered step reports PASS, FAIL with a reason, or SKIP with its missing
prerequisite. Full runs exit 1 on failures and 2 on incomplete coverage. Against
production before these lab hooks are deployed, run `npm run e2e:wa -- --available`:
this checks the deployed web bundle, demo BCBP/Wallet/START response, webhook
security, a signed fake-number turn, Meta's delivery result, and cleanup. Expected
Meta error 131030 is a passing outbound attempt, not proof of delivery. Dry runs,
missing attempts and other delivery errors fail. Available-only runs exit 0 when
all applicable checks pass and explicitly retain SKIP for unavailable coverage.

A full run requires no connected twin/camera and no existing passenger subscribers.
It adds a unique test flight, uses the issued START token in the captured lab,
checks `/api/me?token=…` and `/m/…`, then sends a gate closure through the real ops
API. Named `lab-e2e-<UUID>` passengers are persisted only when `keep: true` and
`texts` are supplied to `/lab/run`. Their automatic sends are captured as `lab-out`
events before Graph. Ordinary lab scripts retain isolated storage. The issued
join token is consumed exactly once; it is no longer replaced with a hardcoded flight.

Authenticated lab hooks:

- `GET /lab/capabilities`: hook version and whether mutation is currently safe.
- `POST /lab/alert-ready { phone }`: clears only a kept fake passenger's nonurgent
  cooldown, so the ops step does not wait 15 minutes after START. Real passengers
  keep D22's existing cooldown, including admin closures/redirects.
- `POST /lab/cleanup { phone }`: removes only that fake passenger's profile,
  subscription, page token, context, message history and kept lab snapshot.

The signed webhook uses a deliberately invalid +999 country-code number, never a
real passenger. Cleanup sends it `delete my data`, removes the lab profile, reopens
the test gate, restores flights, and verifies lanes/gates match the snapshot.
Diagnostic events, webhook deduplication IDs and ops audit records remain; no global
demo reset is performed. The runner refuses to alter a gate that was already closed.

`npm test` also executes the runner as a child process against isolated workerd,
with mocked Graph/Wallet networking and a fixture web shell, and checks persisted
cleanup. `app/tests/passenger.spec.ts` tests the browser join/Wallet flow and
passenger flight/gate/queue rendering against mocked backend responses.

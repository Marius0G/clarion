# Clarion backend

Node **22**, TypeScript, built-in HTTP/fetch and `ws`. Implements `../app/PM/CONTRACT.md`, SPEC v3 and the team plan pages 1–10. No frontend files are needed or modified. Dispatcher actions stay human-controlled; the Unity twin and real phones use the same message engine.

## Run

```sh
cd backend
nvm use                      # .nvmrc selects Node 22; equivalent Node managers are fine
npm install
npm run build
npm test
npm start                    # http://localhost:8787; ws://localhost:8787/ws?client=console
```

`npm run dev` runs the source with watch mode. Copy `.env.example` to `.env`. The repo-root `.env` is also loaded for the team WhatsApp credentials, after backend values; existing/exported values win. Both `npm start` and `npm run dev` load `backend/.env` automatically using Node 22’s built-in loader; exported variables take precedence. All commands above run from `backend/`.

In a second terminal, `cd backend && npm run demo` runs the **automatic CI mode** (`DEMO_MODE=auto`, the default). It resets the incident, registers 60 simulated agents and three unbound Telegram subscriptions, presses every console action, and checks delivery/read counters. Pauses default to 1.5 s plus seven seconds for simulated reads. Both modes preserve existing phone subscriptions: use a demo instance; approved messages can reach opted-in phones with real credentials.

For the pitch, reset the incident **in the console first**, start the video together with `npm run demo:pitch` (`DEMO_MODE=twin`), and follow each `Apasă: …` cue. Twin mode sends only the six scenario twin events; it never resets, registers agents/subscriptions, or presses console actions. It waits for confirmation (`phase=suspended`), approval of at least one selected role's drafts for each situation, the RO-Alert draft, recovery, each configured wave, and final normal phase. The operator chooses which roles receive messages. No minimum read/delivery count is asserted for this human-driven mode. RO-Alert remains a draft only.

The default video offsets are detection **0 s**, interceptors airborne **15 s**, diversion **30 s**, net contact **57 s**, target-down/payload inspection **85 s**, and readiness to reopen **90 s**. The contract has no distinct contact/target-down event: contact maps to `intercept.captured`, inspection to `payload.suspicious`. These are demo offsets inspired by the hook; pages 11–12 specify human-triggered messages, not these exact timestamps. Offsets are elapsed wall seconds from initial state validation. Human gates take precedence: a late action delays subsequent events and logs `VIDEO LATE`; pause the video if strict synchronization is needed.

Override the offsets with `npm run demo:pitch -- --timeline video.json`. Paths are relative to the working directory (`backend/`). JSON is a timestamp-ordered list of `{atSec, event}`; event can be a type string (fixture payload defaults) or `{type, data}` (payload overrides). Include all six events in the default order:

```json
[
  {"atSec": 0, "event": "drone.detected"},
  {"atSec": 15, "event": {"type": "intercept.launched", "data": {"count": 2}}},
  {"atSec": 30, "event": "flight.diverted"},
  {"atSec": 57, "event": "intercept.captured"},
  {"atSec": 85, "event": "payload.suspicious"},
  {"atSec": 90, "event": "ops.reopened"}
]
```

`DEMO_TIMEOUT_MS=0` (default) waits indefinitely for state/actions. Set a positive millisecond deadline per wait to fail a rehearsal rather than hang. Socket disconnects and backend rejection frames fail waits immediately. Neither mode reports `isuTimeToT2` unless `DEMO_ISU_MIN` is explicitly set to a finite nonnegative number; e.g. `DEMO_ISU_MIN=10.2 npm run demo` prints **FIXTURE … not a measurement** before reporting it. Without that override the backend may still expose its separately labelled sim-ab fallback; the demo does not manufacture a measurement.

Port conflicts: `PORT=8788 STATE_FILE=/tmp/tower-demo-state.json npm start`, then `PORT=8788 npm run demo`. Use one process per state file. Stop with Ctrl-C.

## Environment

| Variable                                           | Default / meaning                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `PORT`                                             | `8787`, binds `0.0.0.0`                                                        |
| `STATE_FILE`                                       | `backend/data/state.json` (resolved relative to the backend package)           |
| `SIM_SPEED`                                        | `60`: six simulated minutes become six real seconds; positive                  |
| `SIM_SEED`                                         | `control-tower`; stable agent ID + situation determine latency/action draws    |
| `AUTO_CONFIRM`                                     | `false`; `true` allows twin `ops.suspended` to confirm for A/B batch runs only |
| `WAVES_ENABLED`                                    | `true`; `false` skips waves, retaining recovery and final reopen actions       |
| `WAVE_COUNT`                                       | `3` (integer 1–20)                                                             |
| `WAVE_MINUTES`                                     | `10`, window spacing in real clock minutes, independent of simulation speed    |
| `TELEGRAM_BOT_TOKEN`                               | Missing = dry-run, no network sends or polling                                 |
| `TELEGRAM_BOT_USERNAME`                            | Bot username without `@`; fallback placeholder `ClarionDemoBot` in dry-run; live username discovered with `getMe`        |
| `TELEGRAM_TAXI_GROUP_ID`                           | Optional opted-in “Taxi CRA” chat, one RO broadcast per approved alert/wave    |
| `SMSLINK_CONNECTION_ID`, `SMSLINK_PASSWORD`        | Both required for SMSLink HTTPS sends; otherwise dry-run                       |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Team Cloud API credentials; missing either = dry-run (Graph v23.0, same version as template submitter)                         |
| `BACKEND_URL`                                      | Demo target; defaults to `http://localhost:$PORT`                              |
| `DEMO_MODE`                                      | `auto`; `demo:pitch` defaults to `twin` (an explicit environment value overrides) |
| `DEMO_TIMEOUT_MS`                                | `0` = no deadline; positive milliseconds per twin state/action wait             |
| `DEMO_ISU_MIN`                                   | Unset = no metric report; explicit nonnegative fixture minutes, logged as fixture |
| `DEMO_PAUSE_MS`                                    | `1500`, demo step delay                                                        |

No secrets or private channel IDs appear in public state. Local JSON storage contains destinations and must stay private; `.env`, `data/*.json`, build output and dependencies are gitignored. Atomic write/rename persists subscriptions, state, counters, receipts, Telegram polling cursor, seeded pending reads and actions on each change. Invalid JSON fails startup instead of silently discarding subscribers. Reset clears incident state, simulated agents and counters, **preserving active phone subscriptions**. External sends are best effort; interrupted sends are not automatically retried to avoid duplicate emergency messages.

## Telegram and jury QR

1. Open the official **@BotFather** in Telegram, send `/newbot`, choose a display name and a unique username ending in `bot`.
2. Set `TELEGRAM_BOT_TOKEN` in `backend/.env` to the token BotFather returns. Startup calls `getMe`, logs the verified bot username and uses it for links; `TELEGRAM_BOT_USERNAME` is only a fallback. Restart the backend. Run only one long poller for a token; an existing webhook must be removed before `getUpdates` can run.
3. Point the printed jury QR at the frontend `/join` URL. The frontend collects role, optional flight, language and channel consent and calls `POST /api/subscribe`; then opens the returned `telegramLink`.
4. The person must press **Start**. The bot binds the private chat ID; the UI subscription alone cannot receive messages. Opening the role deep link and pressing Start is the direct Telegram opt-in. A `/start` link without an API subscription defaults to Romanian.
5. Confirm suspension and approve the selected roles. The phone receives the role alert with **“Am înțeles / Got it”**. Pressing it increments read once, only for that message’s own chat.

Team deep-link format (spaces removed from flight):

```text
https://t.me/<bot>?start=passenger_home__W63412
https://t.me/<bot>?start=relative_arrivals__W63412
https://t.me/<bot>?start=taxi__
```

The API adds `__<subscriptionId>` (UUID without hyphens) to preserve the existing opt-in and language, within Telegram’s 64-character start limit. The base team format remains supported. Share the relative role link with whoever is waiting. Only private `/start` messages create phone subscriptions; the separately configured taxi group requires the group owner’s opt-in. A group send counts as **one endpoint**, not an invented number of members; group acknowledgements count once per broadcast, not unique group readers.

## HTTP / WS contract

All WS frames use `{ "type": "...", "ts": "<ISO-8601>", "data": {} }`. Connect to `/ws?client=twin|console|viewer`. All clients receive `state` on connection and each change. Viewer cannot mutate. Twin may issue only twin events, `agent.register`, and `metric.report`. Console may issue only `console.*` actions. `alert.sent`, `wave.green`, and `agent.notified` use the exact contract names and fields. Invalid requests return an `error` frame or HTTP 400.

| HTTP                  | Body / response                                                                    |
| --------------------- | ---------------------------------------------------------------------------------- |
| `GET /health`         | `{ok, service, telegram}`                                                          |
| `GET /api/telegram`  | `{enabled, botUsername, deepLinkExample}` (no token or private chat IDs) |
| `GET /api/state`      | Contract state plus `metrics`, `estimatedReopen`, `confirmedAt`, `dataSource`      |
| `POST /api/subscribe` | `{role, flight?, channel, lang, consent:true}` → `{subscriptionId, telegramLink?}` |
| `POST /api/action`    | Same enveloped `console.*` event as WS → current state                             |
| `GET /waze/cifs.json` | Simulated CIFS `{incidents:[...]}`                                                 |
| `GET /api/aircraft`   | Extra endpoint: OpenSky cache, `[]` when unavailable                               |

Subscription accepts optional **`destination`** for SMS/WhatsApp (phone number). Without it, configured real adapters cannot deliver. Telegram deliberately rejects an API-supplied destination; `/start` binds it. Optional `date` provides flight time/date for expiry; otherwise the matching fixture schedule or subscription time is used. We retain role, channel destination, flight, date and route, never a passenger name or PNR. Consent expires 48 h after that flight time and is purged at startup, before sends and every minute. Each channel requires its own subscription and consent.

Example console action:

```json
{
  "type": "console.approve_messages",
  "ts": "2026-10-31T12:00:00Z",
  "data": { "roles": ["passenger_home", "relative_arrivals", "taxi"] }
}
```

HTTP CORS permits `http://localhost:5173` and HTTPS subdomains of `*.pages.dev`; OPTIONS is supported. This is a hackathon event hub with **no dispatcher authentication**: client names are routing roles, not credentials. Deploying an unrestricted Internet endpoint requires an authenticated proxy/access layer.

## Decisions and state machine

- `drone.detected`: normal → detection. Public channel adapters and Waze remain silent. Twin `ops.suspended` updates the estimate but cannot authorize public sends unless `AUTO_CONFIRM=true`.
- `console.confirm_suspension`: detection → suspended, starts the first-minute clock and creates bilingual role drafts. No message is sent until `console.approve_messages {roles}`.
- Runway closure leaves the terminal open. `payload.suspicious` creates evacuation drafts only after confirmation; if detected earlier, confirmation creates those drafts. Evacuation supersedes stale runway/diversion notices on approval. `flight.diverted` updates the matching arrival and creates drafts for that flight. Subscribers with another known flight are excluded from that diversion.
- Approval is idempotent. The latest pending situation per role/language is sent; older pending notices are marked superseded. Each real recipient uses their language and flight context. All eleven supported roles × five situations × RO/EN render without missing placeholders; SMS has no links. `rent_a_car_ubt` is supported directly, as in the current contract.
- `console.request_roalert` requires confirmed evacuation and produces a draft for ISU. It has **no send path**.
- Twin `ops.reopened` records readiness and awaits the console. `console.reopen` moves suspended → recovery; the next call moves recovery → normal only after all configured waves are opened. Each transition is timestamped in `timeline` and broadcasts state.
- `console.open_wave {wave}` opens ordered configurable waves, emits `wave.green`, and sends “leave now” alerts to that wave’s stable assigned recipients. Wave opens are manual, so the operator can synchronize with video; no ten-minute real wait is enforced in the demo. The default assignment hashes subscription/agent IDs evenly; it does **not** claim distance-aware routing. Opening a wave explicitly approves its messages. Final reopening explicitly sends reopening notices.

## Counters and metric interpretation

Per role, `subscribers` includes active real subscriptions (including Telegram subscriptions awaiting Start) and registered twin agents. `sent` counts notification attempts per endpoint. WhatsApp `delivered` requires a provider delivered/read webhook; Telegram/SMS count provider acceptance. Twin delivery is simulated. Dry-run and stub attempts do not count as delivered. `read` counts idempotent message acknowledgements or simulated twin reads. Multiple incidents/messages can make sent/delivered/read exceed the subscriber count; invariant: **read ≤ delivered ≤ sent**.

Twin agents have seeded log-normal read latency, median 360,000 simulated ms (sigma 0.7), divided once by `SIM_SPEED`. After a read, each notification has a seeded 48% acting probability; “acting” follows after 30 simulated seconds. These are assumptions from the plan, not observed human behavior. Pending receipts resume after restart. All simulated messages pass through the same renderer, and `agent.notified` reports notified/read/acting.

- `notifiedFirstMinute`: **unique recipient endpoints** successfully notified within 60 real seconds of confirmation. Twin agents included; dry-run sends and unknown taxi group membership excluded. At most the recipients actually reached, never all subscriber records by assumption.
- `readRecipients`: unique endpoints acknowledging at least one delivered message (same endpoint identity as first-minute reach).
- `readCount`: message acknowledgements, including simulation; counts messages, not unique people.
- `carsStartedInVain`: fallback **synthetic proxy**: unique home/relative/taxi/rideshare agents that finish a read/action cycle without acting. Not measured traffic, and no claimed saved cars. Unity should report its actual count via `metric.report` to replace the proxy.
- `isuTimeToT2`: a twin-reported number in minutes takes precedence. Otherwise the optional `../sim-ab/out/results.json` supplies `{median, interval:[p05,p95], source:"sim-ab", units:"minutes", coverage:0.5, waves:false, model, intervalLabel}` for the alerted journey time (mean of four crews per seed). Missing or malformed results return null. This is an uncalibrated simulation, not observed performance or minutes saved. The demo reports no value unless `DEMO_ISU_MIN` explicitly opts into fixture minutes.
- `kerbPeak`: null until twin reports it (peak vehicle count).

`metric.report` accepts finite nonnegative values for the three twin-reported metrics. No coverage percentage is invented: Unity registers the relevant opted-in population for each 20/50/80% A/B run, keeping the same seed/agents between comparisons. The backend does not run Unity’s 20-seed experiment or claim causal improvement.

## Data / channel limitations

`src/data/flights.ts` polls both FIDS CRA endpoints every five minutes with a three-second fetch timeout and five-minute cache. It maps epoch timestamps, estimates, delays and airport direction, then reapplies simulated incident overlays. Failures fall back to a **clearly labelled illustrative Wizz winter 2026/27 fixture**, three departures and three matching return arrivals for the current Europe/Bucharest operating day (00:00 through the following night before 02:00). Before 02:00 the previous day remains selected. Bergamo `W6 3412` arrives at 23:55 after its outbound `W6 3411`; every return follows its outbound by a plausible round-trip duration. The 21/week assumption is from the team plan; route selection, flight numbers and times are not a verified live timetable. `craiova-airport.ro` could not be fetched during implementation. Suspended/diverted overlays never imply airline cancellation. OpenSky is fetched at startup and every minute with a three-second timeout and empty fallback; it is separate from FIDS and is not required for the demo.

Telegram uses real Bot API `sendMessage`, long-poll `getUpdates`, callback ownership checks and a persisted offset. SMSLink uses the HTTPS POST gateway and checks `MESSAGE;1;` success. WhatsApp is the primary real phone channel. See the setup and Worker integration below. Web push and Google Wallet remain dry-run stubs; Wallet demo enforces three notifications/pass/day in memory. It is not a real Wallet pass issuer or exposed subscription channel.

Waze exposes a **simulated** JSON closure for T2 access while suspended/evacuating; the polyline follows the last access segment in the local OSRM corridor fixture. It is not validated with Waze or submitted to a partner feed. This demo follows the requested suspension closure; it is not an assertion that every real runway suspension closes the access road. RO-Alert is a draft only, never sent.

Primary adapter references: [Telegram Bot API](https://core.telegram.org/bots/api), [Telegram deep links](https://core.telegram.org/bots/features#deep-linking), [SMSLink success responses](https://smslink.ro/sms-gateway-raspunsurile-de-confirmare-posibile-ale-sms-gateway-http.html), [Waze CIFS](https://developers.google.com/waze/data-feed/cifs-specification), [OpenSky REST API](https://openskynetwork.github.io/opensky-api/rest.html).


## Primary WhatsApp channel and webhooks

Use the team's existing Clarion account (+40 700 000 000), not a new account. Configure `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` from root `.env.example`; `WHATSAPP_WABA_ID` belongs to the template submission/status script and is not needed for sends. Backend `.env.example` also lists `WHATSAPP_VERIFY_TOKEN`: choose its value and enter the same value in Meta's webhook setup. Register HTTPS `/webhooks/whatsapp` and subscribe to messages; GET handles Meta's challenge and POST processes inbound messages/statuses. This work does not change the Meta account configuration or deploy the endpoint.

The sender uses the exact names, RO/EN languages, named body parameters and quick-reply button payloads in `whatsapp/templates.json`. `src/channels/whatsapp-catalog.ts` is a portable generated copy; a test requires matching parsed JSON content. Update it when the source catalog changes. Only Meta-approved templates can succeed; submission is not approval. Check actual approval separately with the team's existing `whatsapp/submit-templates.mjs --status`. API rejection is a failed send; missing credentials use dry-run.

- Subscription: `abonare_confirmata`; suspension confirmation/approval: `suspendare_pasager` for all passenger roles, `suspendare_asteptare` for relatives, `suspendare_taxi` for taxi/rideshare, `suspendare_personal` for staff.
- Diversion: `zbor_redirectionat` for relatives waiting for the matching flight; evacuation: `evacuare_terminal` for all roles.
- Recovery wave/final reopening: `reluare_pasager`, `reluare_asteptare`, `reluare_taxi`. Staff and other roles have no reopening template. The catalog contains no English taxi/staff templates. These combinations use free-form text inside the customer-service window; outside it they require a **separate consented Telegram/SMS subscription**. No channel consent or destination is inferred; existing reserve subscriptions receive the normal engine alerts. Unsupported WhatsApp sends are logged and never counted as delivered.

QR prefill example: `CLARION PASAGER W43831`. Also accepted: `START CLARION PASAGER W43831`, `START TAXI`, `START relative_arrivals W63412 EN`. Canonical role codes and PASAGER/PASSENGER, ASTEPTARE/RELATIVE, TAXI, BOLT and PERSONAL/STAFF aliases are supported. An inbound Start records consent, destination and language, sends confirmation, and opens the 24-hour window. Every subsequent inbound message extends that window; an outbound message never does. Inside it the adapter sends free-form text, including rendered template content when available. Outside it only a supported template is sent. Button replies and exact typed button texts update location or unsubscribe. Subscribe through HTTP with WhatsApp and a destination to receive the template confirmation before an inbound conversation.

Provider message IDs attach to private receipts. `sent` webhook events do not duplicate attempt counters; delivered/read advance counters idempotently, including out-of-order read-before-delivered notifications. Duplicate inbound webhook IDs are retained across restart (last 5,000) to avoid duplicate subscription confirmations. Unknown receipts do not affect counters. `state.presence[role]` contains home/road/terminal/kerb/unknown counts from active subscriptions and registered Unity agents. `agent.update` moves one existing agent; Telegram inline presence buttons use the same catalog mapping.

`state.dataSource` is `fids` or `fixture`; `dataSourceDetail` carries the explicit illustrative-fixture warning. Recorded unmodified real API responses from 31 October 2026 are under `tests/fixtures/fids-*-2026-10-31.json`; they are schedule snapshots, not incident evidence.

## Shared modules / Worker integration

Existing exports (`Engine`, `whatsapp`, `Telegram`, renderers and types) remain available. `engine.ts`, messages and channel modules have no Node builtin imports. Channels use fetch and accept explicit credentials (`createWhatsApp(env, fetcher)`, `new Telegram(token)`); default exports retain Node environment defaults through a guarded environment accessor.

Node filesystem persistence and the optional sim-ab file projection live in `node-runtime.ts`. `server.ts` installs it automatically. Direct Node consumers using `new Engine({file, simAbFile})` must import `./node-runtime.js` first. Workers must **not** import that file or `server.ts`; use `Engine` without `file`, or supply Durable Object storage hooks through `engineRuntime` in `runtime.ts`. The hooks accept/return the complete private store, including subscriptions, receipts, replay IDs and metric deduplication sets. Keep one engine/storage configuration per isolated runtime.

Worker routes can use `verifyWhatsApp(url.searchParams, env.WHATSAPP_VERIFY_TOKEN)` for GET, and await `engine.whatsappWebhook(body)` for POST. `parseWhatsAppWebhook(body)` is the pure parser. After an HTTP subscription, await `engine.confirmSubscription(sub)`; `subscribe()` retains its synchronous return type for compatibility. Use `new FidsAdapter().get()` then `engine.updateFlights(result.flights, result.dataSource)` at startup and every five minutes. Keep engine mutations serialized, as the Node server does.

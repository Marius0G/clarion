# CONTROL TOWER backend

Node **22**, TypeScript, built-in HTTP/fetch and `ws`. Implements `../app/PM/CONTRACT.md`, SPEC v2 and the team plan pages 1–10. No frontend files are needed or modified. Dispatcher actions stay human-controlled; the Unity twin and real phones use the same message engine.

## Run

```sh
cd backend
nvm use                      # .nvmrc selects Node 22; equivalent Node managers are fine
npm install
npm run build
npm test
npm start                    # http://localhost:8787; ws://localhost:8787/ws?client=console
```

`npm run dev` runs the source with watch mode. Copy `.env.example` to `.env`. Both `npm start` and `npm run dev` load `backend/.env` automatically using Node 22’s built-in loader; exported variables take precedence. All commands above run from `backend/`.

In a second terminal, `cd backend && npm run demo`. This fake twin registers 60 agents, creates three unbound Telegram test subscriptions, resets demo counters, detects a drone on runway **27**, confirms suspension through the console API, approves messages, diverts Bergamo to OTP, intercepts with a net, triggers a T2 evacuation and RO-Alert draft, then opens all waves and returns to normal. Pauses default to 1.5 s; an extra seven-second wait allows simulated reads. The reported `isuTimeToT2=10.2` is **scripted fixture minutes, not a measured improvement**. The driver asserts no sends before confirmation, transitions through suspended/recovery/normal, and moving delivery/read counters. It preserves existing phone subscriptions, so with real credentials it sends the scenario to opted-in phones. Run against a demo instance.

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
| `TELEGRAM_BOT_USERNAME`                            | Bot username without `@`; fallback placeholder `ControlTowerDemoBot` in dry-run; live username discovered with `getMe`        |
| `TELEGRAM_TAXI_GROUP_ID`                           | Optional opted-in “Taxi CRA” chat, one RO broadcast per approved alert/wave    |
| `SMSLINK_CONNECTION_ID`, `SMSLINK_PASSWORD`        | Both required for SMSLink HTTPS sends; otherwise dry-run                       |
| `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_API_VERSION` | All required for WhatsApp Cloud API; otherwise dry-run                         |
| `BACKEND_URL`                                      | Demo target; defaults to `http://localhost:$PORT`                              |
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
- Approval is idempotent. The latest pending situation per role/language is sent; older pending notices are marked superseded. Each real recipient uses their language and flight context. All ten contract roles × five situations × RO/EN render without missing placeholders; SMS has no links. Rent-a-car/UBT contacts can use `staff` until the team versions the fixed ten-role contract.
- `console.request_roalert` requires confirmed evacuation and produces a draft for ISU. It has **no send path**.
- Twin `ops.reopened` records readiness and awaits the console. `console.reopen` moves suspended → recovery; the next call moves recovery → normal only after all configured waves are opened. Each transition is timestamped in `timeline` and broadcasts state.
- `console.open_wave {wave}` opens ordered configurable waves, emits `wave.green`, and sends “leave now” alerts to that wave’s stable assigned recipients. Wave opens are manual, so the operator can synchronize with video; no ten-minute real wait is enforced in the demo. The default assignment hashes subscription/agent IDs evenly; it does **not** claim distance-aware routing. Opening a wave explicitly approves its messages. Final reopening explicitly sends reopening notices.

## Counters and metric interpretation

Per role, `subscribers` includes active real subscriptions (including Telegram subscriptions awaiting Start) and registered twin agents. `sent` counts notification attempts per endpoint; `delivered` means **provider API accepted** (or simulated twin delivery), not a verified handset receipt. Dry-run and stub attempts do not count as delivered. `read` counts idempotent message acknowledgements or simulated twin reads. Multiple incidents/messages can make sent/delivered/read exceed the subscriber count; invariant: **read ≤ delivered ≤ sent**.

Twin agents have seeded log-normal read latency, median 360,000 simulated ms (sigma 0.7), divided once by `SIM_SPEED`. After a read, each notification has a seeded 48% acting probability; “acting” follows after 30 simulated seconds. These are assumptions from the plan, not observed human behavior. Pending receipts resume after restart. All simulated messages pass through the same renderer, and `agent.notified` reports notified/read/acting.

- `notifiedFirstMinute`: **unique recipient endpoints** successfully notified within 60 real seconds of confirmation. Twin agents included; dry-run sends and unknown taxi group membership excluded. At most the recipients actually reached, never all subscriber records by assumption.
- `readRecipients`: unique endpoints acknowledging at least one delivered message (same endpoint identity as first-minute reach).
- `readCount`: message acknowledgements, including simulation; counts messages, not unique people.
- `carsStartedInVain`: fallback **synthetic proxy**: unique home/relative/taxi/rideshare agents that finish a read/action cycle without acting. Not measured traffic, and no claimed saved cars. Unity should report its actual count via `metric.report` to replace the proxy.
- `isuTimeToT2`: a twin-reported number in minutes takes precedence. Otherwise the optional `../sim-ab/out/results.json` supplies `{median, interval:[p05,p95], source:"sim-ab", units:"minutes", coverage:0.5, waves:false, model, intervalLabel}` for the alerted journey time (mean of four crews per seed). Missing or malformed results return null. This is an uncalibrated simulation, not observed performance or minutes saved. Demo reports the team fixture 10.2 minutes.
- `kerbPeak`: null until twin reports it (peak vehicle count).

`metric.report` accepts finite nonnegative values for the three twin-reported metrics. No coverage percentage is invented: Unity registers the relevant opted-in population for each 20/50/80% A/B run, keeping the same seed/agents between comparisons. The backend does not run Unity’s 20-seed experiment or claim causal improvement.

## Data / channel limitations

`src/data/flights.ts` contains a **clearly labelled illustrative Wizz winter 2026/27 fixture**, three departures and three matching return arrivals for the current Europe/Bucharest operating day (00:00 through the following night before 02:00). Before 02:00 the previous day remains selected. Bergamo `W6 3412` arrives at 23:55 after its outbound `W6 3411`; every return follows its outbound by a plausible round-trip duration. The 21/week assumption is from the team plan; route selection, flight numbers and times are not a verified live timetable. `craiova-airport.ro` could not be fetched during implementation. Suspended/diverted overlays never imply airline cancellation. OpenSky is fetched at startup and every minute with a three-second timeout and empty fallback; it is separate from FIDS and is not required for the demo.

Telegram uses real Bot API `sendMessage`, long-poll `getUpdates`, callback ownership checks and a persisted offset. SMSLink uses the HTTPS POST gateway and checks `MESSAGE;1;` success. WhatsApp uses Cloud API text messages: real use requires a test recipient/recent inbound conversation or approved templates outside the customer-service window; template onboarding and delivery/read webhooks are not implemented. Web push and Google Wallet remain dry-run stubs; Wallet demo enforces three notifications/pass/day in memory. It is not a real Wallet pass issuer or exposed subscription channel.

Waze exposes a **simulated** JSON closure for T2 access while suspended/evacuating; the polyline follows the last access segment in the local OSRM corridor fixture. It is not validated with Waze or submitted to a partner feed. This demo follows the requested suspension closure; it is not an assertion that every real runway suspension closes the access road. RO-Alert is a draft only, never sent.

Primary adapter references: [Telegram Bot API](https://core.telegram.org/bots/api), [Telegram deep links](https://core.telegram.org/bots/features#deep-linking), [SMSLink success responses](https://smslink.ro/sms-gateway-raspunsurile-de-confirmare-posibile-ale-sms-gateway-http.html), [Waze CIFS](https://developers.google.com/waze/data-feed/cifs-specification), [OpenSky REST API](https://openskynetwork.github.io/opensky-api/rest.html).

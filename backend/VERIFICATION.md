# QA gap verification — 31 October 2026

All seven requested backend gaps implemented. Edits restricted to `backend/` and additions in `app/PM/CONTRACT.md`. No commit. Concurrent console-engineer changes under `app/src` were left untouched.

- **Node 22.23.4**: `npm run build` PASS; `npm test` PASS, **157 tests in 4 files** (30 more than the previous 127-test baseline; includes 110 role/situation/language render cases).
- Compiled server on **8788**, isolated `/tmp/tower-qa-final-state-2.json`: default-pause `PORT=8788 npm run demo` PASS. Normal → detection → suspended → recovery → normal. Final demo metrics: **60 unique first-minute endpoints, 60 unique readers, 185 message acknowledgements**. Every role obeys read ≤ delivered ≤ sent. Includes rent_a_car_ubt sends. Final drone null, six reach entries and six flight rows verified through HTTP.
- API/WS tests cover explicit/derived drone coordinates and reset/reopening; API and Telegram acquisition sources; reach subscription/contact/location/draft semantics; notification delivery completion at 60 s and 60.001 s; unique readers versus total reads; counter survival through expiry/restart; operating-day boundaries and summer/winter Bucharest offsets; sim-ab missing/invalid file and twin override; `.env` loading and environment precedence; Bot API identity discovery, startup username log, status endpoint and links.
- `GET /api/telegram` on the isolated server: `{enabled:false,botUsername:null,deepLinkExample:null}`. There is **no backend/.env** in this checkout. Real Telegram delivery cannot be verified without a token/opted-in handset; getMe/send/poll/callback behavior is covered with mocks. No phone messages were sent during verification.
- Compiled default-path sim-ab projection verified: alerted journey median **19.475 min**, p05–p95 **18.3675–20.4075 min**, 50% coverage, waves off. This is an uncalibrated headless model, not measured improvement. Twin/demo's explicit 10.2-minute fixture overrides it.
- Realism check: positions use metres and clockwise degrees once; schedule has three outbound/return pairs, each returning later, Bergamo arrival at 23:55 local; unique recipients deduplicate chats across roles and never imply group membership; total reads stay distinct from unique readers. Waze **10 drivers/minute** is explicitly labelled a demo assumption; RO-Alert draft is never delivery. Intervals require finite nonnegative ordered bounds.
- `git diff --check` PASS. Server stopped after verification. Temporary logs/state are under `/tmp/tower-qa-*`.

The previous implementation report below is retained as history; counts, timetable scope, automatic env loading and metric fallback descriptions are superseded above.

---

# Backend verification — 31 October 2026

Implemented entirely under `backend/`; no edits to `app/`, no Git commit.

Runtime: **Node v22.23.4** (the machine's default PATH had Node 26, so Node 22 was obtained through npm exec). Source spec/contract read first; team-plan PDF pages 1–10 extracted and architecture page 9 visually inspected. Referenced `RTK.md` was not present in this checkout or its searched instruction paths.

| Check | Result |
| --- | --- |
| `npm install --cache /tmp/control-tower-npm` under Node 22 | PASS; 45 packages audited, zero vulnerabilities |
| `npm run build` under Node 22 | PASS (TypeScript strict compilation) |
| `npm test` under Node 22 | PASS; **127 tests**, 3 test files |
| `npm audit --cache /tmp/control-tower-npm` | PASS; zero vulnerabilities including dev dependencies |
| Start on default `8787` | Port already occupied by a Control Tower process from this directory; existing `/health` responds successfully. Existing process left untouched. |
| Start own instance with `PORT=8788` | PASS |
| `PORT=8788 npm run demo` with default pauses | PASS; normal → detection → suspended → recovery → normal; 60 first-minute recipients; 183 acknowledged messages at driver completion |
| Final compiled server + `PORT=8788 DEMO_PAUSE_MS=150 npm run demo` | PASS; isolated state file, server stopped afterwards |
| Actual process restart using saved isolated state | PASS; phase normal, all role subscriber counts preserved; 3 subscriptions and 60 agents retained |

The initial install hit an unwritable global npm cache; `/tmp` resolved it. Initial build found test mock type errors; fixed. Initial Vitest 3 dependency advisories were resolved by upgrading to Vitest 5.0.5. Test discovery explicitly excludes compiled copies in `dist`.

Final isolated demo acceptance snapshot:

```json
{
  "phase": "normal",
  "subscriptions": 3,
  "agents": 60,
  "totals": { "sent": 315, "delivered": 300, "read": 139 },
  "metrics": {
    "notifiedFirstMinute": 60,
    "readCount": 139,
    "carsStartedInVain": 20,
    "isuTimeToT2": 10.2,
    "kerbPeak": null
  }
}
```

This is simulation evidence, not evidence of real handset delivery or traffic improvement. All 300 delivered messages above are twin simulations; the 15 unbound Telegram attempts are logged as dry-run and excluded from delivered. Reads continue asynchronously, so completion-time totals depend on the demo's pause setting. `isuTimeToT2=10.2` is the explicitly scripted fixture in minutes; car count is the documented synthetic nonacting-agent proxy. `kerbPeak` stays unknown.

Realism checks: `read ≤ delivered ≤ sent` for every role, one first-minute endpoint per chat across multiple role subscriptions, first-minute reach bounded by reached endpoints, log-normal median close to six simulated minutes over 10,000 seeded draws, speed applied once, acting draw near 48%, no negative/NaN twin metrics, and reported Unity car counts take precedence over the fallback proxy. Tests also cover all **100 role × situation × language** renderings with no placeholders or SMS URLs; no channel send or Waze closure before confirmation; approval/read idempotence; flight matching; wave order and off switch; RO-Alert draft only; subscriber expiry; Telegram polling and callback ownership; HTTP/CORS/WS routes; SMSLink success parsing; OpenSky fallback; Wallet rate cap; and persisted pending simulation reads.

Files:

- `package.json`, `package-lock.json`, `.nvmrc`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- `src/server.ts`, `src/engine.ts`, `src/types.ts`, `src/messages.ts`
- `src/channels/types.ts`, `telegram.ts`, `sms.ts`, `whatsapp.ts`, `webpush.ts`, `wallet.ts`, `waze.ts`, `roalert.ts`
- `src/data/flights.ts`
- `scripts/demo.ts`
- `tests/engine.test.ts`, `tests/http.test.ts`, `tests/channels.test.ts`
- `README.md`, this report
- Runtime-only ignored `data/state.json`; no subscriptions or credentials are intended for Git.

Not live-verified: real Telegram handset delivery (no bot token supplied), SMSLink/WhatsApp delivery (no credentials supplied), live FIDS schedule (airport site unavailable). Telegram/SMSLink/WhatsApp request/response behavior is tested with mocks. Schedule is clearly labelled illustrative fixture, 21 departures/week. Web push and Wallet are stubs as documented; Waze is a simulated feed, never published; RO-Alert is a draft, never sent. WhatsApp templates/webhooks, authenticated dispatcher access, and the Unity A/B experiment remain outside this backend delivery.

Temporary verification logs and isolated state live under `/tmp/control-tower-*`. My verification processes on 8788 were stopped. The pre-existing 8787 process was left running.

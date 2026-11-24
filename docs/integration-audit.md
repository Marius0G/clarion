# Integration audit: does vision's data reach every consumer? (1 Nov, night)

Checked on `origin/main` by reading the code and running the worker suite, first at a477892 and again after Bogdan's D28/D29 console rework (10a8753…f84cab8). Vision sends `flow.report`, `crowd.positions`, `evac.plan` and now `camera.frame` (`vision/clarion_vision/service.py`). The worker accepts all of them (`backend/src/engine.ts:21`, `worker/src/index.ts`).

Status: **works** = wired end to end. **Partly** = wired, but with a gap that shows in the demo. **Missing** = not built. **Fixed** = was a gap; the commit is named.

## Dashboard (D16, D20, D27, D28)

| Feature | Status | Evidence |
|---|---|---|
| Zones coloured by load (D20 rule, cameras only) | works | `app/src/console/opsZones.ts` `loadState`, `OpsDashboard.tsx` `views` → `TerminalMap` |
| Count, lanes, wait per zone | works | hover card and zone panel in `OpsDashboard.tsx`; the zone list in the rail (D28) |
| People seen by cameras as dots (`crowd.positions`, G/U/X) | works | `opsZones.ts` `liveDots` (only while `sim.vision`) |
| "necunoscut" for unseen or stale zones | works | `opsZones.ts` `liveRow` drops stale rows and rows with `coverage: 0` |
| Advice from the forecast (A7) | works | rail "Recomandare" card plus the zone panel row (`zoneLine`: `advice.lanes`/`by`, fallback from the forecast) |
| Admin alerts (D32) | works | since f4b7325: `AlertList` in the rail, alarms on the map |
| Command log | works | since 10a8753: the rail's "Jurnal" |
| Accuracy panel (vision vs `truth.report`) | fixed (db06f18) | it was unreachable (settings aside gone in 04f8cd6, then removed). Now a small "Acuratețe" rail card (`AccuracyCard.tsx`), a separate commit Bogdan can move or revert. |
| Staff report pins on the map | fixed (9108991) | pins were filtered to the highlighted floor, so a ground-floor report (beat 4) had no pin. Markers now carry their level. |
| Report ETA on the dashboard | fixed (9108991) | `etaMin` (stored by the worker) now shows in the pin label and the journal |
| Live camera feeds with detections | fixed (9128092) | "Camere" rail section (`CameraStrip.tsx`), fed by `camera.frame` → `GET /cams` (85f14e8) |

## WhatsApp tools (D15, D5b)

| Feature | Status | Evidence |
|---|---|---|
| `queues` / `whenToArrive` use vision's live waits and forecast | fixed (b13a991) | `worker/src/wa/tower.ts` passed stale rows too, so a dead feed's last numbers were quoted as "acum"/"prognoză". It now passes only fresh rows. |
| Forecast at the hour he gets there | works | `worker/src/wa/tools.ts` `waitAt` interpolates `forecast` |
| Fallback to the same-hour history mean without vision (D5b) | missing | without rows, `waitAt` uses fixed defaults ("estimare standard"). No per-hour history exists (`backend/src/sim.ts` keeps 30 min, for `peak` only). Left for Bogdan. |
| `routeTo` with live density (A8) | works | `tools.ts` `routeTo`, `zoneDensities(view.flow())` |
| `routeTo exit` during an evacuation uses `evac.plan` | fixed (696d4d5) | while zones are blocked it returns the latest plan's route for the passenger's estimated place (`Messaging.evacRouteFor`, stored as `msg:evacPlan`) |
| Evacuation routes pushed per estimated node (A10) | works | `messaging.ts` `plan` + `routeFor` + `affectedByEvacuation` (the D31 partial-evac fix), `agent.route` for sim agents |
| Generic evacuation message when no plan arrives in 3 s | partly | `messaging.ts` `evacuate` sends it to all subscribers, not just the affected ones |
| `/m/<token>` during an evacuation | partly | `passenger()` returns only `{ active, zones }`, no route (D33). `msg:evacuation` is cleared only by reset, not on all clear. |

## Alerts to passengers and staff (D15, D22, D11)

| Feature | Status | Evidence |
|---|---|---|
| First situation after START / sim register | works | `messaging.ts` `arrive` |
| Update when the A6 estimate moves by 10 min or more (D22's replacement for "e timpul să pleci") | works | `messaging.ts` `flowChanged`, run on every `flow.report` |
| Timed "e timpul să pleci" with a travel-time setting (D15) | missing on purpose | D22 drops "pleacă acum"; the update above covers it |
| Flight changes (delay, cancellation) | works | `messaging.ts` `flightsChanged` |
| Admin decisions that affect him (close, redirect, evacuation) | works | `messaging.ts` `adminChanged` (his queues or gate only) |
| Staff report confirmation with the team's ETA (D11, A8) | works | `tools.ts` `reportIssue` (route from `team_post`, density-penalised) |

## Also found

- `npm run build` in `app/` failed on main: `tests/alerts.unit.ts` → `console/alerts.ts` → a type import from `TerminalMap.tsx`, and `tsconfig.node.json` had no `jsx` (TS6142). Fixed in 4e8f6d1.
- The worker's Miniflare tests fail with HTTP 500 when the checkout path is long (Durable Object files over the Windows path limit). Run them from a short path.

## Left for Bogdan

The D5b same-hour history fallback, the route on `/m/<token>` during an evacuation, clearing `msg:evacuation` on all clear, and the generic evacuation fallback going to everyone. Also where the Camere and Acuratețe cards sit in the rail (at 1080p with two alerts, Acuratețe is below the fold).

## Bogdan's parts against the spec and the pitch (1 Nov, morning)

Checked on 386b3bf by reading the code and running every suite (worker 213/213, app vitest 93/93 + lint + build, Playwright 32/32 with Edge). **Fixed** names the commit from this pass.

| Feature | Status | Evidence |
|---|---|---|
| D2 WhatsApp harness: signature, 200 then `waitUntil`, read + typing, reactions, bubbles, dedupe, 24h window, allowlist, `redact` | works | `worker/src/wa/index.ts:79-131`, `agent.ts:12-14` (sonnet/haiku), `transport.ts` |
| D3 login: OTP, session, single-use link, reverse `LOGIN` | works | `backend/src/auth.ts`, `worker/src/index.ts:282` |
| D3 "Continuă cu Google" | missing | `app/src/join/SignIn.tsx:115` is a TODO |
| D4/D21 Wallet card, demo boarding pass, `wa.me` START link | works | `app/src/join/WalletButton.tsx`, `DemoBoardingPass.tsx`, `backend/src/wallet.ts` |
| D5/A6 entrance-to-gate estimate from vision's forecast | works | `worker/src/wa/tools.ts` `arrivalPlan` + `waitAt` (forecast interpolated at the hour he gets there) |
| D5b same-hour history fallback without vision | fixed (e9f677e) | `worker/src/wa/history.ts`, `tools.ts` `waitAt(..., past)` |
| D6b route image in WhatsApp | partly | the `/m/<token>` link is sent, no static image (`tools.ts` `routeTo`) |
| D9 stage from the clock only | works | `messaging.ts` `estimateStage` |
| D10/D12 decisions: +1/−1 lane, evacuate, redirect, close/open | works | `OpsDashboard.tsx` zone panel → `worker/src/index.ts` `/api/ops/command` |
| D11 staff report, team ETA (A8) | works | `tools.ts` `reportIssue`, pins and journal in `OpsDashboard.tsx` |
| Pitch: airport police ETA on staff reports | fixed (e9f677e, 386b3bf) | `tools.ts` `POLICE_POSTS`, pin label "poliția în ~N min" |
| D14/D18-3 delay and cancellation messages | works | `messaging.ts` `flightsChanged` |
| D15 tools `myFlight`, `whenToArrive`, `queues`, `routeTo`, `reportIssue` | works | `tools.ts` `toolsFor` |
| Pitch: walk from security to the gate said explicitly | fixed (e9f677e) | `texts.ts` `fromSecurity` in the situation and in `routeTo` |
| D17 sim subscribers, `agent.message`, `agent.route` | works | `messaging.ts` `registerSims`, `plan` |
| D18 four beats end to end | works | `worker/test/e2e-chain.test.ts` |
| D20/D28/D29/D32 console: states, rail, alerts, journal | works | `OpsDashboard.tsx`, `alerts.ts` |
| Acuratețe card visible at 1080p and 1536×960 | fixed (386b3bf) | rail order Recomandare, Acuratețe, Alerte, Camere; `app/tests/smoke.spec.ts` checks it fits |
| D22/D25 tone, emoji only on non-urgent | works | `agent.ts` prompt, `urgency.ts` |
| D23 language | works | `texts.ts`, lab `languageSwitch` |
| D24 reset | works | `worker/src/index.ts:142`, `npm run demo:reset` |
| D31 partial evacuation targets only the affected | fixed (d4f4595) | `messaging.ts` `evacuate` fallback now uses `affectedByEvacuation` like `plan` |
| D31 close code 1006, `SIM_SPEED` 10 | works | `worker/src/websocket-close.ts`, `wrangler.toml` |
| D33 `/m/<token>` exit route during an evacuation | fixed (d4f4595) | `messaging.ts` `evacuationFor`, `app/src/me/Me.tsx` |
| `msg:evacuation` cleared on all clear, "Terminalul s-a redeschis" message | fixed (d4f4595) | `messaging.ts` `allClear` (open on the last blocked zone) |
| Pitch: people on the road told not to come and how long to wait | fixed (d4f4595) | `copy.evacuationRoad`: evac.plan `clearSec` + 20 min |
| Pitch: landing page with «Abonează-te» | fixed (4260e85) | `app/src/landing/Landing.tsx` at `/`; console moved to `/console` |
| Pitch: arrivals in the arrival estimate | not used | vision's forecast is departures only; no wording claims arrivals |

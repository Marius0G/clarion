# Integration audit: does vision's data reach every consumer? (1 Nov, night)

Checked on `origin/main` by reading the code and running the worker suite, first at d1c00e5 and again after Bogdan's D28/D29 console rework (7c7b37c…9919263). Vision sends `flow.report`, `crowd.positions`, `evac.plan` and now `camera.frame` (`vision/clarion_vision/service.py`). The worker accepts all of them (`backend/src/engine.ts:21`, `worker/src/index.ts`).

Status: **works** = wired end to end. **Partly** = wired, but with a gap that shows in the demo. **Missing** = not built. **Fixed** = was a gap; the commit is named.

## Dashboard (D16, D20, D27, D28)

| Feature | Status | Evidence |
|---|---|---|
| Zones coloured by load (D20 rule, cameras only) | works | `app/src/console/opsZones.ts` `loadState`, `OpsDashboard.tsx` `views` → `TerminalMap` |
| Count, lanes, wait per zone | works | hover card and zone panel in `OpsDashboard.tsx`; the zone list in the rail (D28) |
| People seen by cameras as dots (`crowd.positions`, G/U/X) | works | `opsZones.ts` `liveDots` (only while `sim.vision`) |
| "necunoscut" for unseen or stale zones | works | `opsZones.ts` `liveRow` drops stale rows and rows with `coverage: 0` |
| Advice from the forecast (A7) | works | rail "Recomandare" card plus the zone panel row (`zoneLine`: `advice.lanes`/`by`, fallback from the forecast) |
| Admin alerts (D32) | works | since 04c84de: `AlertList` in the rail, alarms on the map |
| Command log | works | since 7c7b37c: the rail's "Jurnal" |
| Accuracy panel (vision vs `truth.report`) | fixed (f2be774) | it was unreachable (settings aside gone in 7cd82b0, then removed). Now a small "Acuratețe" rail card (`AccuracyCard.tsx`), a separate commit Bogdan can move or revert. |
| Staff report pins on the map | fixed (945dd38) | pins were filtered to the highlighted floor, so a ground-floor report (beat 4) had no pin. Markers now carry their level. |
| Report ETA on the dashboard | fixed (945dd38) | `etaMin` (stored by the worker) now shows in the pin label and the journal |
| Live camera feeds with detections | fixed (f644183) | "Camere" rail section (`CameraStrip.tsx`), fed by `camera.frame` → `GET /cams` (26dd559) |

## WhatsApp tools (D15, D5b)

| Feature | Status | Evidence |
|---|---|---|
| `queues` / `whenToArrive` use vision's live waits and forecast | fixed (2134c64) | `worker/src/wa/tower.ts` passed stale rows too, so a dead feed's last numbers were quoted as "acum"/"prognoză". It now passes only fresh rows. |
| Forecast at the hour he gets there | works | `worker/src/wa/tools.ts` `waitAt` interpolates `forecast` |
| Fallback to the same-hour history mean without vision (D5b) | missing | without rows, `waitAt` uses fixed defaults ("estimare standard"). No per-hour history exists (`backend/src/sim.ts` keeps 30 min, for `peak` only). Left for Bogdan. |
| `routeTo` with live density (A8) | works | `tools.ts` `routeTo`, `zoneDensities(view.flow())` |
| `routeTo exit` during an evacuation uses `evac.plan` | fixed (cc320e4) | while zones are blocked it returns the latest plan's route for the passenger's estimated place (`Messaging.evacRouteFor`, stored as `msg:evacPlan`) |
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

- `npm run build` in `app/` failed on main: `tests/alerts.unit.ts` → `console/alerts.ts` → a type import from `TerminalMap.tsx`, and `tsconfig.node.json` had no `jsx` (TS6142). Fixed in edcf47d.
- The worker's Miniflare tests fail with HTTP 500 when the checkout path is long (Durable Object files over the Windows path limit). Run them from a short path.

## Left for Bogdan

The D5b same-hour history fallback, the route on `/m/<token>` during an evacuation, clearing `msg:evacuation` on all clear, and the generic evacuation fallback going to everyone. Also where the Camere and Acuratețe cards sit in the rail (at 1080p with two alerts, Acuratețe is below the fold).

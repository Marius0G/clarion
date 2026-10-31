# Clarion Node backend

Node 22, TypeScript, HTTP and WebSocket. [SPEC-v2](../docs/SPEC-v2.md) is the product and Unity/vision contract.

```sh
npm ci
npm run build
npm test
npm run dev
# In another terminal:
npm run demo:terminal
```

Configure `PORT` (8787), `STATE_FILE`, `SIM_SPEED` (60), `SIM_SEED` and optional `DEMO_TOKEN` in the environment. Copy `.env.example`; credentials stay local. The entry point also loads the root `.env` without overriding exported values.

`GET /health` returns `{ "ok": true, "service": "clarion" }`. `/api/state` and `/api/aircraft` provide state and flight data. `POST /api/subscribe` requires role, channel `whatsapp`, language and consent, returning `{ subscriptionId }`. Public state excludes private destinations.

Unity connects to `/ws?client=twin`, vision to `client=vision`; console and viewer roles remain. The engine handles sim status, agent registration/batches/updates, metrics, flow, truth, flights, crowd positions and ops acknowledgements. Camera estimates remain separate from truth. `GET /api/sim` and `/api/sim/agents` read ephemeral telemetry; POSTs to `/api/sim/command`, `/api/ops/command` and `/api/agent/route` target connected producers. With `DEMO_TOKEN`, operator HTTP calls require Bearer authentication and non-viewer sockets require `?token=`. `console.reset` preserves real subscriptions.

WhatsApp GET/POST callbacks use `/webhooks/whatsapp`. The sender uses `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`; verification uses `WHATSAPP_VERIFY_TOKEN`. Confirmation and evacuation templates live in `src/channels/whatsapp-catalog.ts` and `../whatsapp/templates.json`. Provider acceptance is tracked by ID; webhook receipts advance delivery/read counts. The Worker adds signature verification and the passenger agent.

`POST /api/wallet/pass { subscriptionId }` requires an active subscription. Configure `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SA_EMAIL` and `GOOGLE_WALLET_SA_KEY` for signed save JWTs; otherwise it returns a demo URL. Wallet retains OAuth, status PATCHes and a three-attempt per-pass UTC daily notification budget. Pass registrations and counters persist separately. The removed incident lifecycle no longer triggers updates.

Node file persistence is installed by `src/node-runtime.ts`; direct consumers using `new Engine({ file })` must import it first. Workers use Durable Object storage and must not import the Node entry point. Telemetry disappears on restart; producers resend it.

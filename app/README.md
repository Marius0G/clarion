# Clarion app

React and Vite frontend for [SPEC-v2](../docs/SPEC-v2.md).

- `/`: admin dashboard, terminal map, camera queues, accuracy, reports and ops decisions.
- `/join`, `/join/qr`: WhatsApp entry, boarding-pass scanning, sharing and Wallet component.
- `/m/<token>`: passenger page.

Run `npm ci`, `npm run dev`, `npm run lint`, `npm run build`, `npx vitest run` and `npm test` (Playwright). The fake terminal feed is backend's `npm run demo:terminal`.

Configure `VITE_BACKEND_HTTP`, `VITE_BACKEND_URL`, `VITE_DEMO_TOKEN` and `VITE_PUBLIC_URL`, or use the persisted `?backend=<HTTP origin>` override.

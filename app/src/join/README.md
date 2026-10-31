# Join integration

Routes: `/join`, `/join?src=jury`, `/join/qr`.

- `VITE_BACKEND_HTTP`: HTTP API origin, default `http://localhost:8787`.
- `VITE_PUBLIC_URL`: publicly reachable frontend origin for QR/share URLs; defaults to the current origin. Set before building. A localhost QR cannot reach a laptop from a jury phone.
- `GET /api/state`: flight datalist uses `flights[].flight`, `city`, `sched`. Optional capability extension: `channels.sms` / `channels.whatsapp` must be `true` or `{ enabled: true }`. Missing flags keep both off. Telegram is the primary channel.
- `POST /api/subscribe`: contract fields plus optional `date` from a scanned pass (supported by the current backend implementation), and `destination` for enabled SMS/WhatsApp. Parsed route is shown locally; backend currently derives route from its flight schedule. No name, PNR, raw barcode or image is submitted or persisted by this frontend.
- Telegram opens in a tab reserved during the submit gesture, preserving the passenger share screen. If popups are blocked, the success screen provides an activation link. The subscriber must press Start in Telegram; a returned subscription ID alone does not mean alerts are active.
- Passenger maps to `passenger_home`; this simplified jury selector does not infer road/terminal context.
- Scanner checks native PDF417/Aztec support and stays hidden otherwise. Camera needs a secure context (HTTPS or localhost). Images and live frames are decoded locally. Only the first BCBP leg is used. BCBP has no year in its mandatory flight-date field: nearest-year inference is labeled and editable.
- Subscription expiration and deletion belong to the backend; this frontend cannot verify or enforce its 48-hour retention promise.

Tests: `tests/join.unit.ts`, `tests/join.spec.ts`. The main browser test writes `PM/screens/w4-join.png` at 390 × 844. API responses and barcode detection are mocked; real Wizz boarding-pass decoding, Telegram delivery and the human ten-second target need a phone rehearsal.

BCBP field reference: https://www.iata.org/contentassets/1dccc9ed041b4f3bbdcf8ee8682e75c4/2021_03_02-bcbp-implementation-guide-version-7-.pdf

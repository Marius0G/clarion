# Join integration

`/join` offers WhatsApp with explicit consent and optional flight entry or boarding-pass scanning. It opens the existing first-message link; no subscription is created until the passenger sends it. `/join/qr` renders the public entry URL. Sharing preserves the flight and backend override.

Scanning runs locally with native PDF417/Aztec support; name, PNR, raw barcode and images are never submitted. The first leg is used and nearest-year date inference remains editable. `WalletButton` posts only an active subscription ID to `/api/wallet/pass`. Configure `VITE_PUBLIC_URL` for QR/share links reachable on phones.

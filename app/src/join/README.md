# Join integration

`/join` provides WhatsApp LOGIN, phone OTP, single-use login links, an optional flight, and Romanian/English copy. Without a flight, WhatsApp opens with START. With a flight, `/api/join` returns a single-use token and WhatsApp link. The language choice travels with the token. `/join/qr` displays the public entry link; sharing preserves the flight and backend override.

Boarding pass scanning supports camera, screenshot, and manual entry. Barcode processing stays on the phone and submits only flight metadata. The flight date is editable. Boarding pass generation returns a PDF417 barcode, a WhatsApp link, and a Wallet link.

`WalletButton` posts the join token or subscription ID to `/api/wallet/pass`. Configure `VITE_PUBLIC_URL` for public QR and share links. Logout clears local session and sign-in state, including when the request fails.

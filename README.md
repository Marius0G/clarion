# Clarion

Crowd control pentru Aeroportul Craiova. Clarion urmărește aglomerația din terminal prin camere și o transformă în trei lucruri:

- **Pentru pasageri, pe WhatsApp:** la ce oră să fie la intrarea în terminal, cât se stă la check-in, la securitate și până la poartă, schimbările zborului lor și, în criză, ruta de ieșire.
- **Pentru angajați:** raportează o problemă în cuvinte simple și află în cât timp ajunge echipa de intervenție.
- **Pentru admin:** un singur ecran cu harta terminalului, oamenii, cozile și deciziile directe (deschide o linie, evacuează o zonă).

Proiect pentru provocarea CONTROL TOWER, Craiova Hackathon 2026. Specul echipei: [`docs/SPEC-v2.md`](docs/SPEC-v2.md).

## Cum funcționează

```
Unity 3D: terminalul, oamenii, camerele virtuale (mediul)
   │ imagini de la camere                          ▲ deciziile adminului, rute, mesaje
   ▼                                               │
Serviciul de vision (Python): oameni detectați, cozi, timpi, prognoză, evacuare
   │ flow.report, crowd.positions, evac.plan
   ▼
Backend (Cloudflare Worker + Durable Object) ──▶ ecranul adminului, pagina pasagerului, WhatsApp
```

Clarion lucrează ca un sistem real: vede terminalul doar prin camere, plus orarul zborurilor și deciziile adminului. Simularea Unity e doar mediul. Ea știe adevărul exact (cozile și timpii reali), pe care îl trimite separat, numai ca să măsurăm cât de corecte sunt estimările și cât ajută Clarion. Adevărul nu intră niciodată în decizii, rute sau mesaje.

## Algoritmi

Detecție YOLO pe imaginile camerelor, cu o corecție învățată pentru cozile dense; un filtru Kalman pe fiecare zonă, pentru număr și flux; așteptarea calculată din oamenii din coadă și viteza liniilor deschise; prognoza la 30–120 de minute din orarul zborurilor și un model de coadă; timpul de evacuare și împărțirea pe ieșiri dintr-un flux maxim pe graful terminalului. Modelele ML sunt antrenate pe zile simulate, în care știm adevărul.

Detalii: [`docs/SPEC-v2.md`](docs/SPEC-v2.md), secțiunea „Algoritmi”.

## Starea la 31 octombrie, seara

Proiectul a trecut sâmbătă după-amiază de la alerte la crowd control. Ce e în repo acum:

| Piesă | Stare |
|---|---|
| Ecranul adminului (harta terminalului, zone, decizii) | în lucru, pe pagina principală |
| Abonarea pe `/join`, cu boarding pass și Google Wallet | în lucru |
| Agentul WhatsApp | în lucru, portat din proiectul Moni (vezi mai jos) |
| Backend: Worker, WebSocket pentru Unity și vision, comenzile către Unity | în lucru |
| Serviciul de vision și algoritmii | în lucru |
| Legătura Unity ↔ backend | în lucru |

Tabelul se actualizează până la predarea finală, duminică la 15:00.

## Demo

| Ecran | URL |
|---|---|
| Ecranul adminului | https://clarion-craiova.pages.dev |
| Abonare pasager | https://clarion-craiova.pages.dev/join |

WhatsApp folosește un număr de test Meta, **+1 555 631 8672**, care trimite doar către numerele adăugate în consola Meta. De aceea, demo-ul de pe scenă se face pe telefoanele echipei.

## Local

Node **22.12+**, din seria 22, și npm. Din rădăcina repo-ului, în terminale separate:

```sh
(cd backend && npm ci && npm run dev)            # backend pe http://localhost:8787
(cd app && npm ci && npm run dev)                # ecranul adminului pe http://localhost:5173
(cd backend && npm run demo:terminal)            # un Unity fals, ca ecranul să aibă date fără simulare
```

Fără credențiale, canalele reale rulează în mod dry-run. Configurarea e în [backend/README.md](backend/README.md) și [worker/README.md](worker/README.md). Secretele stau doar în Cloudflare și în `.env` local, niciodată în repo.

## Structura

| Folder | Ce conține |
|---|---|
| `app/` | Frontend React: ecranul adminului, `/join`, harta |
| `backend/` | Backend Node pentru rulare locală, cu același motor ca Worker-ul |
| `worker/` | Backend-ul public pe Cloudflare (Worker + Durable Object) |
| `vision/` | Serviciul de vision (Python): camere, cozi, prognoză, evacuare |
| `whatsapp/` | Template-urile WhatsApp |
| `docs/` | Specul, algoritmii și materialele de pitch |

Simularea Unity 3D și camerele virtuale sunt într-un repo privat, pentru că folosesc imagini de la terți. Istoricul lui se poate arăta organizatorului la cerere.

## Ce exista înainte

- **WhatsApp și login:** stratul WhatsApp (webhook, agent, mesaje) și autentificarea cu telefon și Google sunt portate din Moni, proiectul lui Bogdan de la Nexxt 2026 (repo privat), și adaptate pentru Clarion.
- **Modele și biblioteci:** YOLO (Ultralytics, AGPL-3.0), ByteTrack, LightGBM și restul dependențelor din `package.json`. Nu sunt creația echipei.
- **Date publice:** geometria din OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0) și numărul de pasageri din Eurostat (577.693 în 2025).

Restul codului a fost scris în timpul evenimentului; vezi istoricul commit-urilor.

## Confidențialitate

- Camerele produc doar numărători, fluxuri și puncte anonime pe hartă. Nu recunoaștem fețe și nu urmărim persoane de la o cameră la alta.
- Abonarea cere acordul pasagerului. Scannerul citește boarding pass-ul în browser; imaginea nu se trimite backend-ului.
- Nu punem în repo numere de telefon, capturi cu date personale sau fișiere `.env`. Datele de test se șterg după eveniment.

Repo-ul nu are încă un fișier LICENSE, deci publicarea nu acordă o licență pentru cod.

## Termene

Sâmbătă, **31 octombrie, 22:00**: repo public, înregistrat în UserHub. Duminică, **1 noiembrie, 15:00**: cod final, apoi pre-pitch și pitch.

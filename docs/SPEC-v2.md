# Clarion v2: crowd control pentru aeroport

Status: în lucru, deciziile se adaugă pe măsură ce le stabilim (grill 31 oct). Când e gata, înlocuiește `docs/SPEC.md`.

## Produsul

Nu știi niciodată cu cât timp înainte să pleci spre aeroport. Clarion măsoară aglomerația din aeroport (camere + vision model; în demo, simularea Unity) și o transformă în:

- **Pasageri, pe WhatsApp:** când să plece spre aeroport, cât durează check-in, securitate, drumul până la poartă și bagajele, întârzieri și anulări, iar în criză ruta de ieșire după locul în care se află.
- **Angajați:** semnalează probleme și văd în orice moment în cât timp ajung autoritățile la ei.
- **Admin:** un singur dashboard de crowd management.

## Owneri

- **Marius:** algoritmi, Unity, simulare.
- **Bogdan:** backend, dashboard, WhatsApp, Wallet, login.

## Decizii

### D1. Pivot, nu rewrite
Păstrăm Worker-ul cu Durable Object, WebSocket-ul pentru Unity, `flow.report` (check_in, bag_drop, security, arrivals_hall, taxi_rank, kerb), dashboard-ul pe zone și deploy-ul. Construim ce lipsește. Ies din demo: valurile, Telegram și numărătorile T2.

### D2. WhatsApp: portăm stratul din Moni (Nexxt 2026), neschimbat
Sursa: `Bogdan-ca/Moni`, `src/whatsapp.js`, `src/core.js`, `src/agent/`, `src/contracts.js`. Aceeași aplicație Meta, același număr (`+1 555 631 8672`), token și app secret. Moni s-a încheiat, așa că numele afișat și poza devin „Clarion”.
- Webhook-ul Meta e mutat pe `https://clarion-backend.bogdan-c-2206.workers.dev/webhooks/whatsapp`.
- Se păstrează: verificarea `X-Hub-Signature-256`, răspunsul 200 imediat și apoi `ctx.waitUntil`, read receipt + typing, reacții, bule cu pauză de 800 ms, deduplicarea după wamid, fereastra de 24h (`wa:last:<phone>`), `WA_ALLOWLIST`, `redact()`.
- Agentul rămâne pe Claude (`claude-sonnet-5-5` pentru răspuns, `claude-haiku-5-5` pentru tool-uri), cu tool-urile Clarion în locul celor de bani.
- Stratul vechi din Clarion (`backend/src/channels/whatsapp.ts` + catalogul de template-uri) se păstrează doar pentru alertele trimise în afara ferestrei de 24h.
- Limită: numărul e de test Meta, deci trimite doar către numerele adăugate în consolă. Demo-ul de pe scenă se face pe telefoanele echipei.

### D3. Login: portăm sistemul din Moni
- Cont = număr de telefon (E.164, `normalizePhone`). OTP de 6 cifre, valabil 5 min. Sesiune `sid:<token>` de 90 de zile în cookie.
- Link de o singură folosință trimis din WhatsApp (`link:<token>` → telefon, 15 min), ca pasagerul să deschidă pagina deja logat.
- Google OAuth (din `src/gmail.js`), cu scope `openid email profile` în loc de `gmail.readonly`: „Continuă cu Google” pe `/join` preia numele și emailul.
- Extensia de browser: login-ul ei (`auth:signin`, `auth:status`, `auth:signout`) se portează la fel. **De clarificat la ce folosește extensia în Clarion.**

### D4. Wallet: boarding pass + intrarea în WhatsApp
Pe `/join` pasagerul se loghează (Google sau telefon) și salvează cardul Clarion în Google Wallet, cu zborul lui. Cardul are un link `wa.me/15556318672?text=START <zbor> <token>`. La primul mesaj, backend-ul leagă telefonul de zbor prin token și deschide fereastra de 24h, în care putem trimite text liber fără template-uri aprobate.

### D5. Doar aeroportul, fără drumul până la el
Clarion nu calculează drumul până la aeroport. Răspunsul pentru pasager e „fii la intrarea în terminal la ora X”, iar drumul și-l planifică el. Ora X = ora de închidere a porții − (check-in/bag drop dacă are bagaj de cală + securitate + mers până la poartă + marjă), cu fiecare timp luat din prognoza pentru ora la care ajunge.

### D6. Hărți și istoric
- **Hărți:** planul terminalului de la Craiova, folosit în dashboard și trimis pe WhatsApp (rute până la poartă și de evacuare). Sursa geometriei: vezi D7.
- **Istoric:** backend-ul păstrează seriile de timp pe zonă (`waiting`, `waitMin`) și pe zbor (status, întârziere, poartă), ca dashboard-ul să arate evoluția și pasagerul să primească „acum 20 min, astăzi la ora asta coada era…”.

### D6b. Hărți: web pentru hartă, WhatsApp pentru conversație
WhatsApp nu poate afișa o hartă interactivă. Mesajul conține o imagine statică (previzualizare) și un link personal `/m/<token>`, care deschide harta interactivă pe web, deja logat (vezi D3).
- **Harta porții:** pentru fiecare poartă, traseul de la intrare prin check-in și securitate până la poartă, cu timpul pe fiecare segment.
- **Harta de evacuare:** cea mai bună ieșire față de locul în care se află pasagerul, trimisă automat tuturor în caz de criză.
- **Timpii:** apar peste tot, adică în dashboard, pe pagina web a pasagerului și în WhatsApp.
- Pe WhatsApp se poate și vorbi cu agentul (D2), iar web-ul arată hărțile și timpii.
- Mulțimea din terminal e simulată de Marius în Unity.

### D5b. Prognoza (implicit, de confirmat cu Marius)
Marius adaugă în `flow.report`, pe fiecare zonă, `forecast: [{ inMin: 30|60|90|120, waitMin }]`, calculat de algoritmul lui din orarul zborurilor. Backend-ul folosește ultima prognoză primită. Fără Unity, folosește media din istoric pentru aceeași oră.

### D8. Check-in și bag drop pe companie aeriană
Coada de check-in și cea de bag drop se raportează separat pentru fiecare companie, după codul IATA. Pasagerul vede doar coada companiei lui, iar dashboard-ul le arată pe toate. Asta schimbă `flow.report`: `zone` poate fi `check_in:<IATA>` / `bag_drop:<IATA>` (de exemplu `check_in:W6`). Lista companiilor vine din orarul de zboruri din Unity (vezi contractul).

### D7. Planul terminalului: îl face Marius, îl desenează Bogdan
Doar interiorul terminalului. Exteriorul și drumul sunt treaba pasagerului (D5).
- Marius exportă din Unity `terminal.json`, în metri, văzut de sus: poligoanele zonelor, nodurile (intrări, ghișee de check-in pe companie, securitate, porți, ieșiri de urgență) și muchiile cu timpul de mers în secunde. Id-urile nodurilor și zonelor sunt aceleași cu cele din `flow.report`.
- Bogdan desenează din el harta SVG (dashboard și web) și calculează rutele în backend: cel mai scurt drum, penalizat de aglomerația live, cu zonele blocate excluse în criză (implicit, de confirmat).
- Rutele trimise pasagerilor ajung și în Unity, ca agenții simulați să meargă pe ele.

### D9. Locul pasagerului: dedus din etapă, nimic altceva
- Pe `/join`, pasagerul scanează boarding pass-ul pe web (camera, PDF417/BCBP) sau îl încarcă. Din cod reiese zborul, data, compania, numele și locul. Poarta și ghișeul de check-in vin din orarul de zboruri (Unity), nu din boarding pass.
- Clarion îi spune automat ghișeul companiei lui (D8) și poarta, cu ruta pe hartă (D7), fără ca pasagerul să întrebe.
- Locul în terminal se deduce din etapă (înainte sau după securitate, la poartă). În lumea reală nu avem scanarea de la securitate a aeroportului, deci etapa se estimează din oră față de orarul zborului. În demo, Unity trimite etapa fiecărui agent cu telefon. Nu există butoane de locație, QR pe pereți sau GPS.

### D10. Adminul ia decizii operaționale, nu „declară criza”
Unity trimite date (cozi, poziții, etape) și nu propune nimic. Un buton „criză” fără efect nu există. Adminul vede datele și ia decizii concrete, care schimbă ce se întâmplă în terminal: suplimentează personalul la bag drop sau la securitate, deschide linii, redirecționează, evacuează. Fiecare decizie ajunge în Unity, iar simularea arată efectul (vezi contractul). Decizii posibile:
- **Personal / linii:** suplimentează câți oameni lucrează la o zonă (check-in pe companie, bag drop, securitate); capacitatea crește, coada scade.
- **Evacuare:** marchează zonele blocate, iar fiecare pasager primește ruta spre cea mai apropiată ieșire liberă (D7, D9).
- **Aglomerare:** redirecționează pasagerii către alt punct (altă linie de securitate, alt ghișeu).
- **Zbor întârziat sau anulat:** mesaj doar pentru pasagerii acelui zbor.
Fluxul vechi cu drona și `ops.suspended` iese din proiect.

### D11. Angajații: același WhatsApp, rolul staff
- Rolul `staff` se setează la login. Angajatul scrie liber („bătaie la poarta 3”, „bagaj abandonat lângă check-in Wizz”), iar agentul AI extrage locul exact (nod din `terminal.json`) și tipul problemei, apoi o transmite în dashboard, pe hartă.
- Angajatul primește confirmarea și timpul în care ajunge echipa internă de intervenție: rută de la postul echipei până la el, penalizată de aglomerație (D7). Fără autorități din exterior.
- Adminul reacționează cu deciziile din D10.
- În demo, angajatul e jucat de un om de pe scenă cu telefonul (implicit).

### D12. Contract: deciziile adminului către Unity
Backend → Unity, pe WebSocket-ul existent: `ops.command { id, type, ... }`. Exact patru tipuri:
- `staff { zone, delta }`: crește sau scade numărul de oameni la o zonă (`security`, `bag_drop:W6`, `check_in:W6`). Cât crește rata de procesare per om decide algoritmul lui Marius.
- `redirect { from, to }`: o parte din cei care ar merge la `from` sunt trimiși la `to`.
- `evacuate { zones: [] }`: zonele devin blocate, agenții ies pe rutele calculate de backend (D7).
- `close { zone }` / `open { zone }`.
Unity → backend: `ops.ack { id }` imediat, apoi efectul se vede în `flow.report`. Fără mutare de zbor pe altă poartă: proiectul e strict crowd control.

### D13. Un singur ceas: ora simulării
Simularea rulează accelerat (`SIM_SPEED`), iar Unity e sursa orei, prin `simTime` din `sim.status`. Dashboard-ul, pagina web și WhatsApp afișează ora simulării, etichetată „ora simulării”. Toate zborurile, prognozele și orele trimise pasagerilor („fii la intrare la 14:20”, „poarta se închide la 15:05”) sunt în ora simulării. Ceasul real nu se folosește nicăieri în demo.

### D14. Contract: orarul de zboruri din Unity
Unity → backend: `flight.update { flights: [...] }`, trimis la conectare și apoi la fiecare schimbare. Orarul îl face Marius. Fiecare zbor are:
`{ flight: "W6 3751", airline: "W6", destination, std, gate, checkInDesks: [], gateCloseAt, status, delayMin, pax }`
- `status`: `scheduled` | `boarding` | `delayed` | `cancelled` | `departed`.
- `gate` și `checkInDesks` sunt id-uri de noduri din `terminal.json` (D7). Orele sunt în ora simulării (D13).
- La `delayed` sau `cancelled`, backend-ul trimite automat mesaj pe WhatsApp pasagerilor acelui zbor (D10).

## De stabilit în continuare
- La ce folosește extensia de browser (D3).
- Forma exactă a `terminal.json` și a poziției sau etapei agenților cu telefon.
- Ce scrie pasagerul pe WhatsApp și ce poate întreba agentul (tool-urile Clarion).

### D13. Un singur ceas: ora simulării
Simularea rulează accelerat (`SIM_SPEED`), iar Unity e sursa orei, prin `simTime` din `sim.status`. Dashboard-ul, pagina web și WhatsApp afișează ora simulării, etichetată „ora simulării”. Toate zborurile, prognozele și orele trimise pasagerilor („fii la intrare la 14:20”, „poarta se închide la 15:05”) sunt în ora simulării. Ceasul real nu se folosește nicăieri în demo.

### D14. Contract: orarul de zboruri din Unity
Unity → backend: `flight.update { flights: [...] }`, trimis la conectare și apoi la fiecare schimbare. Orarul îl face Marius. Fiecare zbor are:
`{ flight: "W6 3751", airline: "W6", destination, std, gate, checkInDesks: [], gateCloseAt, status, delayMin, pax }`
- `status`: `scheduled` | `boarding` | `delayed` | `cancelled` | `departed`.
- `gate` și `checkInDesks` sunt id-uri de noduri din `terminal.json` (D7). Orele sunt în ora simulării (D13).
- La `delayed` sau `cancelled`, backend-ul trimite automat mesaj pe WhatsApp pasagerilor acelui zbor (D10).

## De stabilit în continuare
- La ce folosește extensia de browser (D3).
- Forma exactă a `terminal.json` și a poziției sau etapei agenților cu telefon.
- Ce scrie pasagerul pe WhatsApp și ce poate întreba agentul (tool-urile Clarion).

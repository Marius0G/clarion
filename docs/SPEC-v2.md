# Clarion v2: crowd control pentru aeroport

Status: în vigoare din 31 oct și înlocuiește vechiul spec al echipei, șters odată cu proiectul cu drone (pivot confirmat de Marius). Deciziile noi se adaugă aici.

## Produsul

Nu știi niciodată cu cât timp înainte să pleci spre aeroport. Clarion măsoară aglomerația din aeroport (camere + vision model; în demo, camerele virtuale din Unity, vezi D0) și o transformă în:

- **Pasageri, pe WhatsApp:** când să plece spre aeroport, cât durează check-in, securitate, drumul până la poartă și bagajele, întârzieri și anulări, iar în criză ruta de ieșire după locul în care se află.
- **Angajați:** semnalează probleme și văd în orice moment în cât timp ajung autoritățile la ei.
- **Admin:** un singur dashboard de crowd management.

## Owneri

- **Marius:** algoritmii (vision pe camere, cozi, prognoză, evacuare), Unity ca mediu simulat, evaluarea (A/B și acuratețe), video-ul.
- **Bogdan:** backend, dashboard, WhatsApp, Wallet, login.
- **Diana:** business și pitch.

Cristiana nu mai e în echipă. Numărătorul T2, panoul public și persona simulării au fost șterse.

## Decizii

### D0. Unity e doar mediul, Clarion vede doar camerele
Clarion lucrează ca în realitate. Intrările lui sunt doar camerele, orarul de zboruri (în realitate din sistemul aeroportului, în demo din Unity, D14) și deciziile adminului (liniile deschise, D12). Unity e mediul: oamenii, terminalul, camerele virtuale și felul în care oamenii reacționează la mesaje și decizii. Datele exacte din Unity servesc doar ca să măsurăm cât de corectă și de eficientă e soluția și s-o îmbunătățim.
- Serviciul de vision al lui Marius (Python, codul în `vision/` din acest repo, rulat pe PC-ul lui) citește camerele virtuale din Unity, numără oamenii pe zone, calculează timpul de așteptare și prognoza și le trimite backend-ului ca un client separat, `client=vision` (`flow.report`, `crowd.positions`). Unity nu mai trimite `flow.report`.
- Live: YOLO pe 2–4 camere de ansamblu (coada de securitate, check-in, porți). Dacă nu merge live, Unity calculează ce vede fiecare cameră și adaugă zgomot calibrat pe rulările YOLO offline (detector simulat). Contractul cu backend-ul e același în ambele cazuri.
- O zonă pe care nu o vede nicio cameră nu primește o valoare inventată: apare ca „necunoscut”.
- Adevărul din Unity (cozile și timpii reali, etapa fiecărui agent) ajunge în backend doar prin `truth.report`. Backend-ul îl păstrează separat și îl arată doar în panoul de acuratețe (D16) și în A/B (D19). Nu intră în decizii, rute sau mesaje.

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
- Fără extensie de browser: totul e pe site.

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

### D5b. Prognoza: o calculează serviciul de vision
Serviciul de vision (D0) adaugă în `flow.report`, pe fiecare zonă, `forecast: [{ inMin: 30|60|90|120, waitMin }]`, din ce văd camerele, din orarul zborurilor (D14) și din liniile deschise (D12). Unity nu calculează prognoza. Backend-ul folosește ultima prognoză primită. Fără serviciul de vision, folosește media din istoric pentru aceeași oră.

### D8. Check-in și bag drop pe grup de ghișee
Ghișeele de la Craiova sunt comune și se alocă pe zbor, nu pe companie, iar aproape toate zborurile sunt Wizz Air. Unity le grupează deja așa (`checkin_group_N`). Coada se raportează pe grup: `zone` = `check_in:<grup>` / `bag_drop:<grup>` (de exemplu `check_in:2`), iar `flight.update` spune ce grup servește fiecare zbor. Pasagerul vede coada grupului zborului lui, iar dashboard-ul le arată pe toate.

### D7. Planul terminalului: îl face Marius, îl desenează Bogdan
Doar interiorul terminalului. Exteriorul și drumul sunt treaba pasagerului (D5).
- Marius exportă din Unity `terminal.json`, în metri, văzut de sus: poligoanele zonelor, nodurile (intrări, ghișee de check-in pe companie, securitate, porți, ieșiri de urgență) și muchiile cu timpul de mers în secunde. Id-urile nodurilor și zonelor sunt aceleași cu cele din `flow.report`.
- Bogdan desenează din el harta SVG (dashboard și web) și calculează în backend rutele obișnuite (spre ghișeu, poartă, echipa de intervenție): cel mai scurt drum, cu timpul pe fiecare muchie din viteza de mers la densitatea live (A8).
- Rutele de evacuare le calculează serviciul lui Marius (A10) și le trimite în `evac.plan`. Backend-ul doar le distribuie.
- Rutele trimise pasagerilor ajung și în Unity, ca agenții simulați să meargă pe ele.

### D9. Locul pasagerului: dedus din etapă, nimic altceva
- Pe `/join`, pasagerul scanează boarding pass-ul pe web (camera, PDF417/BCBP) sau îl încarcă. Din cod reiese zborul, data, compania, numele și locul. Poarta și ghișeul de check-in vin din orarul de zboruri (Unity), nu din boarding pass.
- Clarion îi spune automat ghișeul companiei lui (D8) și poarta, cu ruta pe hartă (D7), fără ca pasagerul să întrebe.
- Locul în terminal se deduce din etapă (înainte sau după securitate, la poartă). În lumea reală nu avem scanarea de la securitate a aeroportului, deci backend-ul estimează etapa din oră față de orarul zborului, la fel pentru pasagerii reali și pentru cei simulați (D17). Etapa reală a agenților din Unity ajunge doar în `truth.report` (D0), ca să vedem cât de bine o estimăm. Nu există butoane de locație, QR pe pereți sau GPS.

### D10. Adminul ia decizii operaționale, nu „declară criza”
Unity e mediul (D0) și nu propune nimic, iar datele despre cozi și oameni vin din camere. Un buton „criză” fără efect nu există. Adminul vede datele și ia decizii concrete, care schimbă ce se întâmplă în terminal: suplimentează personalul la bag drop sau la securitate, deschide linii, redirecționează, evacuează. Fiecare decizie ajunge în Unity, iar simularea arată efectul (vezi contractul). Decizii posibile:
- **Linii / ghișee:** deschide sau închide linii la o zonă (grup de check-in, bag drop, securitate); capacitatea crește, coada scade.
- **Evacuare:** marchează zonele blocate, iar fiecare pasager primește ruta spre cea mai apropiată ieșire liberă (D7, D9).
- **Aglomerare:** redirecționează pasagerii către alt punct (altă linie de securitate, alt ghișeu).
- **Zbor întârziat sau anulat:** mesaj doar pentru pasagerii acelui zbor.
Fluxul vechi cu drona și `ops.suspended` iese din proiect.

### D11. Angajații: același WhatsApp, rolul staff
- Rolul `staff` se setează la login. Angajatul scrie liber („bătaie la poarta 3”, „bagaj abandonat lângă check-in Wizz”), iar agentul AI extrage locul exact (nod din `terminal.json`) și tipul problemei, apoi o transmite în dashboard, pe hartă.
- Angajatul primește confirmarea și timpul în care ajunge echipa internă de intervenție: rută de la postul echipei până la el, penalizată de aglomerație (D7). Fără autorități din exterior.
- Adminul reacționează cu deciziile din D10.
- În demo, angajatul e jucat de Diana, cu telefonul ei (D18).

### D12. Contract: deciziile adminului către Unity
Backend → Unity, pe WebSocket-ul existent: `ops.command { id, type, ... }`. Exact patru tipuri:
- `staff { zone, delta }`: deschide sau închide linii la o zonă (`security`, `bag_drop:2`, `check_in:2`). `delta` se numără în linii de securitate sau ghișee, nu în oameni: +1 = încă o linie sau încă un ghișeu. Cât procesează o linie decide Unity, care e mediul. Cât e conectat la backend, Unity oprește deschiderea automată a liniilor (`autoSecurityLanes`), ca doar adminul să schimbe capacitatea.
- `redirect { from, to }`: o parte din cei care ar merge la `from` sunt trimiși la `to`.
- `evacuate { zones: [] }`: zonele devin blocate, agenții ies pe rutele calculate de backend (D7).
- `close { zone }` / `open { zone }`.
Unity → backend: `ops.ack { id }` imediat, apoi efectul se vede în `flow.report`. Fără mutare de zbor pe altă poartă: proiectul e strict crowd control.

### D13. Un singur ceas: ora simulării
Simularea rulează accelerat (`SIM_SPEED`), iar Unity e sursa orei, prin `simTime` din `sim.status`. Dashboard-ul, pagina web și WhatsApp afișează ora simulării, etichetată „ora simulării”. Toate zborurile, prognozele și orele trimise pasagerilor („fii la intrare la 14:20”, „poarta se închide la 15:05”) sunt în ora simulării. Ceasul real nu se folosește nicăieri în demo.

### D14. Contract: orarul de zboruri din Unity
Unity → backend: `flight.update { flights: [...] }`, trimis la conectare și apoi la fiecare schimbare. Orarul îl face Marius. Fiecare zbor are:
`{ flight: "W6 3751", airline: "W6", destination, std, gate, checkIn: "check_in:2", checkInDesks: [], gateCloseAt, status, delayMin, pax }`
- `status`: `scheduled` | `boarding` | `delayed` | `cancelled` | `departed`.
- `gate` și `checkInDesks` sunt id-uri de noduri din `terminal.json` (D7). `checkIn` e zona grupului de ghișee care servește zborul (D8). Orele sunt în ora simulării (D13).
- La `delayed` sau `cancelled`, backend-ul trimite automat mesaj pe WhatsApp pasagerilor acelui zbor (D10).

### D15. WhatsApp pentru pasageri: tool-urile agentului
Agentul din Moni (D2) primește cinci tool-uri, toate citite din backend:
- `myFlight`: zbor, poartă, status, ora de închidere a porții (D14).
- `whenToArrive`: „fii la intrare la 14:20”, cu calculul pe etape (D5).
- `queues`: cozile de acum și prognoza, inclusiv check-in-ul companiei lui (D5b, D8).
- `routeTo`: rută spre poartă, ghișeu sau ieșire, ca imagine plus link `/m/<token>` (D6b, D7).
- `reportIssue`: doar pentru rolul `staff` (D11).

Mesaje trimise automat: confirmarea după scanarea boarding pass-ului; „e timpul să pleci”, la ora de intrare minus timpul de drum pe care pasagerul îl setează o dată (implicit 40 min, opțional); schimbările de zbor; deciziile adminului care îl afectează (rută nouă, evacuare). Agentul răspunde doar despre aeroport și zborul lui.

### D16. Dashboard-ul adminului: un singur ecran, foarte simplu
Alb, cu puține accente, fără tab-uri. Pe ecran:
- Harta terminalului cu oamenii văzuți de camere (`crowd.positions` din serviciul de vision), fiecare zonă colorată după aglomerare. Zonele nevăzute de camere apar ca „necunoscut”.
- Pe fiecare zonă: câți oameni sunt, câte linii sau ghișee sunt deschise și timpul de așteptare.
- Lângă zonă, decizia directă: „+1 linie” / „−1”, plus „Evacuare” pe zonele selectate (D12).
- Rapoartele angajaților apar ca pini pe hartă (D11).
- Un panou mic de acuratețe: pe zonă, estimarea din camere lângă adevărul din Unity (`truth.report`, D0).
- Un singur rând de sfat lângă „+1 linie”, din prognoză (A7): „Deschide o linie la securitate până la 14:05, altfel la 14:30 se așteaptă 18 min.” Adminul decide.
Fără previzualizarea efectului (`ops.preview`) și fără grafice în plus. Orice element nou trebuie să-și câștige locul.

### D17. Agenții simulați sunt și ei abonați
- O parte din pasagerii din Unity au un „telefon virtual”. Unity îi înregistrează cu `agent.register` (`channel: "sim"` și `flight`), iar backend-ul le trimite aceleași mesaje ca pe WhatsApp, dar pe WebSocket, prin `agent.message`.
- În Unity, mesajul apare ca bulă de chat deasupra agentului, apoi decizia lui Jev (ce face și de ce) în timp real. Juriul vede în mulțime cine primește mesajul și cum reacționează.
- Telefoanele reale de pe scenă nu au avatar în Unity.
- La evacuare, abonații simulați merg pe rutele din backend (`agent.route`), iar ceilalți pe ieșirile implicite din Unity.

### D18. Demo-ul în patru momente, în ordinea de lucru
1. Un telefon se abonează și primește „fii la intrare la 14:20”.
2. Coada de la securitate crește, camerele o văd (panoul de acuratețe), adminul deschide o linie și coada scade.
3. Un zbor e întârziat: mesajele pleacă, apar bulele în mulțime și deciziile Jev, live. Întârzierea o declanșează Marius din Unity (tastă sau `sim.command`), iar Unity trimite `flight.update`.
4. Diana, ca angajat, raportează un bagaj abandonat. Adminul evacuează zona, rutele pleacă, mulțimea iese.

Fiecare moment e o linie de tăiere: dacă nu ajungem la toate, demo-ul se oprește la ultimul terminat. Momentele 1–4 folosesc doar `staff` și `evacuate`; `redirect`, `close` și `open` vin după. Termenele le stabilește Marius.

### D19. Dovada: același seed, cu și fără Clarion
Unity rulează aceeași zi cu și fără Clarion. Pe slide:
- așteptarea la securitate (medie și p90) și pasagerii care pierd îmbarcarea;
- la evacuare, timpul până se golește zona (t90 și ultimul ieșit);
- acuratețea camerelor: eroarea la numărare și la timpul de așteptare, pe coadă.

## Algoritmi (Marius, serviciul de vision)

Lanțul: camere → oameni detectați → poziții pe podea → număr și flux pe zonă → așteptarea acum → prognoza → „când să vii”, sfatul pentru linii, evacuarea. Unde scrie „corecție ML”, modelul e LightGBM, antrenat pe zile simulate în care Unity știe adevărul (A11). Nu folosim fețe sau identități, doar numărători și fluxuri.

**A1. Detecția.** YOLO11s, reantrenat pe cadrele CCTV etichetate din Unity (`rgb_deg/` și `yolo/`), plus ByteTrack ca să urmărească oamenii în aceeași cameră. Punctul de la picioare al fiecărei detecții trece prin corecția lentilei și omografia `H_image_to_floor` din `calib.json` și devine o poziție în metri pe podea (`crowd.positions`).

**A2. Corecția numărătorii.** În coada densă oamenii se ascund unul pe altul, iar camerele nu văd toată zona. Un model LightGBM primește, pe zonă și cameră, detecțiile, acoperirea (`queues_seen`), densitatea și mărimea medie a cutiilor și prezice numărul real. Etichetele vin din adevărul din Unity.

**A3. Număr și flux pe zonă: filtru Kalman.** Pe fiecare zonă, starea e numărul de oameni. Predicția adună cei care intră și scade cei care ies (urmele care traversează ușile și capul cozii). Actualizarea folosește numărătoarea corectată (A2), crezută cu atât mai puțin cu cât acoperirea e mai mică. Ies numărul (`waiting`), abaterea (`waitingSd`), rata de sosire λ și rata de servire μ pe linie. Dacă o cameră cade, filtrul continuă din fluxuri și abaterea crește; peste un prag, zona devine „necunoscut”.

**A4. Așteptarea acum.** W = oamenii din coadă ÷ (μ pe linie × liniile deschise), cu μ măsurat la capul cozii în ultimele 5 minute. Răspunde imediat la o linie nouă. O corecție ML (pe W, λ, μ, linii, tendință și plecările din următoarea oră) scade eroarea față de așteptarea reală. `waitMinP90` vine din abaterea filtrului Kalman.

**A5. Prognoza la +30/60/90/120 min.**
- Sosirile: λ(t) = Σ peste zboruri, pax × s(t − STD), unde s e curba de prezentare (cât de devreme vin pasagerii înaintea plecării; lognormală pe tip de zbor). La check-in intră doar cei cu bagaj de cală sau fără check-in online. Curba se ajustează live: dacă la un zbor camerele au văzut deja mai mulți oameni decât se aștepta, restul sosirilor crește în proporție.
- Coada: L(t+Δ) = max(0, L(t) + (λ − μ × linii) × Δ), iar W(t) = L ÷ (μ × linii). Un zbor întârziat își mută curba, unul anulat iese din calculul pentru securitate, iar o linie deschisă de admin schimbă capacitatea imediat.
- O corecție ML pe fiecare orizont învață eroarea sistematică a modelului.

**A6. Când să vii și etapa pasagerului.** Ora la intrare T = închiderea porții − (check-in la ora la care ajunge acolo, dacă are bagaj + securitatea la ora la care ajunge acolo + mersul până la poartă + marjă). T depinde de prognoza de la ora T, deci se calculează în 2–3 iterații. Marja crește cu incertitudinea prognozei. Etapa (înainte de securitate, după, la poartă) e probabilitatea dată de aceeași curbă de prezentare și de așteptările prognozate. A6 rulează în backend (Bogdan), pe fiecare pasager, din `forecast` și din orar: formula e a lui Marius, datele pasagerului rămân în backend.

**A7. Sfatul pentru linii.** Pe fiecare zonă: cel mai mic număr de linii care ține așteptarea prognozată sub țintă în următoarea oră (implicit 10 min la securitate, 15 la check-in), și ora până la care trebuie deschisă linia (momentul depășirii minus timpul în care se deschide o linie). Iese în `advice`.

**A8. Mersul prin terminal.** Viteza de mers scade cu densitatea, după diagrama fundamentală a lui Weidmann: v(ρ) = 1,34 × (1 − e^(−1,913 × (1/ρ − 1/5,4))) m/s, cu ρ în oameni/m² (la 5,4 nu se mai poate merge). Timpul pe muchie = lungimea ÷ v(densitatea zonei). Bogdan folosește formula în Dijkstra pentru rutele spre poartă și pentru ETA-ul echipei de intervenție (D11).

**A9. Timpul de evacuare.** Graful terminalului cu capacități: printr-o ușă trec cel mult 1,3 oameni pe secundă pe metru de lățime (fluxul specific din ingineria focului, SFPE), iar coridoarele au capacitatea după lățime. Sursele sunt oamenii estimați pe zone la alarmă (A3), plus timpul de reacție. Un flux maxim în timp (graful extins în timp, cu pas de 5 s) dă timpul de golire pe fiecare zonă și pe total și câți oameni ies pe fiecare ușă. O corecție ML învață din evacuările rulate în Unity (`egress.csv`: t90, ultimul ieșit).

**A10. Rutele de evacuare.** Același flux (A9) împarte oamenii din fiecare zonă pe ieșiri, ca nicio ușă să nu fie supraîncărcată, cu zonele blocate scoase din graf. Fiecare nod primește ruta spre ieșirea alocată (`evac.plan`). Se recalculează când adminul blochează altă zonă.

**A11. Antrenarea ML.** Unity rulează accelerat zeci de ferestre de vârf, de câte ~3 ore, cu seed-uri diferite: orar, grad de ocupare, linii, întârzieri și evacuări aleatorii, cu deciziile din reguli (`-lifeRules`) ca să meargă repede. Intrările modelelor vin din detectorul simulat, la scară, și din YOLO real pe o parte din rulări; etichetele, din adevărul din Unity. Seed-urile ținute deoparte dau cifrele de acuratețe din D19. În producție, modelele se recalibrează pe date reale, de exemplu ora la care se scanează boarding pass-ul la securitate.

### D20. Starea zonei: Normal, Ocupat, Plin, fiecare cu un înțeles
Eticheta rămâne, dar vine dintr-o regulă, nu dintr-un procent din capacitate. Ținta de așteptare (A7): securitate 10 min, check-in și bag drop 15 min.
- **Cozi (check-in, bag drop, securitate):**
  - **Normal:** așteptarea acum ≤ țintă și prognoza pe următoarele 60 min ≤ țintă.
  - **Ocupat:** așteptarea acum > țintă, sau prognoza depășește ținta în următoarele 60 min.
  - **Plin:** așteptarea acum ≥ 2 × țintă.
- **Zone fără coadă (porți, sosiri, holuri):** după densitate (`density`, oameni/m²): Normal < 1, Ocupat 1–2, Plin > 2.
- **Necunoscut:** nicio cameră nu vede zona.
Sub etichetă, un singur rând cu cifre și acțiunea: „22 min · țintă 10 · Deschide 2 linii”, sau „6 min → 18 min la 14:30 · Deschide 1 linie până la 14:05” (din `forecast` și `advice`). Butonul din rând face acțiunea propusă; restul deciziilor sunt în panoul zonei (click pe zonă): +1/−1 linie, Mută, Închide/Deschide, Evacuează.

### D21. Boarding pass demo în Google Wallet
Pe `/join`, „Boarding pass demo” emite un boarding pass Clarion în Google Wallet (tipul de zbor, cu codul de bare BCBP real pentru zborul demo și link-ul de WhatsApp din D4). Scannerul de pe `/join` citește același cod. Dacă tipul de zbor nu e disponibil pe contul de Wallet, plan B: o pagină care desenează codul BCBP pe ecran, iar cardul generic din Wallet rămâne.

### D22. Tonul mesajelor: situația și cum poate evolua, fără ordine
Clarion nu îi spune pasagerului ce să facă („pleacă acum”, „fii la intrare la…”) și nu folosește cuvântul „abonare”. Îi prezintă situația și prognoza, iar el decide. Exemplu: „Securitate: 12 min acum, ~20 min la 14:30. Check-in grup 2: 5 min. Poarta G2 se închide la 15:05.”
- **Mesaje automate:** prima stare după legarea zborului; o actualizare când prognoza pentru ora la care ajunge el se schimbă cu ≥ 10 min; schimbările de zbor; deciziile adminului care îl privesc (grupul lui mutat sau închis, evacuare). Cel mult un mesaj la 15 min, cu excepția evacuării și a schimbărilor de zbor.
- **Evacuarea** rămâne directă: zona, ruta, ieșirea. Acolo instrucțiunea e necesară.
- Pagina `/m/<token>` urmează același ton: cozi acum și prognoză, nu „fii la intrare la HH:MM”. Calculul din A6 rămâne în backend și poate apărea ca estimare („cu situația de acum, drumul de la intrare la poartă ia ~35 min”).

### D23. Limba o alege pasagerul
Pe `/join` pasagerul alege limba (Română / English). Pe WhatsApp o poate schimba oricând („English” / „Română”), iar agentul răspunde în limba aleasă. Toate mesajele automate, inclusiv evacuarea, și pagina `/m/<token>` folosesc limba aleasă. Fără alegere: română. Principiul din D22 rămâne: punem toate datele la dispoziția pasagerului, el decide.

### D24. Reset demo, fără buton vizibil
`POST /api/demo/reset` (token de operator) golește pasagerii legați (reali și simulați), token-urile de join și de pagină, rapoartele, evacuarea, comenzile, liniile (înapoi la valorile din plan) și istoricul mesajelor, apoi trimite lui Unity `sim.command { reset: true }`. Nu apare pe dashboard; se rulează din terminal (`npm run demo:reset` în `worker/`). Runbook-ul pitch-ului se stabilește mai târziu.

### D25. Emoji doar la ce nu e urgent
Harness-ul WhatsApp din Moni rămâne (reacție cu emoji la ~2 din 3 mesaje, baloane scurte, typing). Mesajele urgente nu au nici reacție, nici emoji în text: evacuarea, zbor anulat sau întârziat, schimbare de poartă, rapoartele angajaților și confirmările lor. Restul (cozi, situația, informații despre zbor, salut, mulțumiri) păstrează emoji-urile.

### D26. Real map ids
Sursa geometriei este acum `docs/contract/map/zones.json` / `points.json`; SVG-urile folosesc aceleași coordonate. `backend/src/terminal.ts` exportă `zones` (inclusiv `level`, `kind`, `polygons_px`, `centre`), `points`, `frames`, `worldToPx(x,z,level)` și `plan`/`terminalGraph`. Frontend-ul le reexportă prin `app/src/console/terminal.ts` (`realPlan`, plus `floorAssets` pentru SVG). Randarea existentă rămâne neschimbată până la integrarea separată a `TerminalMap`; `displayPlan.ts` păstrează doar compatibilitatea ei.

`backend/src/mapIds.ts` este unica configurație pentru aliasuri, tipuri logice și grupuri. Id-urile fizice sunt păstrate în telemetrie; tipul nativ (`queue`, `service` etc.) rămâne în `zones`, iar `plan.zones.kind` este tipul logic pentru D20.

| Id fizic | Tip logic / alias vechi |
|---|---|
| `G_CHECKIN_QUEUE`, `G_CHECKIN_DESKS` | `check_in`; aliasuri generale `check_in`, respectiv `bag_drop` |
| `U_SECURITY_QUEUE`, `U_SECURITY` | `security`; alias `security` → coadă |
| `U_PASSPORT_DEP`, `G_ARRIVALS_PASSPORT` | `passport` |
| `U_GATE_1` … `U_GATE_10` | `gate`; `gate_n` și `Gn` → `U_GATE_n` |
| `G_RECLAIM_1`, `G_RECLAIM_2` | `reclaim` |
| `G_DEPARTURES` | `entrance` |
| `G_MEETING`, `G_ARRIVALS_EXIT` | `arrivals_hall` (alias general → `G_MEETING`) |
| `X_TAXI_RANK` | `taxi_rank` |
| `X_KERB_DEPARTURES`, `X_KERB_ARRIVALS`, `X_BOLT` | `kerb` (alias general → plecări) |
| `ASSEMBLY_*`, puncte cu `evacuation_exit` | destinații de evacuare; `exit_1` → `door_exit_west`, `exit_2` → `door_exit_mid` |
| `U_CORRIDOR_EAST`, `G_INFO` | aliasuri de rutare `airside`, respectiv `team_post` |

| Grup D8 | Alias vechi | Ghișee reale |
|---|---|---|
| `check_in:1` | `check_in:W6` | `checkin_1`–`checkin_4` |
| `check_in:2` | `check_in:RO` | `checkin_5`–`checkin_8` |
| `check_in:3` | `check_in:FR` | `checkin_9`–`checkin_12` |

Grupurile sunt fizice și se alocă pe zbor după intervalul orar (din `flight.update`), nu pe companie; `check_in:OTHER` nu are ghișee. Liniile deschise au un singur contor pe loc (`terminal.json` → `lanes`): `security` (= `U_SECURITY_QUEUE`, 2 la start) și `check_in:1..3` (câte 3). Backend-ul normalizează orice id primit în comandă la acest contor, iar `/api/sim` expune și `U_SECURITY_QUEUE`.

Aliasurile `bag_drop:<grup>` folosesc aceeași ancoră de rutare ca grupul check-in. Rândurile `flow.report` reale și vechi sunt acceptate simultan, fără însumare sau copiere între companii. O observație generală poate servi drept fallback, nu devine o observație pe companie. Orarul demo folosește Londra Luton → 2, Londra Stansted → 3, Milano → 4, București → 5, Dortmund → 6; sunt alocări demo, nu orarul real. Grupul explicit din `flight.update` are prioritate față de alocarea demo.

Graful estimat este determinist: centre de zone și puncte de acces; poligoane la ≤2 m pe același etaj; punctele la zona cea mai apropiată; perechi `_G`/`_U` pentru scări, escalator și lift. Escalatorul permite doar G→U. Muchiile între componentele izolate folosesc distanța minimă dintre poligoane, cu departajare lexicografică; acestea și legăturile spre exterior sunt marcate `inferred`. `walkSec = distanță / 1.34`, incluzând diferența de înălțime G↔U; rutarea aplică apoi Weidmann din camere, niciodată din `truth.report` (D0). Traversările landside↔airside sunt permise prin `U_SECURITY`; celelalte sunt `evacuationOnly`. O securitate blocată oprește rutele normale către porți. Aproximarea nu este un navmesh verificat: traseele centru-la-centru și punțile trebuie confirmate de Marius; `provisional` rămâne `true`. Liniile inițiale vin din `terminal.json` (`lanes`).

`crowd.positions` acceptă acum `{x,z,level:"G"|"U"|"X"}` în metri Unity. Se păstrează `z` și `level`, cu `y=z` doar pentru compatibilitatea cititorilor vechi; `{x,y}` rămâne acceptat. Pixelii se calculează separat cu `worldToPx`: `px=(x-x0)*ppm`, `py=(z1-z)*ppm`. Cadrele G/U sunt 3000×1050 la 10 px/m, X este 2120×1280 la 4 px/m.

Limitări ale pachetului primit: fundalurile `base_*.png` lipsesc; unele zone sunt aproximative și deconectate la pragul de 2 m (punți geometrice de aproximativ 9–121 m, 26 de muchii `inferred` în total); punctul `gate_5` este în afara poligonului `U_GATE_5`, deci este ancorat explicit la zona porții. Fișierele livrate nu sunt corectate manual. Geometria nu precizează pereți/navmesh, politici de acces Schengen/non-Schengen sau starea lifturilor; aceste reguli necesită confirmare înainte de utilizare operațională.

### D27. Harta: ambele etaje stivuite, legate prin conexiunile reale
Research 1 nov (brief: (a private research brief)). Ca la Mappedin (multi-floor view): parterul și etajul 1 se desenează împreună, oblic, unul peste altul, cu etajul activ plin și celălalt la ~25% opacitate, gri, fără etichete. Alertele rămân la opacitate completă pe ambele etaje.
- Proiecție SVG: `matrix(1, 0, 0.35, 0.42, 0, −i·G)` pe placa fiecărui etaj (i = 0 parter, 1 etaj), G ≥ 52 ca plăcile să nu se suprapună. Etichetele se calculează în JS cu aceeași matrice și se desenează nedeformate, deasupra.
- Cele 15 perechi scări/escalator/lift din `points.json` au aceleași x,z pe ambele etaje, deci fiecare legătură e o linie verticală de lungime G: plină pentru scări și lift, cu săgeată pentru escalator (doar G→U).
- Exteriorul (kerb, taxi) e marginea plăcii parterului, mai deschis. Butonul „Ext” dispare.
- Două moduri: „Stivă” (implicit) și „Plan” (un etaj plat, pentru detaliu), cu trecere animată.
- Densitatea se arată prin umplerea zonei, nu prin heatmap. Punctele cu oameni rămân strat opțional.

### D28. Ecranul: hartă plus listă, prognoza în față
Înlocuiește partea de layout din D16. Harta ocupă cea mai mare parte. O coloană îngustă în dreapta e legată de ea (hover și click în ambele sensuri).
- **Banda de sus**, ~5 cifre, fără controale: cel mai rău timp acum, prima depășire prognozată (ora), % din timp sub țintă azi, zboruri în pericol (pasageri încă înainte de securitate față de închiderea porții), densitatea maximă.
- **Lista de zone** are un rând de tip bullet pentru fiecare zonă: bară = așteptarea acum, liniuță = ținta (D20), bandă deschisă = interval normal, cercuri = prognoza +30/+60, plus textul „> țintă la 14:20”. Lista e ordonată după cea mai apropiată depășire, apoi după mărime. Zonele OK se strâng într-un singur rând. Ordinea rămâne stabilă 60–90 s.
- **Sfatul (A7)** apare ca un card fixat sus, nu ca toast: verb, resursă, termen, consecință, efect cu și fără acțiune, cine execută, apoi Trimite / Respinge.
- **Zborurile**, ca la FIDS: oră, zbor, destinație, poartă, status. Culoarea apare doar pentru excepții.
- **Un singur jurnal** pentru rapoartele angajaților și comenzi, cu evidențiere pe ce n-a fost confirmat.

### D29. Stil de cameră de control (ISA-101)
Gri deschis, plat, o culoare = un singur sens. Normalul e o rampă de gri, nu verde. Culoarea apare doar peste prag, mereu cu formă și număr: P1 ■ `#D40000`, P2 ▲ `#E07800`, P3 ● `#E6B800`. Valorile live și prognoza sunt `#0E2F57`, intervalul normal `#B9C6D3`, fundalul `#D4D4D4`, iar podeaua hărții `#C4C4C4`.
- Fără carduri plutitoare rotunjite, umbre, pastel, galben pe negru sau puls. Clipește doar o alarmă P1/P2 neconfirmată.
- Colțuri de maxim 2 px, separatoare de 1 px, grilă de 8 px. Un singur sans cu cifre tabulare, minim 14 px.
- Tema e deschisă, pentru proiector.

### D30. Deciziile devin sarcini; contractul cu Unity rămâne același
În interfață, fiecare decizie e o sarcină: recomandare → Trimite → trimis / confirmat / făcut → efectul măsurat de camere față de prognoza fără acțiune. Fiecare sarcină spune cine o execută în realitate:
- linie: supervizorul de securitate;
- redirecționare: agent pe hol, ecrane și mesaj către zborurile afectate;
- evacuare: incident commander, cu o listă de pași (alarmă, anunț, verificare, numărătoare la punctul de adunare).
**În spate nu se schimbă nimic:** se trimite tot `ops.command` din D12 către Unity (`staff`, `redirect`, `evacuate`, `close`, `open`), cu efectele scrise de Marius (secțiunea „Pentru Marius”, punctul 4). „Confirmat” = `ops.ack`. „Făcut” = efectul văzut în `flow.report`.

### D31. Bug-uri cunoscute pe partea backend (din d600f1a)
- `Messaging.plan` trimite ruta de evacuare tuturor abonaților. La o evacuare parțială trebuie să plece doar celor estimați în zonele blocate sau care le traversează.
- `webSocketClose` din `worker/src/index.ts` aruncă eroare la codul 1006. Trebuie tratat ca 1005, cu `ws.close(1000)`.
- `SIM_SPEED` în `worker/wrangler.toml` e 60, iar demo-ul cere 10.

### D32. Alertele adminului (ISA-18.2)
O alertă pornește când o zonă trece de țintă acum (D20), când prognoza o trece în următoarele 60 min, când densitatea trece de pragul de siguranță (Still: ~3/m² în mișcare, 5/m² pe loc), la un raport nou al unui angajat (D11), la un zbor cu pasageri încă înainte de securitate aproape de închiderea porții, și la pierderea camerelor (zonă devenită „necunoscut”).
- **Priorități:** P1 ■ roșu (densitate periculoasă, evacuare, raport de securitate), P2 ▲ portocaliu (peste țintă acum, zbor în pericol), P3 ● galben (prognoză peste țintă, cameră pierdută). Mereu formă + număr + text, niciodată doar culoare.
- **Stări:** neconfirmată (clipește doar P1/P2), confirmată (fixă, rămâne pe ecran), revenită la normal dar neconfirmată (tot cere click), amânată (cu timer și motiv; revine neconfirmată la expirare).
- Alerta se leagă de zonă pe hartă și de sfatul din D28. Confirmarea o face adminul cu un click. Se păstrează în jurnalul din D28.
- Calculul e în backend, din `flow.report`, `forecast`, `density`, `flight.update` și rapoarte. Niciodată din `truth.report` (D0).

### D33. Pagina pasagerului: coada, unde e el, logat
Extinde `/m/<token>` (există deja). Pasagerul vede, fără să întrebe pe WhatsApp:
- **Coada lui acum și prognoza:** check-in-ul grupului zborului lui (D8) și securitatea, cu timpul de acum și cel estimat la ora la care ajunge el, în benzi ca la Hamburg (0–3, 4–10, >10 min) plus cifra. Tonul e cel din D22.
- **Unde se află:** etapa estimată (D9: înainte de securitate, după, la poartă) pe harta T2, cu ruta spre ghișeu sau poartă și timpul pe fiecare segment (D6b, D7). Harta folosește vederea stivuită din D27, simplificată.
- **Zborul:** poartă, status, ora la care se închide poarta, cu schimbările evidențiate.
- **Logat:** pagina se deschide cu sesiunea din D3 (link unic din WhatsApp sau `LOGIN`). Fără sesiune, cere login cu WhatsApp. Token-ul vechi din URL rămâne pentru compatibilitate.
- La evacuare, pagina arată doar ruta spre ieșire și punctul de adunare.

## Contractul Unity ↔ backend (înghețat pentru lucru în paralel)

Același WebSocket: `wss://clarion-backend.bogdan-c-2206.workers.dev/ws?client=twin&token=<DEMO_TOKEN>`. Serviciul de vision (D0) se conectează separat, cu `client=vision` și același token. E un client nou: backend-ul acceptă azi doar `twin`, `console` și `viewer`. Mesajele vechi (`sim.status`, `agent.register`, `agent.batch`, `metric.report`, `sim.command`) rămân valabile. `flow.report` trece de la Unity la vision. Cele despre dronă (`drone.detected`, `ops.suspended`, `intercept.*`) ies din proiect.

**Reguli comune** (preluate din vechiul `docs/SPEC.md` §5 și `app/PM/CONTRACT.md`, șterse odată cu proiectul vechi):
- Orice mesaj: `{ "type": string, "ts": ISO-8601, "data": object }`. Unity și vision nu deschid porturi; se conectează ei la backend.
- Conexiune: `ws://<host>:8787/ws?client=<twin|vision>&token=<DEMO_TOKEN>` local, `wss://<worker>/ws?...` pe Worker. Fără token corect, când e setat, conexiunea e refuzată. Comenzile HTTP cer `Authorization: Bearer <DEMO_TOKEN>`, altfel `401`.
- Mesaj invalid: backend-ul răspunde `{ "type": "error", "data": { "message": ... } }` și nu aplică nimic din acel mesaj, nici rândurile valide dintr-un lot. Clienții loghează erorile.
- `sim.status`: toate câmpurile obligatorii: `running` (bool), `scenario`, `arm` (`A` = fără Clarion, `B` = cu Clarion, D19), `coverage` (0–1, partea de abonați simulați, D17), `seed` (întreg), `simTime` (secunde, ≥ 0), `speed` (> 0), `agents` (întreg). Se trimite la 5 s și la orice schimbare.
- `agent.register`: `agentId`, `role`, `channel` (`whatsapp`, `sim` etc.). Doar agenții înregistrați primesc mesaje.
- `agent.batch`: `{ updates: [{ agentId, role, persona, location, phone, action, trigger?, lat?, lon?, thought?, stage? }] }`, cel mult o dată pe secundă, doar agenții schimbați, maximum 500 de rânduri pe mesaj și 5.000 de agenți în total. `action` și `trigger` până la 40 de caractere, `thought` până la 200.
- `metric.report`: o metrică pe mesaj, `{ name, value }`, cu `value` ≥ 0.
- `sim.command` (backend → Unity): `{ action: "start" | "stop" | "trigger", scenario?, arm?, coverage?, seed?, speed?, event? }`, cu doar câmpurile trimise. `POST /api/sim/command` cu același `data` dă `202` dacă Unity e conectat, `409` dacă nu.
- `GET /api/sim` și `GET /api/sim/agents` dau ultima stare primită. Starea simulării stă în memorie și dispare la repornire; la reconectare, Unity retrimite `sim.status` și un `agent.batch` complet.
- `SIM_SPEED` din backend trebuie să fie egal cu `speed` din Unity (D13).

**Unity (`client=twin`) → backend**
| Mesaj | Formă | Stare |
|---|---|---|
| `sim.status` | ca acum; `simTime` în secunde, `speed` = `SIM_SPEED` | există |
| `flight.update` | D14 | nou |
| `agent.register` | ca acum, plus abonații simulați (D17): `{ agentId, role, channel: "sim", flight }` | extins |
| `agent.batch` | ca acum. E adevăr (D0): servește doar la afișarea agenților și la acuratețe, nu la decizii. `location` = id de nod din `terminal.json`; câmp nou `stage`: `public` \| `airside` \| `gate` | extins |
| `truth.report` | `{ zones: [{ zone, waiting, waitMin }] }`, cel mult 1/s: cozile și timpii reali, doar pentru panoul de acuratețe și A/B (D0) | nou |
| `metric.report` | ca acum, cu nume noi pentru A/B (D19): `securityWaitMean`, `securityWaitP90`, `missedBoarding`, `evacT90`, `evacLastOut` | extins |
| `ops.ack` | `{ id }`, imediat după `ops.command` | nou |

**Vision (`client=vision`) → backend**
| Mesaj | Formă | Stare |
|---|---|---|
| `flow.report` | `{ zones: [{ zone, waiting, waitingSd, density, waitMin, waitMinP90, coverage, forecast: [{ inMin, waitMin }], advice? }] }`, cel mult 1/s. `zone` din `terminal.json`, inclusiv `check_in:<grup>` și `bag_drop:<grup>`. `waiting` = oamenii din zonă estimați din camere (A1–A3), cu abaterea `waitingSd`; `density` în oameni/m²; `coverage` = partea din zonă văzută (0–1); `waitMin`, `waitMinP90` și `forecast` calculate de serviciu (A4, A5); `advice` = `{ lanes, by, waitMinIfNot }`, doar când prognoza depășește ținta (A7). Fără `staff` și `capacity`: liniile deschise le ține backend-ul (D12), iar vision le citește din `GET /api/sim`. O zonă nevăzută de camere nu se trimite | mutat de la Unity, schimbat |
| `crowd.positions` | `{ people: [{ x, y }] }`: punctul de la picioare al fiecărui om detectat, în metri, în cadrul din `terminal.json`, cel mult 1/s, maxim 2.000 de puncte. Doar unde văd camerele | nou |
| `evac.plan` | `{ id, blocked: [zone], clearSec, exits: [{ exit, people, clearSec }], routes: [{ from: nodeId, exit, nodes: [nodeId, ...] }] }`: răspunsul la un `ops.command` de tip `evacuate`, în cel mult 2 s (A9, A10). Backend-ul trimite fiecărui abonat ruta pentru nodul în care se estimează că e | nou |

Backend-ul trimite și serviciului de vision fiecare `ops.command`, ca să știe liniile deschise și zonele blocate.

**Backend → Unity**
| Mesaj | Formă | Stare |
|---|---|---|
| `ops.command` | D12: `{ id, type: "staff" \| "redirect" \| "evacuate" \| "close" \| "open", ... }`; la `staff`, `delta` e în linii sau ghișee | nou |
| `agent.route` | `{ agentId, nodes: [nodeId, ...], reason: "gate" \| "check_in" \| "evacuate" \| "redirect" }`; agentul merge pe traseu | nou |
| `agent.message` | `{ agentId, text, kind: "arrive" \| "flight" \| "route" \| "evacuate" \| "admin" }`: mesajul primit de un abonat simulat (D17); Unity îl arată ca bulă deasupra agentului | nou |
| `agent.notified` | ca acum: agentul cu telefon a primit sau a citit mesajul | există |

**Fișier comun:** pachetul `docs/contract/map/` (D26) înlocuiește planul provizoriu din D7; geometria este livrată, graful rămâne estimat.

## Pentru Marius: de completat de Claude-ul lui

Claude-ul lui Marius completează secțiunea asta direct în acest fișier, cu formele exacte și exemple JSON reale exportate din Unity, apoi face push. Ce e scris mai sus e contractul minim, iar Marius îl poate extinde fără să-l rupă. Ce trebuie completat, acum (restul mai târziu):

1. **`terminal.json` (D7):** fișierul în `docs/contract/terminal.json`, din `t2_nav.json`. Id-uri stabile pentru zone, noduri (intrări, grupuri de ghișee, bag drop, securitate, porți, ieșiri de urgență, postul echipei de intervenție) și muchii cu `walkSec`, plus liniile deschise la început pe fiecare zonă. Coordonate în metri, văzut de sus, cu originea precizată.
2. **`flight.update` (D14):** un exemplu complet cu orarul din demo, companiile și grupul de ghișee al fiecărui zbor.
3. **`flow.report` din vision (D0, D5b):** confirmă câmpurile și descrie pe scurt cum se calculează numărarea, așteptarea și prognoza.
4. **Efectul comenzilor (D12):** câți pasageri/minut procesează o linie sau un ghișeu, ce procent mută `redirect` și cum urmează agenții `agent.route` la `evacuate`.
5. **Ceasul (D13):** confirmă că `simTime` e în secunde, cu originea, și valoarea `SIM_SPEED` din demo.

### Răspunsuri de la Marius

**1. `terminal.json`: livrat** în `docs/contract/terminal.json`, cu aceeași formă ca `TerminalPlan`, dar neîncercat încă în locul lui `buildPlan()`. 120 de noduri, 444 de muchii, id-urile din D26. `walkSec` vine din graful de mers al simulării, la viteza liberă de 1,34 m/s; peste el se aplică A8. Coordonate în metri, Unity world: x spre est, y = z din Unity = nord. 28 de muchii sunt `inferred` (linii drepte în afara terminalului, nemersuite). Verificat pe 19 rute față de graful simulării: 18 sunt în 9 %, iar cea mai mare abatere e `U_SECURITY_QUEUE` → `U_SECURITY` (26 s față de 15 s). Interiorul se mai mută cu câțiva metri până la demo: fișierul se regenerează, iar id-urile rămân.

Ce schimbă pentru backend:
1. **Grupurile de ghișee:** în Unity sunt trei grupuri fizice de câte 4 ghișee (1-4, 5-8, 9-12), alocate pe zbor după intervalul orar, nu pe companie. Tabelul din D26 (W6 1-6, RO 7-8, FR 9-10, OTHER 11-12) nu există în Unity. `flight.update` va trimite `check_in:1..3` cu ghișeele reale. `check_in:W6/RO/FR` rămân aliasuri, iar `check_in:OTHER` nu are ghișee. `deskGroups` din `mapIds.ts` trebuie aliniat.
2. **Liniile pe dashboard:** `SimStore.laneRows` folosește id-ul trimis exact, iar `initialLanes` are `security`, în timp ce dashboard-ul citește și trimite `U_SECURITY_QUEUE`. La început `sim.lanes['U_SECURITY_QUEUE']` e null, iar după „+1 linie” merge 0 → 1 în loc de 2 → 3. Unity deschide linia corect, dar numărul afișat e greșit. Soluția: normalizare cu `mapNodeId` în `sent()` și `snapshot`.
3. **Liniile inițiale:** valorile reale sunt securitate 2 și `check_in:N` câte 3 ghișee, în `terminal.json.initialLanes`. `backend/src/terminal.ts` are încă valorile vechi.

**2. `flight.update`.** Orarul zilei demo (miercuri 20 mai 2026), exact cum îl trimite Unity. Orele sunt secunde de la miezul nopții zilei simulate; `std` și `gateCloseAt` rămân cele planificate, iar `delayMin` le mută pe amândouă.
```json
{"flights":[{"flight":"W4 106","airline":"W4","destination":"Dortmund","std":21679,"gate":"gate_10","checkIn":"check_in:1","checkInDesks":["checkin_1","checkin_2","checkin_3","checkin_4"],"gateCloseAt":21079,"status":"departed","delayMin":0,"pax":198},{"flight":"W4 3391","airline":"W4","destination":"Bari","std":44749,"gate":"gate_9","checkIn":"check_in:1","checkInDesks":["checkin_1","checkin_2","checkin_3","checkin_4"],"gateCloseAt":44149,"status":"departed","delayMin":0,"pax":231},{"flight":"W4 3625","airline":"W4","destination":"Birmingham","std":59904,"gate":"gate_3","checkIn":"check_in:1","checkInDesks":["checkin_1","checkin_2","checkin_3","checkin_4"],"gateCloseAt":59304,"status":"scheduled","delayMin":0,"pax":193},{"flight":"W4 8093","airline":"W4","destination":"Milan Bergamo","std":68323,"gate":"gate_6","checkIn":"check_in:1","checkInDesks":["checkin_1","checkin_2","checkin_3","checkin_4"],"gateCloseAt":67723,"status":"scheduled","delayMin":0,"pax":230}]}
```
Compania e `W4` (indicativele WMT), nu `W6`. Alte zile au alte zboruri, deci nu presupuneți numere fixe. Grupul se alocă pe zbor după intervalul orar; în ziua demo zborurile nu se suprapun, așa că toate sunt pe `check_in:1`. `gate_N` e nodul din `terminal.json`. Scenariul `rush` înmulțește pasagerii din simulare cu 2,5. În `flight.update`, `pax` va fi limitat la locurile avionului de la următoarea instalare în Unity; până atunci, cu `rush`, worker-ul poate primi peste locuri (483 pe A321).

**4. Efectul comenzilor.**
- **Linie de securitate:** ~2,3 pasageri/min pe linie, măsurat cu coada plină (4,6/min la 2 linii, ~7/min la 3). La 1 linie am măsurat 2,05/min. Între 0 și 4 linii, inițial 2.
- **Ghișeu:** bag drop ~2,0 pasageri/min (81 s pe grup, 2,7 pasageri pe grup); check-in fără online ~1,5 pasageri/min (100 s pe grup). 3 ghișee deschise din 4 pe grup de ghișee, doar cât zborul are fereastra deschisă.
- **`staff`:** se aplică imediat, la următorul din coadă; cine e deja la linie termină. Unity acceptă `security`, `U_SECURITY_QUEUE`, `U_SECURITY`, `check_in:N`, `check_in:W6/RO/FR`, `bag_drop:N`. `G_CHECKIN_QUEUE`, `G_CHECKIN_DESKS`, `check_in` și `bag_drop` nu numesc un grup, deci merg la grupul cu cea mai lungă coadă.
- **`redirect`:** una din două grupe care intră în coada `from` merge la `to` (50 %), doar între grupuri de check-in. Securitatea are o singură coadă, deci comanda e confirmată, fără efect. Regula e scrisă, dar nu a rulat încă, deci cifra nu e măsurată.
- **`evacuate`:** zonele devin blocate (coada blochează și zona pe care o deservește), iar cine e în ele pleacă. Timpul de reacție e de ordinul a 15-150 s de simulare. Cine intră ulterior într-o zonă blocată e trimis afară, iar ușile din zone blocate nu mai sunt folosite. `open` pe ultima zonă blocată dă „all clear” și oamenii se întorc.
- **`agent.route` la evacuare:** grupul abonatului intră pe traseu la nodul cel mai apropiat de el, merge până la prima ușă din listă, apoi la punctul de adunare. Dacă ușa e de cealaltă parte a securității față de agent (etapa estimată din ceas poate greși, D9), agentul ignoră ruta și iese pe cea mai apropiată ușă liberă. Neabonații ies mereu pe cea mai apropiată ușă liberă. Celelalte motive (`gate`, `check_in`, `redirect`) schimbă doar grupurile care merg sau așteaptă, nu pe cele din coadă sau de la control.
- **Atenție:** `Messaging.plan` trimite rută tuturor abonaților, nu doar celor din zonele blocate, deci la o evacuare parțială pleacă și abonați de departe.

**5. Ceasul.** `simTime` = secunde de la miezul nopții zilei simulate (float, 0-86400). `SIM_SPEED` în demo = 10, iar `wrangler.toml` are încă 60, deci trebuie setat 10. Butoanele ×1/×10/×60 din aplicație schimbă viteza, iar `sim.status.speed` o urmează (scris, încă neverificat cu butoanele). La `running: false`, `speed` rămâne ultima valoare (> 0).

**Scenariu demo:** `sim.command { action: "start", scenario: "rush" }` (sau `CLARION_SCENARIO=rush`) pornește ziua la 15:00 cu pasagerii × 2,5, cu 2 linii. Așteptarea reală trece de 10 min la 15:10, adică după circa un minut real la ×10. Cu +1 linie la 15:15, coada ajunge la 75 la 15:25 și 12 la 15:40; fără ea, 101 și 63, iar așteptarea urcă la 22,7 min până la 15:50. `scenario: "day"` e ziua reală, unde coada de la securitate nu trece de ~6 min nici cu o singură linie. `waitMin` din adevărul simulării e o medie mobilă a așteptărilor încheiate, deci rămâne în urmă: stă pe la 11,5 min până se golește coada, chiar dacă numărul de oameni scade în câteva minute.

**De reparat în worker:** `webSocketClose` din `worker/src/index.ts` aruncă eroare la codul 1006 (închidere fără cadru de close), fiindcă `ws.close` nu acceptă codul ăsta. Închiderea cu 1006 trebuie tratată ca 1005, cu `ws.close(1000)`.

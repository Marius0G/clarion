# Clarion

Clarion coordonează informarea când Aeroportul Craiova oprește zborurile. Dispecerul confirmă suspendarea și aprobă mesaje pentru pasageri, rude, taxiuri și personal. La revenire poate deschide accesul în valuri.

Proiect pentru provocarea CONTROL TOWER, Craiova Hackathon 2026. Ținta este notificarea în primul minut de la confirmare. Citirea și reacția oamenilor se măsoară separat. Detecția rămâne internă. Pistă închisă nu înseamnă terminal închis. Statusul zborului aparține companiei aeriene.

- [`docs/clarion-sinteza-si-plan-control-tower.pdf`](docs/clarion-sinteza-si-plan-control-tower.pdf): sinteza și planul Clarion, ultima versiune. `app/PM/control-tower-plan.pdf` este versiunea dinainte de alegerea numelui; secțiunile încep la aceleași pagini.

## Demo

| Ecran | URL |
|---|---|
| Consolă | https://clarion-craiova.pages.dev |
| Abonare | https://clarion-craiova.pages.dev/join |
| QR pentru juriu | https://clarion-craiova.pages.dev/join/qr |
| Twin 2D | https://clarion-craiova.pages.dev/twin |

Fluxul de scenă: juriul scanează QR-ul afișat la `/join/qr`, alege rolul și acceptă canalul. Deschide WhatsApp și **trimite** mesajul precompletat către Clarion, **+40 700 000 000**. Operatorul apasă **Confirmă suspendarea**, apoi **Aprobă mesajele**, selectează rolurile și apasă **Aprobă și trimite**. Telefoanele primesc alerta. `/twin` arată reacțiile agenților, apoi rezultatele A/B.

**Stare la revizia documentației, 31 octombrie:** ruta `/twin`, interfața, transportul și modelul 2D există în checkout. Verificarea automată Pages din acest mediu a primit HTTP 403. Deploy-ul și fluxul pe telefon trebuie verificate înainte de scenă. Rezerva este înregistrarea locală. Vezi [runbook](docs/pitch/runbook.md).

## Arhitectură și backend

Twin → backend → canale și consolă. Consola trimite deciziile înapoi la backend. Abonarea și răspunsurile de pe telefon actualizează aceeași stare.

- **Cloudflare:** frontend pe Pages; backend în [`worker/`](worker/README.md), Worker cu Durable Object și stare SQLite. HTTP și WebSocket folosesc aceeași instanță. Secretele se configurează în Cloudflare.
- **Rezervă:** [`backend/`](backend/README.md), Node pe laptop, port 8787, conectat la hotspot. Folosește același motor de stare și mesaje. Starea Worker-ului nu se copiază automat pe laptop.
- **Selectare:** adaugă `?backend=` cu originea API codificată în URL. Exemplu local: `http://localhost:5173/?backend=http%3A%2F%2Flocalhost%3A8787`. Aplică aceeași origine la `/join`, `/join/qr` și `/twin`. Alegerea se păstrează în browser; verifică fiecare dispozitiv.

Originea publică a Worker-ului se ia din deploy-ul real, nu se ghicește. Valorile implicite Pages sunt `VITE_BACKEND_HTTP` și `VITE_BACKEND_URL`, setate înainte de build. Pentru Pages plus backend pe laptop trebuie un **tunel HTTPS** către portul 8787. HTTPS nu poate folosi direct un API HTTP de pe hotspot. Mută și webhook-ul WhatsApp la tunel. Telegram pe Node folosește polling; Worker-ul folosește webhook. Un singur backend trebuie să primească actualizările botului.

Twin-ul 2D `/twin` este înlocuitorul Unity pentru demo. Vorbește [contractul final](app/PM/CONTRACT.md): evenimente de incident, `agent.register`, `agent.update`, `metric.report`; primește `alert.sent`, `agent.notified`, `wave.green` și `state`. Unity poate folosi același contract când este conectat. Alegem o singură sursă de evenimente pe incident. Modelul 2D și modelul `sim-ab/` au rezultate distincte. În `/twin`, alege **Cu Clarion**, acoperire **50%**, apoi **▶ Auto**. Confirmarea și aprobarea rămân în consolă. **Run A/B (20 seeds)** deschide rezultatele pereche, pentru acoperire 20%, 50% și 80%.

## Local, în 3 comenzi

Node **22.12+ din seria 22** și npm. Din rădăcina repo-ului, câte o comandă în trei terminale:

```sh
(cd backend && npm ci && npm run dev)
(cd app && npm ci && npm run dev -- --host 0.0.0.0 --port 5173)
(cd sim-ab && npm ci && npm run ab)
```

Backend: `http://localhost:8787/health`. Consolă: `http://localhost:5173/`. Abonare: `http://localhost:5173/join`. QR: `http://localhost:5173/join/qr`. Twin: `http://localhost:5173/twin`. Comanda 3 produce rezultatele A/B în `sim-ab/out/`; nu declanșează incidentul live.

Fără credențiale, canalele reale sunt în mod dry-run. Node încarcă automat `backend/.env` și fișierul `.env` al echipei din rădăcină. Cu credențiale, aprobarea poate trimite mesaje reale. Configurarea este în [backend/README.md](backend/README.md) și [worker/README.md](worker/README.md). Nu publica secrete sau fișierele de stare.

Pentru repetiția cu operator: din `backend/`, `npm run demo:pitch`. Trimite evenimentele scenariului și așteaptă deciziile omului. Nu îl porni simultan cu scenariul twin. `npm run demo` este automat: resetează incidentul și apasă inclusiv aprobările. Nu îl rula peste demo-ul manual. Telefoanele nu pot folosi `localhost` pentru a ajunge la laptop; folosește adresa publică verificată.

## Canale

| Canal | Ce face demo-ul |
|---|---|
| WhatsApp | Canal real principal, numărul Clarion +40 700 000 000. Catalog RO/EN în `whatsapp/templates.json`. Template-urile cer aprobare Meta; trimiterea la aprobare nu înseamnă acceptare. Mesajul inițiat de jurat deschide fereastra de 24 h pentru răspunsuri libere. |
| Telegram | Rezervă reală. Abonare separată, cu acord; utilizatorul apasă **Start** în bot. „Am înțeles” confirmă citirea. |
| SMSLink | Rezervă reală doar cu credențiale, destinație și acord testate. Fără linkuri în SMS. Selectorul SMS din `/join` este momentan dezactivat. |
| Waze | Feed CIFS `ROAD_CLOSED` simulat la `/waze/cifs.json`. Nu este publicat în Waze. |
| Web push și Google Wallet | Adaptoare simulate. Nu sunt notificări push sau pass-uri Wallet reale. |
| RO-Alert | Ciornă în consolă. Nu emitem alerte; decizia revine ISU. |

Verificare template-uri, din rădăcină: `node whatsapp/submit-templates.mjs --status`, cu secretele echipei încărcate. În fereastra de 24 h adaptorul folosește text liber. În afara ei trimite doar template-uri acceptate și disponibile pentru rol și limbă. Rezerva Telegram/SMS cere abonare separată.

Contoarele disting încercările, livrările și citirile. În metrica backend, livrarea înseamnă acceptarea de către furnizor; nu dovedește afișarea pe telefon. Primul minut începe la confirmarea suspendării. Endpoint-urile sunt deduplicate; un grup Telegram este un endpoint, nu numărul membrilor. Treptele de acoperire se suprapun și nu se adună. Estimarea Waze de 10 șoferi/minut este o ipoteză de demo.

## Ce susțin datele A/B

Sursa: [`sim-ab/out/results.json`](sim-ab/out/results.json), `coverage=0.5`, `waves=false`. A = fără alerte, B = cu alerte. Aceeași populație în fiecare pereche, 20 de seed-uri. **Simulare necalibrată**, cu orar ilustrativ. Intervalele sunt p05-p95 empirice între seed-uri, nu intervale de încredere.

| Metrică | Rezultat la 50% acoperire | p05-p95 |
|---|---:|---:|
| Porniri inutile evitate, A−B | 4 mașini | 2-7,05 |
| Drum inutil evitat, A−B | 137,92 km | 76,21-179,81 |
| Timp inutil evitat, A−B | 229,86 vehicul-minute | 127,01-299,68 |
| Persoane simulate notificate în primul minut, B | 294,5 | 275,85-326,45 |
| Câștig ISU/SMURD până la T2, A−B | 1,06 min | 0,60-1,65 |

Pentru scenă: **4 porniri inutile evitate, circa 138 km și 230 vehicul-minute. Aproximativ 295 de persoane simulate notificate în primul minut.** Acestea sunt mediane, nu o rulare individuală. Kilometrii includ și drumurile scurtate ale mașinilor deja pornite; nu provin doar din cele 4 porniri evitate. Vehicul-minute nu înseamnă minute per pasager. Mediana citirilor din primul minut este doar 1.

ISU/SMURD rămâne linia secundară: **circa 1,1 minute, interval 0,6-1,7**. Rezultatul este necalibrat până la numărătoarea de **2 × 15 minute la rampele T2** și rerulare. Modelul nu demonstrează reducerea vârfului de la bordură prin valuri: 12 vehicule în ambele variante. Datele complete și sensibilitățile sunt în [sim-ab/README.md](sim-ab/README.md) și [ipoteze](sim-ab/ASSUMPTIONS.md).

**{TWIN_AB}**: loc rezervat rezultatului A/B din `/twin`. Se completează doar cu export verificat: acoperire, seed-uri, A/B, mediană, interval, unități și ipoteze. Nu se copiază rezultatul `sim-ab/` aici.

## Ce exista înainte / ce am construit în 48 h

| Înainte | Contribuția din repo pentru hackathon |
|---|---|
| Twin-ul Unity al lui Marius, declarat ca asset de vizualizare pregătit înainte. Nu este inclus în acest checkout. | Twin landside 2D la `/twin`: hartă, agenți, transport WS, evenimente, reacții, metrici și rulare A/B în browser. |
| Date publice și servicii externe. Nu sunt creația echipei. | Hartă React/MapLibre, GeoJSON locale, straturi T2 și intervenție, coridor SCJU, grilă și puncte operaționale aproximative; vreme/METAR cu rezervă locală. |
| Baza vizuală Unity rămâne declarată separat. Acordul organizatorului pentru folosire trebuie consemnat. | Consolă cu confirmare, aprobare pe rol, prezență, contoare, cronologie, ciornă RO-Alert, valuri și redeschidere. Exercițiile inițiale și scenariile generale rămân în repo. |
| API-uri de mesagerie și formate publice. | Backend Node, Worker/Durable Object, stare persistentă, contract HTTP/WS, mesaje RO/EN, WhatsApp și webhook-uri, Telegram, SMSLink; adaptoare simulate Waze/push/Wallet. |
| Orar și date externe de referință. | Adaptoare FIDS/OpenSky, cache și orar ilustrativ etichetat; suprapuneri simulate de suspendare/deviere. |
| Formatul boarding pass BCBP. | `/join`, `/join/qr`, alegere rol/canal, acord, mesaj WhatsApp precompletat, activare Telegram, link pentru rude, scanner local unde browserul îl suportă. |
| Cercetare și ipoteze declarate în documentele sursă. | `sim-ab/`, 20 de perechi de seed-uri, export JSON/CSV, sensibilități, teste, scenarii automate și de pitch, contract, documentație și materiale de prezentare. |

Prezența codului nu dovedește livrarea pe un telefon sau aprobarea Meta. Lista de scenă include doar ce trece pre-flight. Proveniența asset-urilor Unity și acordul art. 11 se verifică separat cu Marius și organizatorul.

## Date și licențe

Sursele și datele de colectare sunt în [`docs/research/`](docs/research/) și [`bogdan-research/`](bogdan-research/). Datele de intrare nu sunt măsurători ale eficienței Clarion.

| Sursă | Utilizare și condiții |
|---|---|
| OpenStreetMap / Overpass | Geometrie, clădiri, drumuri, servicii. **© OpenStreetMap contributors, ODbL 1.0**. Păstrează atribuirea și licența pentru datele derivate. [Condiții OSM](https://www.openstreetmap.org/copyright). |
| CARTO Dark Matter | Hartă de fundal. Atribuire CARTO și OSM. Termenii serviciului sunt separați de ODbL. [Termeni CARTO](https://www.carto.com/legal). |
| Eurostat | Referință de cerere: 577.693 pasageri în 2025, conform cercetării repo-ului. Reutilizare cu sursa indicată, sub rezerva excepțiilor setului. Calculele Clarion sunt ale echipei; Eurostat nu răspunde de ele. [Politică Eurostat](https://ec.europa.eu/eurostat/web/main/help/copyright-notice). |
| CNAIR/CESTRIN | Referință DN65: 13.957 vehicule/zi, date 2022. Licența setului nu este consemnată în repo; nu presupunem drept de redistribuire. |
| OSRM | Rutare și timpi fără trafic. Datele OSM și condițiile serviciului de rutare rămân distincte. Nu este trafic măsurat la T2. |
| FIDS CRA | Orar din `fids.flightradar.live/api/schedules/{departures|arrivals}/CRA`. În caz de eșec: **FIXTURE** ilustrativ. Nu pretindem licență deschisă sau integrare oficială cu aeroportul/Wizz. |
| OpenSky | Aeronave în apropiere. Acces supus condițiilor furnizorului; fără drepturi de redistribuire presupuse. Lipsa feed-ului nu blochează demo-ul. |
| Open-Meteo și Aviation Weather Center | Vreme și METAR LRCV, cu snapshot local etichetat. Open-Meteo: date CC BY 4.0, cu reguli separate de acces API. [Condiții Open-Meteo](https://open-meteo.com/en/terms). Condițiile AWC trebuie verificate pentru redistribuire. |
| Grilă, puncte operaționale, orar de rezervă și A/B | Generate de echipă; aproximări și ipoteze etichetate. Nu sunt hărți aeronautice sau proceduri autorizate. |

Repo-ul nu include un fișier LICENSE general la această revizie. Publicarea pe GitHub nu acordă automat o licență pentru întregul cod. Asset-urile 3D cer inventar și licențe proprii înainte de redistribuire.

## GDPR

Abonarea cere acord pe canal. Scannerul citește local; imaginea, codul brut, numele și PNR-ul nu sunt trimise backend-ului. Se folosesc zborul, data și ruta, plus rolul, limba și destinația canalului. Camera cere HTTPS sau localhost; citirea unui boarding pass real trebuie testată pe telefon.

Regula produsului este expirarea la 48 h după zbor. Backend-ul elimină abonările expirate. Datele juriului trebuie șterse după eveniment din starea Node/Worker și copiile echipei, printr-o operațiune verificată. **Resetarea incidentului păstrează abonările** și nu ține loc de ștergere. Nu pune numere, chat ID-uri, capturi cu date personale sau `.env` în repo/video public. Înainte de pilot se verifică retenția completă, furnizorii și informarea persoanelor.

## Documente și termene

[Spec v3](app/PM/SPEC.md), [contract final](app/PM/CONTRACT.md), [roluri](docs/ROLURI.md), [plan](app/PM/control-tower-plan.pdf), [pitch](docs/pitch/pitch-final.md), [pre-pitch](docs/pitch/pre-pitch-90s.md), [slide-uri](docs/pitch/slides.md), [Q&A](docs/pitch/qa.md), [checklist](docs/pitch/checklist-sambata.md), [runbook](docs/pitch/runbook.md).

Sâmbătă **31 octombrie, 22:00**: repo public înregistrat în UserHub. Duminică **1 noiembrie, 15:00**: cod final; **15:00-17:00** pre-pitch; **17:00-19:00** pitch. Ore locale, Craiova. Pilotul gratuit de 30 de zile este o propunere. Nu avem aici dovada unui client sau parteneriat semnat.

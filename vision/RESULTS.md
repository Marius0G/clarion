# Rezultatele serviciului de vision (D19)

> **Toate cifrele de aici vin din date simulate.** Aeroportul, oamenii și camerele sunt simulate în Unity, iar adevărul cu care comparăm vine tot din Unity. Camerele sunt **detectorul simulat** (varianta de rezervă din D0): Unity calculează ce ar vedea fiecare cameră și scrie cutiile, cu ratări, ocluzii, zgomot și schimbări de id, cu parametrii inițiali din `cctv_detector.json`. Nu sunt cifre YOLO și nici cifre de pe camere reale. Demo-ul live folosește tot detectorul simulat.

Măsurat pe 1 noiembrie 2026, cu `python -m clarion_vision.ml.train <rulări> --test-seeds 11,12,13,14,106,107,108` (fișierul complet e `models/accuracy.json`).

## Cum am măsurat

- **Rulările din Unity**, toate cu jurnalul detectorului (`detlog.jsonl`) și adevărul (`truth.jsonl`, `stages.csv`, `kpi.json`):
  - 15 zile obișnuite (seed 0-14): ferestre de 3 ore, încărcare 1,0-2,9, 1-3 linii la securitate.
  - O fereastră `rush` de 45 de minute (seed 0).
  - 24 de ferestre `rush` cu evacuare (seed 101-112, câte un braț A și B): 50-60 de minute, încărcare 2,5, 2 linii, alarma după 20-30 de minute.
- **Seed-urile ținute deoparte** sunt 11-14 (zile obișnuite) și 106-108 (rush, ambele brațe). Modelele s-au antrenat doar pe celelalte. Brațele A și B ale aceluiași seed rămân de aceeași parte.
- **Eroarea** e eroarea absolută medie, la fiecare 5 s simulate, pe fiecare coadă, până la alarmă.
- **„Așteptarea reală”** e cât au așteptat efectiv cei care intră în coadă în acel moment (din `stages.csv`).
- **Momente scoase:** cele în care coada depășește cât poate desena Unity, adică peste 124 de oameni la securitate și peste 46 la un grup de check-in. Acolo `PeopleNav.Overflow` pune oamenii unul peste altul și nicio cameră nu i-ar putea număra. Asta se întâmplă doar în zilele supraîncărcate (seed 11, 12, 14); `rush` rămâne sub limită.
- **Treptele comparate:**
  - **Brut:** doar detecțiile camerelor.
  - **Fizică:** filtrul Kalman plus formulele A4/A5, fără ML.
  - **Final:** cu corecțiile LightGBM (A2, A4, A5), adică ce trimite serviciul.

## Pentru slide

**Scenariul din demo (`rush`, seed 106-108 ținute deoparte, 6 rulări):**

| Coadă | Oameni în coadă, în medie | Eroare la numărare (brut → final) | Eroare la așteptare (fizică → final) |
|---|---|---|---|
| Securitate | 69 | 33,4 → **6,0 oameni** | 3,8 → **2,9 min** |
| Check-in, grupul 1 | 20 | 5,5 → **2,8 oameni** | 2,0 → **1,6 min** |

**Zile obișnuite (seed 11-14 ținute deoparte):**

| Coadă | Oameni în coadă, în medie | Eroare la numărare (brut → final) | Eroare la așteptare (fizică → final) |
|---|---|---|---|
| Securitate | 15 (până la 124) | 8,4 → **2,3 oameni** | 4,6 → **2,3 min** |
| Check-in, grupul 1 | 7 (până la 46) | 2,5 → **1,4 oameni** | 0,55 → **0,33 min** |

**Prognoza, pe zilele obișnuite (fizică → final, eroarea așteptării prognozate):**

| Coadă | +30 min | +60 min | +90 min |
|---|---|---|---|
| Securitate | 14,2 → **8,7 min** | 15,2 → **8,1 min** | 9,9 → **10,2 min** |
| Check-in, grupul 1 | 3,2 → **1,3 min** | 6,6 → **1,4 min** | 9,8 → **1,7 min** |

Ferestrele `rush` sunt prea scurte pentru prognoză: alarma vine după 20-30 de minute, așa că acolo nu există etichete la +30.

## Ce spun cifrele, cinstit

- **Numărarea merge bine.** În coada densă camerele văd cam jumătate din oameni (33 de oameni lipsă din 69), iar corecția A2 aduce eroarea la ~6 oameni, adică ~9 %.
- **Așteptarea e bună la coada medie și slabă la cea mare.** În `rush`, la 20-59 de oameni, eroarea e 0,9 min. La 60-124 de oameni urcă la 4,5 min, iar acolo corecția ML e chiar mai slabă decât fizica (4,1 min). În zilele cu o singură linie și cozi mari (60-124 de oameni, așteptări de 30-60 min), eroarea e 15 min.
- **Prognoza la securitate e cea mai slabă parte:** ~8-10 min la +30/+60/+90. La check-in e sub 2 min.
- **Panoul de acuratețe compară cu altceva.** `waitMin` din `truth.report` e media celor care termină coada acum, deci rămâne în urmă când coada se schimbă. Față de el, eroarea finală în `rush` e 2,9 min la securitate și 1,2 min la check-in.

## Live, în Unity (trei rulări `rush` x10, 1 noiembrie, ora 01:06, 01:28 și 02:36)

Serviciul a mers live ca `client=vision` și a trimis `flow.report`, `crowd.positions` și `evac.plan`. Backend-ul n-a respins nimic.

- **Numărarea la securitate:** 57-67 de oameni, față de 56-67 reali.
- **Așteptarea:** 13,2-15,8 min, față de panou 9,5-12 min. Panoul rămâne în urmă: în rularea batch cu același scenariu (seed 0), cine intra la 15:05 aștepta ~12 min, deci serviciul e cu ~3 min peste. E în eroarea măsurată mai sus (2,9 min).
  - Contribuie faptul că `flight.update` dă acum `pax` plafonat la locuri (239), în timp ce `rush` aduce de 2,5 ori mai mulți pasageri. Factorul de sosiri măsurat de camere poate urca acum până la 3.
- **Prima rulare** a citit doar `detections.json`, adică un tick la 5 s simulate la x10. Au fost văzute prea puține plecări din capul cozii și așteptarea a ajuns la 17-51 min. De atunci, Unity scrie și jurnalul detectorului (`-cctv-det-log`), cu un tick pe secundă simulată, ca la antrenare, iar serviciul îl citește pe acela.

## Evacuarea (A9)

Planul e calculat la alarmă, doar din camere (plus estimarea zonelor nevăzute la o evacuare a terminalului întreg). E comparat cu `kpi.json`, unde se numără doar cei aflați în zonă la alarmă.

- **Brațul A:** fiecare iese pe cea mai apropiată ușă.
- **Brațul B:** ieșirile sunt împărțite după capacitatea ușilor, cum face și planul.

**Toate cele 24 de rulări (seed 101-112, A și B), cu ieșirea fiecăruia înregistrată de Unity**, inclusiv a personalului și a celor de la toalete. Seed 101-108 sunt refăcute după reparare (cele vechi sunt în `clarion_runs_old/`).

| Zona evacuată (4 rulări pe braț) | Oameni în zonă (real / plan) | Plan: ultimul ieșit / t90 | Real, B: ultimul ieșit / t90 | Real, A: ultimul ieșit / t90 |
|---|---|---|---|---|
| Coada de check-in | 17-88 / 19-54 | 130 s / 115 s | 59-113 s / 58-106 s | 100-141 s / 99-137 s |
| Coada de securitate | 73-129 / 60-123 | 185 s / 165 s | 175-209 s / 155-178 s | 239-265 s / 208-244 s |
| Terminalul întreg (`T2`) | 417-586 / 597-712 | 185 s / 130-150 s | 153-204 s / 120-155 s | 208-269 s / 137-219 s |

- **Brațul B (ieșirile urmează împărțirea planului):** eroarea medie e **26 s** la ultimul ieșit și **21 s** la t90. La securitate și la terminalul întreg planul e în ±25 s.
- **Brațul A (fiecare pe cea mai apropiată ușă):** eroarea e 45 s și 40 s. Realul e mai lent decât planul, cu ~60 s la securitate, adică ce câștigă rutele lui Clarion.
- **Live (`T2`, rularea de la 02:36):** planul a văzut 372 de oameni (128 văzuți plus 244 estimați), față de 393 reali. Planul a dat 185 s / t90 140 s, realul 132 s / 110 s, cu reacțiile alese de Jev. Planul a venit în 0,5-1,1 s.
- **Ce nu merge încă:**
  - La check-in planul e prea pesimist (130 s față de 59-113 s pe B): pornirea eșalonată pe care o presupune e prea lentă pentru grupurile mici de acolo.
  - La terminalul întreg, estimarea zonelor nevăzute supraestimează oamenii cu 10-40 %. Timpul rămâne aproape, pentru că îl dau pornirea eșalonată și mersul.
  - La check-in, camerele numără coada, nu și personalul de la ghișee, pe care realul îl include.

Detaliile, rulare cu rulare, sunt în `models/evacuation_a9.json`.

## Detectorul: YOLO real față de detectorul simulat

Am rulat YOLO11s (COCO, 960 px) pe exportul etichetat al camerelor din Unity (`tools/calibrate_detector.py`): 8 camere, 1.600 de cadre, 44.946 de oameni etichetați, din două ferestre `rush`.

- **YOLO găsește 41 % dintre oamenii etichetați.** Pe cameră, între 0,28 (`upper_4`, de sus, coada densă) și 0,71 (`checkin_overview`).
- **Parametrii potriviți** (`data/cctv_detector.calibrated.json`):
  - recall maxim 0,89;
  - jumătate din recall la cutii de 25 px înălțime și la 61 % din corp vizibil;
  - zgomot pe înălțimea cutiei 12 %;
  - 0,12 schimbări de id pe secundă și urmă (ByteTrack în mulțime).
- **Detectorul simulat din demo e mult mai optimist:** ~0,97 peste 30 px și jumătate abia la 35 % vizibil. Cifrele de numărare de mai sus sunt deci cele ale unui detector mai bun decât YOLO-ul de azi.
- **De ce nu l-am schimbat înainte de demo:** ar fi trebuit refăcute toate rulările de antrenare, altfel corecția A2 n-ar mai fi potrivit.
- **Rata de alarme false nu se poate citi din acest export.** Etichetele acoperă doar oamenii din raza camerei, iar YOLO îi vede corect și pe cei mai îndepărtați, neetichetați. Rămâne 0,02 pe cadru.

## Ce se poate verifica

- `models/accuracy.json`: toate cifrele de mai sus, pe coadă, plus defalcarea pe scenariu și pe mărimea cozii.
- `models/evacuation_a9.json`: cele 24 de evacuări, rulare cu rulare.
- `runs/` (local, neurmărit în git): jurnalele de antrenare și rulările live (`watch_*.jsonl`, `detlog_bridge_0134.jsonl`).
- Modelele din `models/` folosite la demo sunt antrenate pe toate cele 39 de rulări (`--final`). Cifrele de acuratețe vin doar din rularea cu seed-uri ținute deoparte.

## Răspunsul 3 pentru SPEC (de copiat sub „Răspunsuri de la Marius”)

**3. `flow.report` din vision: confirmat.** Câmpurile sunt cele din contract, fără `staff` și `capacity`. Exemplul e un rând real, din rularea live a lui Unity din 1 noiembrie (rush, x10, ora simulată 15:05:35), trecut prin serviciu:
```json
{"zones":[{"zone":"U_SECURITY_QUEUE","waiting":62,"waitingSd":1.98,"density":0.479,"waitMin":15.33,"waitMinP90":18.8,"coverage":0.994,
  "forecast":[{"inMin":30,"waitMin":6.92},{"inMin":60,"waitMin":10.04},{"inMin":90,"waitMin":3.66},{"inMin":120,"waitMin":11.71}],
  "advice":{"lanes":3,"by":54306,"waitMinIfNot":13.5}},
 {"zone":"check_in:1","waiting":11,"waitingSd":1.22,"density":0.228,"waitMin":0.99,"waitMinP90":2.52,"coverage":1.0,
  "forecast":[{"inMin":30,"waitMin":0.02},{"inMin":60,"waitMin":0.03},{"inMin":90,"waitMin":0.61},{"inMin":120,"waitMin":3.27}]}]}
```
Serviciul trimite `flow.report` și `crowd.positions` o dată pe secundă reală. Intrările sunt doar camerele, orarul (`flight.update`) și comenzile adminului (D0). În demo, camerele sunt detectorul simulat din Unity (varianta de rezervă din D0): pentru fiecare cameră, Unity scrie cutiile pe care le-ar da un detector, fără niciun adevăr. Cifrele din demo nu sunt cifre YOLO.

- **`zone`:** id-urile fizice din `terminal.json` (`U_SECURITY_QUEUE`, `U_GATE_2`, ...) și `check_in:1..3`. `bag_drop:*` nu se trimite, pentru că Unity are o singură coadă pe grup. `G_CHECKIN_QUEUE` arată grupul cel mai aglomerat. `U_SECURITY` și `G_CHECKIN_DESKS` preiau așteptarea cozii lor. O zonă văzută sub 10 % nu se trimite.
- **`waiting` (numărarea, A1-A3):**
  - Picioarele fiecărei cutii trec prin omografia camerei (`calib.json`) și devin un punct pe podea, în metri. Unde se suprapun două camere, același om e numărat o singură dată.
  - Pe fiecare coadă, un filtru Kalman ține numărul de oameni. Predicția adună cei care intră în inelul cozii și scade cei văzuți plecând de la capul ei. Actualizarea folosește numărătoarea camerelor corectată de LightGBM (A2), pentru că în coada densă oamenii se ascund unul pe altul.
  - `waitingSd` e abaterea filtrului. `density` = `waiting` ÷ aria zonei (oameni/m²). `coverage` = partea din zonă pe care o văd camerele care merg.
  - Dacă o cameră cade, filtrul continuă din fluxuri și abaterea crește. Rândul se mai trimite cu `coverage: 0` cel mult 10 min simulate, cât timp abaterea rămâne sub 12 oameni; apoi zona dispare și dashboard-ul o arată „necunoscut”.
- **`waitMin` (așteptarea acum, A4):**
  - W = oamenii din coadă ÷ (μ × liniile deschise). μ e ritmul pe linie, măsurat la capul cozii din plecările văzute în ultimele 5 minute în care coada n-a fost goală.
  - Până la prima măsurătoare, μ pornește de la valoarea din rulările de antrenare (securitate ~2,3, check-in ~1,6 oameni/min pe linie).
  - Liniile le ia din `initialLanes` plus comenzile `staff`, deci o linie nouă schimbă W imediat.
  - Peste W se aplică o corecție LightGBM, antrenată să prezică așteptarea reală a celor care intră acum în coadă (din `stages.csv`).
  - Valoarea afișată e netezită pe 60 s simulate, ca să nu sară de la un raport la altul. La o schimbare de linii netezirea se resetează, deci noua linie se vede imediat.
  - `waitMinP90` vine din abaterea numărului și a lui μ (metoda delta).
- **`forecast` (A5, la +30/60/90/120 min):**
  - Sosirile: λ(t) = Σ pe zboruri, `pax` × curba de prezentare, o lognormală pe minutele dinainte de STD. Curbele sunt potrivite pe rulările de antrenare: la securitate mediana e ~145 min, σ 0,42; la check-in mediana e ~148 min, σ 0,37, și ~88 % trec pe la ghișeu.
  - λ se înmulțește cu un factor măsurat de camere (0,5-3): dacă au intrat mai mulți decât prevedea orarul, restul sosirilor crește în proporție.
  - Coada evoluează minut cu minut: L ← max(0, L + (λ − μ × linii) × 1 min), iar W = L ÷ (μ × linii).
  - Un zbor întârziat își mută curba, unul anulat iese din calcul. Peste fiecare orizont se aplică o corecție LightGBM.
  - Fără orar nu se trimite prognoză.
- **`advice` (A7):** cel mai mic număr total de linii care ține prognoza sub țintă în ora următoare (securitate 10 min, check-in 15 min). `by` e ora până la care trebuie deschisă linia, în secunde simulate de la miezul nopții. `waitMinIfNot` e vârful orei cu liniile de acum. Câmpul apare doar când prognoza depășește ținta.
- **`crowd.positions`:** `{x, z, y=z, level}` în metri Unity, doar unde văd camerele, cel mult 2.000 de puncte.
- **`evac.plan`** (răspuns la `evacuate`, în 0,5-1,1 s în rulările live) are trei câmpuri în plus, pe care backend-ul le poate ignora: `partlyEstimated`, `peopleSeen`, `peopleEstimated`.

**Pentru panoul de acuratețe:** `waitMin` din `truth.report` e media celor care termină coada acum, deci rămâne în urmă când coada se schimbă. Vision estimează cât va aștepta cine intră acum. De aceea panoul arată o diferență de câteva minute chiar când estimarea e bună. În rularea live, la ora simulată 15:05 panoul arăta 10,4 min. Într-o rulare batch cu același scenariu, cine intra atunci aștepta ~12 min, iar serviciul arăta 14-15 min. Erorile măsurate sunt în `vision/RESULTS.md`.

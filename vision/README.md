# vision/: serviciul de vision al lui Clarion

Serviciul lui Marius (Python). Citește camerele, calculează cozile, timpii, prognoza și evacuarea și le trimite backend-ului ca client WebSocket separat (`client=vision`). Algoritmii sunt în [`docs/SPEC-v2.md`](../docs/SPEC-v2.md), secțiunea „Algoritmi” (A1–A11), iar mesajele în secțiunea „Contractul”.

Intrările lui sunt doar camerele, orarul de zboruri și deciziile adminului (D0). `GET /api/sim` conține și adevărul din Unity: `state.SimView` păstrează o listă albă de câmpuri, deci adevărul nu intră în serviciu (există un test pentru asta).

## La demo: o singură comandă

```sh
cd vision
DEMO_TOKEN=... ./run_live.sh                                  # worker-ul local, http://127.0.0.1:8788
CLARION_URL=https://clarion-backend.bogdan-c-2206.workers.dev DEMO_TOKEN=... ./run_live.sh   # backend-ul de pe Cloudflare
```

Pornește serviciul cu detectorul simulat din Unity (D0), ca `client=vision`, și trimite `flow.report` cu prognoză, `crowd.positions` și, la `evacuate`, `evac.plan`. Unity trebuie să scrie canalul camerelor: exe-ul cu `-cctv-live -cctv-live-fps 0`, iar în editor `Craiova.Life.CctvLive.Begin(null, null, null, 0f, 2f)` după intrarea în Play. Serviciul așteaptă `manifest.json` și poate fi pornit înaintea lui Unity. Nu rula în paralel alt `client=vision` (de exemplu `e2e.mjs fakevision`). Logul e în `runs/live_<ora>.log`, iar argumentele în plus merg la serviciu (`--no-ml`, `--live-dir`). Cu `./run_live.sh --frames` serviciul trimite și `camera.frame`: imaginile a 4 camere din Unity cu cutiile YOLO desenate, pentru dashboard (`clarion_vision/camera_feed.py`; doar afișare, cifrele din `flow.report` nu vin din ele). Unity trebuie pornit și cu `-cctv-live-cams security_queue,checkin_overview,hall_east,upper_4 -cctv-live-fps 1`. YOLO rulează pe GPU dacă Unity lasă 1,5 GB liberi (1 cadru/s pe cameră), altfel pe CPU (un cadru la 2 s pe cameră, ~0,25 s fiecare). Verificare fără Unity, pe fișierele unei rulări înregistrate: `SMOKE_SOURCE=replay SMOKE_RUN=<folder din clarion_runs> python tools/smoke_local.py`.

## Cum se rulează

Mediul pe PC-ul lui Marius e `craiova-ml` (are YOLO; `websockets`, `pytest` și `lightgbm` au fost adăugate). Trebuie activat sau rulat cu `conda run`: fără `Library/bin` în `PATH`, numpy se oprește cu excepția Windows `0xc06d007f` la prima înmulțire de matrici.

```sh
conda activate craiova-ml
cd vision
python -m pytest -q                     # testele, ~1 min

# Backend local (din worker/), într-un alt terminal:
#   npm run dev -- --ip 127.0.0.1 --port 8799 --var DEMO_TOKEN:local-smoke --var SIM_SPEED:10
export CLARION_URL=http://127.0.0.1:8799  DEMO_TOKEN=local-smoke

python tools/smoke_local.py             # tot lanțul contra worker-ului: Unity fals + sursa sintetică; PASS/FAIL pe fiecare pas
SMOKE_SOURCE=live python tools/smoke_local.py         # la fel, prin aceleași fișiere pe care le scrie Unity
python -m clarion_vision.service --source synthetic   # fără Unity: oameni inventați, doar pentru instalație
python -m clarion_vision.service --source live        # detectorul simulat din Unity (D0, varianta de rezervă)
python -m clarion_vision.service --source yolo        # YOLO + ByteTrack pe cadrele din Unity
python -m clarion_vision.service --source yolo --hybrid   # YOLO pe camerele cu cadre, detector simulat pe restul

# A11, pe rulările din data/interim/clarion_runs/ (din craiova-3d-model): scrie models/ și models/accuracy.json
python -m clarion_vision.ml.train <folderul cu rulări> --workers 4
python tools/calibrate_detector.py <export etichetat>   # parametrii detectorului simulat, din YOLO față de etichete
```

Worker-ul local ține starea în `worker/.wrangler/state`. Dacă rulează două instanțe, ele o împart (abonații unuia ajung la celălalt), deci pentru teste folosește și `--persist-to <folder cu cale scurtă>`: o cale lungă depășește limita Windows pentru fișierele Durable Object, iar worker-ul răspunde 500 la orice cerere. Serviciul încarcă singur `models/` dacă există; `--no-ml` rulează doar fizica. YOLO rulează pe GPU doar dacă Unity lasă cel puțin 1,5 GB liberi, altfel pe CPU (`--device auto`, ~300 ms pe cadru la 960 px).

URL-ul și token-ul vin doar din `CLARION_URL` și `DEMO_TOKEN`. Token-ul nu apare în loguri și nu se pune în fișiere. Pentru backend-ul de pe Cloudflare: `CLARION_URL=https://clarion-backend.bogdan-c-2206.workers.dev`.

Unity scrie canalul camerelor local, în `data/interim/cctv_live/` din `craiova-3d-model` (`-cctv-live`, `Runtime/Life/CctvLive.cs`). Alte locuri: `CLARION_CCTV_LIVE`, `CLARION_UNITY_REPO`. Serviciul așteaptă până apare `manifest.json`. Modul e scris în log: `detector=simulated`, `yolo` sau `synthetic`. Cifrele din modul simulat sau sintetic nu se prezintă drept cifre YOLO.

## Ce face fiecare pas

| Pas | Algoritm | Fișier | Trimite | Stare |
|---|---|---|---|---|
| Detecție (A1) | YOLO11s COCO + ByteTrack, picior → podea prin lentilă și `H_image_to_floor` | `sources/yolo.py`, `geometry.py` | `crowd.positions` | merge pe cadre exportate (`tools/yolo_check.py`), neevaluat: exportul de până acum nu are etichete |
| Detector simulat (D0) | boxe din Unity, aceeași schemă și același drum spre podea | `sources/live_files.py` | `crowd.positions` | merge live cu Unity (canalul camerelor plus jurnalul detectorului) |
| Corecția numărătorii (A2) | LightGBM pe rezidual | `ml/runtime.py`, `ml/train.py` | | antrenat pe rulările din Unity, vezi `RESULTS.md` |
| Număr și flux (A3) | Kalman `[n, λ]`, urme care intră și ies la capul cozii | `kalman.py`, `chain.py` | `waiting`, `waitingSd`, `density`, `coverage` | merge |
| Așteptarea acum (A4) | coadă ÷ (μ pe linie × linii), μ măsurat la cap pe 5 min, p90 din abateri, corecție ML | `wait.py`, `ml/` | `waitMin`, `waitMinP90` | merge; corecția ML antrenată pe rulările din Unity |
| Prognoza (A5) | curbe lognormale × orar, coadă fluidă, corecție ML pe orizont | `forecast.py`, `ml/` | `forecast` | merge; curbele sunt potrivite pe zilele simulate de 3 ore |
| Sfatul (A7) | cele mai puține linii sub țintă în ora următoare, și până când | `advice.py` | `advice` | merge |
| Evacuarea (A9, A10) | flux maxim în timp, pas 5 s, 1,3 oameni/m/s la uși, apoi flux de sumă minimă pentru alocare | `evac.py` | `evac.plan` | merge; comparată cu 16 evacuări din Unity (`RESULTS.md`) |
| Antrenare (A11) | zile simulate, seed-uri ținute deoparte; calibrarea fizicii, apoi LightGBM | `ml/dataset.py`, `ml/calibrate.py`, `ml/train.py` | | rulat pe 39 de rulări din Unity |
| Calibrarea detectorului simulat | YOLO față de etichetele exportului → parametrii `cctv_detector.json` | `tools/calibrate_detector.py` | | rulat pe exportul etichetat; parametrii în `data/cctv_detector.calibrated.json`, neinstalați |

`chain.py` leagă pașii, fără I/O. `service.py` și `backend.py` sunt socketul, polling-ul și buclele. `state.py` ține liniile și zonele blocate. `contract.py` validează mesajele cu aceleași reguli ca backend-ul.

## Alegeri care merită știute

- **Zone trimise:** id-urile fizice (`U_SECURITY_QUEUE`, `U_GATE_2`, ...) și `check_in:1..3`. Nu trimitem `bag_drop:*`: Unity are o singură coadă pe grup. O zonă văzută sub 10 % nu se trimite. `G_CHECKIN_QUEUE` arată cel mai prost grup; `U_SECURITY` și `G_CHECKIN_DESKS` preiau așteptarea cozii lor, altfel dashboard-ul le-ar arăta „necunoscut”.
- **Liniile:** pornim din `initialLanes` din `terminal.json` și adunăm comenzile `staff`, nu citim tabelul de linii din `GET /api/sim`, pentru că acela cheiază după id-ul primit (`security` și `U_SECURITY_QUEUE` se despart). Un id fără grup (`G_CHECKIN_QUEUE`) merge la grupul cu cea mai lungă coadă, ca în Unity.
- **Cameră căzută:** filtrul continuă din fluxuri și abaterea crește. Rândul se trimite cu `coverage: 0`, cel mult 10 min simulate și cât timp abaterea e sub 12 oameni; apoi zona nu se mai trimite.
- **Evacuare:** blocarea unor zone îi scoate pe oamenii din ele, ca în Unity; `T2`, `ALL` sau `TERMINAL` îi scot pe toți. Doar ei intră în `clearSec`, iar ceilalți rămân și încetinesc mersul prin densitate. Nimeni nu intră într-o zonă blocată, dar cei dinăuntru pot ieși prin ea. Un nod primește o singură rută: fluxul poate împărți o zonă pe două uși, iar ruta urmează partea mai mare. Lifturile nu se folosesc.
- **Zone fără cameră la evacuare (`unseen.py`):** rămân „necunoscut” peste tot și nu intră niciodată în `flow.report`. Doar pentru sursele din A9 le estimăm, cu încredere mică, altfel timpul de golire ar ieși prea mic: airside din orar (pasagerii zborurilor rămase × cât s-au prezentat × scara măsurată de camere, minus cei din coada de securitate și cei văzuți airside), landside din densitatea holurilor văzute. Planul spune asta: `partlyEstimated`, `peopleSeen`, `peopleEstimated` sunt câmpuri în plus în `evac.plan`, pe care backend-ul le ignoră azi.
- **Presupuneri:** oamenii pornesc eșalonat, după regulile din Unity: calmi 15–35 s, cu bagaje 30–60 s, filmând 50–100 s, grupurile care se regrupează 60–120 s (ponderile sunt o primă estimare). Datele nu au lățimi de coridor, așa că lățimea unei zone e latura pătratului cu aria ei, între 2 și 10 m. Rata inițială μ (securitate 1,6, check-in 0,73 oameni/min pe linie) și curbele de prezentare vin dintr-o singură rulare din Unity (seed 0) și sunt înlocuite de `models/calibration.json` când există; μ e înlocuit oricum de măsurătoare în câteva minute.
- **YOLO la viteză mare:** peste 2,5 s simulate între două cadre ale unei camere, urmele nu mai sunt de încredere, deci nu se măsoară fluxuri și μ rămâne pe ultima valoare. Detectorul simulat nu are problema asta, fiindcă id-urile lui urmează persoana.
- **Coada care depășește inelul:** oamenii de dincolo de inelul cozii nu intră în numărătoare. Corecția A2 e singura care poate învăța asta.
- **Etichetele de antrenare:** adevărul din Unity e citit doar de `ml/dataset.py` și `ml/calibrate.py`, offline. Serviciul live nu le importă.

## Stare și ce lipsește

Cifrele de acuratețe față de adevărul din Unity sunt în [`RESULTS.md`](RESULTS.md): numărare, așteptare și prognoză pe coadă, pe seed-uri ținute deoparte, plus evacuarea (A9) pe 16 rulări și rularea YOLO pe exportul etichetat. Toate vin din date simulate, cu detectorul simulat. Ce lipsește:
- detectorul simulat folosește încă parametrii inițiali, nu cei potriviți pe YOLO (`data/cctv_detector.calibrated.json`); pentru a-i folosi trebuie refăcute rulările de antrenare;
- prognoza la securitate are erori de ~9-11 min;
- planul de evacuare e prea pesimist la cozile mici de check-in.

# vision/: serviciul de vision al lui Clarion

Serviciul lui Marius (Python). Citește camerele, calculează cozile, timpii, prognoza și evacuarea și le trimite backend-ului ca client WebSocket separat (`client=vision`). Algoritmii sunt în [`docs/SPEC-v2.md`](../docs/SPEC-v2.md), secțiunea „Algoritmi” (A1–A11), iar mesajele în secțiunea „Contractul”.

Intrările lui sunt doar camerele, orarul de zboruri și deciziile adminului (D0). `GET /api/sim` conține și adevărul din Unity: `state.SimView` păstrează o listă albă de câmpuri, deci adevărul nu intră în serviciu (există un test pentru asta).

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
python -m clarion_vision.service --source synthetic   # fără Unity: oameni inventați, doar pentru instalație
python -m clarion_vision.service --source live        # detectorul simulat din Unity (D0, varianta de rezervă)
python -m clarion_vision.service --source yolo        # YOLO + ByteTrack pe cadrele din Unity
python -m clarion_vision.service --source yolo --hybrid   # YOLO pe camerele cu cadre, detector simulat pe restul
```

URL-ul și token-ul vin doar din `CLARION_URL` și `DEMO_TOKEN`. Token-ul nu apare în loguri și nu se pune în fișiere. Pentru backend-ul de pe Cloudflare: `CLARION_URL=https://clarion-backend.bogdan-c-2206.workers.dev`.

Unity scrie canalul camerelor local, în `data/interim/cctv_live/` din `craiova-3d-model` (`-cctv-live`, `Runtime/Life/CctvLive.cs`). Alte locuri: `CLARION_CCTV_LIVE`, `CLARION_UNITY_REPO`. Serviciul așteaptă până apare `manifest.json`. Modul e scris în log: `detector=simulated`, `yolo` sau `synthetic`. Cifrele din modul simulat sau sintetic nu se prezintă drept cifre YOLO.

## Ce face fiecare pas

| Pas | Algoritm | Fișier | Trimite | Stare |
|---|---|---|---|---|
| Detecție (A1) | YOLO11s COCO + ByteTrack, picior → podea prin lentilă și `H_image_to_floor` | `sources/yolo.py`, `geometry.py` | `crowd.positions` | scris; vezi secțiunea „Stare” |
| Detector simulat (D0) | boxe din Unity, aceeași schemă și același drum spre podea | `sources/live_files.py` | `crowd.positions` | citit și testat pe schemă |
| Corecția numărătorii (A2) | LightGBM | | | nu e făcut |
| Număr și flux (A3) | Kalman `[n, λ]`, urme care intră și ies la capul cozii | `kalman.py`, `chain.py` | `waiting`, `waitingSd`, `density`, `coverage` | merge |
| Așteptarea acum (A4) | coadă ÷ (μ pe linie × linii), μ măsurat la cap pe 5 min, p90 din abateri | `wait.py` | `waitMin`, `waitMinP90` | merge, fără corecția ML |
| Prognoza (A5) | curbe lognormale × orar, coadă fluidă | `forecast.py` | `forecast` | merge, cu curbe presupuse, nemăsurate; fără corecția ML |
| Sfatul (A7) | cele mai puține linii sub țintă în ora următoare, și până când | `advice.py` | `advice` | merge |
| Evacuarea (A9, A10) | flux maxim în timp, pas 5 s, 1,3 oameni/m/s la uși, apoi flux de sumă minimă pentru alocare | `evac.py` | `evac.plan` | merge |
| Antrenare (A11) | zile simulate, seed-uri ținute deoparte | | | nu e făcut, așteaptă rulările din Unity |

`chain.py` leagă pașii, fără I/O. `service.py` și `backend.py` sunt socketul, polling-ul și buclele. `state.py` ține liniile și zonele blocate. `contract.py` validează mesajele cu aceleași reguli ca backend-ul.

## Alegeri care merită știute

- **Zone trimise:** id-urile fizice (`U_SECURITY_QUEUE`, `U_GATE_2`, ...) și `check_in:1..3`. Nu trimitem `bag_drop:*`: Unity are o singură coadă pe grup. O zonă văzută sub 10 % nu se trimite. `G_CHECKIN_QUEUE` arată cel mai prost grup; `U_SECURITY` și `G_CHECKIN_DESKS` preiau așteptarea cozii lor, altfel dashboard-ul le-ar arăta „necunoscut”.
- **Liniile:** pornim din `initialLanes` din `terminal.json` și adunăm comenzile `staff`, nu citim tabelul de linii din `GET /api/sim`, pentru că acela cheiază după id-ul primit (`security` și `U_SECURITY_QUEUE` se despart). Un id fără grup (`G_CHECKIN_QUEUE`) merge la grupul cu cea mai lungă coadă, ca în Unity.
- **Cameră căzută:** filtrul continuă din fluxuri și abaterea crește. Rândul se trimite cu `coverage: 0`, cel mult 10 min simulate și cât timp abaterea e sub 12 oameni; apoi zona nu se mai trimite.
- **Evacuare:** nimeni nu intră într-o zonă blocată, dar cei dinăuntru pot ieși prin ea. Zonele fără cameră intră cu 0 oameni, nu cu un număr inventat, iar logul spune câte sunt. Un nod primește o singură rută: fluxul poate împărți o zonă pe două uși, iar ruta urmează partea mai mare. Lifturile nu se folosesc.
- **Presupuneri:** timpul de reacție e de 30 s. Datele nu au lățimi de coridor, așa că lățimea unei zone e latura pătratului cu aria ei, între 2 și 10 m. Rata inițială μ (securitate 2,5, check-in 0,6 oameni/min pe linie) e un punct de pornire, înlocuit de măsurătoare în câteva minute. Curbele de prezentare sunt estimări până la calibrarea pe zile simulate.

## Stare și ce lipsește

Vezi tabelul. Niciun număr de acuratețe față de adevărul din Unity nu există încă: testele cu sursa sintetică verifică instalația pe oameni inventați și nu spun nimic despre aeroport.

# Harta aeroportului Craiova (T2) pentru frontend

Generată din modelul Unity și din datele simulării (`pipeline/scripts/t2_map_export.py`). Nordul e sus, estul la dreapta.

## Fișiere

| Fișier | Ce este |
|---|---|
| `map_parter_zones.png`, `map_etaj1_zones.png`, `map_exterior_zones.png` | Hărțile de citit: zonele colorate, cu cod și legendă |
| `map_parter.svg`, `map_etaj1.svg`, `map_exterior.svg` | Pentru interfață: fiecare zonă e un `<path id="ZONE_ID">`, deci se colorează și se dă hover direct din cod |
| `base_parter.png`, `base_etaj1.png`, `base_exterior.png` | Fundalul curat, randat de sus din Unity. SVG-urile îl încarcă din același folder |
| `zones.json` | Toate zonele: id, nume RO/EN, etaj, tip, poligoane în metri și în pixeli, ce valori arată |
| `points.json` | Uși, ieșiri, scări, lifturi, ghișee, porți, magazine și camere CCTV (poziție, orientare, câmp vizual) |

## Etaje și coordonate

Simularea dă pozițiile în metri: `x` spre est, `z` spre nord, plus etajul (`G`, `U` sau `X`). Conversia în pixeli, pentru imaginea etajului respectiv:

```
px = (x - x0) * ppm
py = (z1 - z) * ppm
```

| Imagine | Etaj | x0 | x1 | z0 | z1 | ppm (pixeli/metru) | Dimensiune |
|---|---|---|---|---|---|---|---|
| parter | `G` | 6160 | 6460 | -545 | -440 | 10 | 3000 x 1050 |
| etaj1 | `U` | 6160 | 6460 | -545 | -440 | 10 | 3000 x 1050 |
| exterior | `X` | 6110 | 6640 | -700 | -380 | 4 | 2120 x 1280 |

Parterul și etajul 1 au același cadru, deci se suprapun exact dacă vrei să comuți între ele. Aceleași valori sunt și în `zones.json` -> `frames`.

## Zone

Tipul decide culoarea (`zones.json` -> `kinds`). Steaua înseamnă că zona nu a fost filmată, deci forma și poziția sunt aproximative.

### Parter

| Cod | Id | Nume | Tip | Parte | m² | Valori de afișat |
|---|---|---|---|---|---|---|
| G1 | `G_CHECKIN_DESKS` | Ghișee check-in + bag drop | service | landside | 143 | câți oameni sunt în zonă, timp de servire median, câți trec în 15 min, ghișee deschise |
| G2 | `G_CHECKIN_QUEUE` | Cozi check-in + bag drop | queue | landside | 288 | câți oameni sunt în zonă, oameni / m², lungimea cozii, timp de așteptare median, timp de așteptare p90, câți trec în 15 min |
| G3 | `G_ARRIVALS_EXIT` | Ieșire sosiri (din bagaje) | circulation | landside | 45 | câți oameni sunt în zonă, oameni / m², câți trec în 15 min |
| G4 | `G_INFO` | Informații | service | landside | 116 | câți oameni sunt în zonă, oameni / m² |
| G5 | `G_ESCALATOR` | Scări + escalator spre securitate | stairs | landside | 123 | câți oameni sunt în zonă, oameni / m², câți trec în 15 min |
| G6 | `G_STAIRS_WEST` | Scări vest | stairs | landside | 61 | câți oameni sunt în zonă, oameni / m² |
| G7 | `G_WC` | Toalete * | wc | landside | 12 | câți oameni sunt în zonă, oameni / m² |
| G8 | `G_CAFE` | Gourmet Bar (capăt est) | shops | landside | 198 | câți oameni sunt în zonă, oameni / m² |
| G9 | `G_DEPARTURES` | Intrare plecări + self check-in | circulation | landside | 536 | câți oameni sunt în zonă, oameni / m² |
| G10 | `G_CENTER` | Hol central | circulation | landside | 733 | câți oameni sunt în zonă, oameni / m² |
| G11 | `G_MEETING` | Zonă de așteptare sosiri | waiting | landside | 685 | câți oameni sunt în zonă, oameni / m² |
| G12 | `G_WEST` | Hol vest (închirieri auto, Lost & Found) | circulation | landside | 727 | câți oameni sunt în zonă, oameni / m² |
| G13 | `G_RECLAIM_1` | Bagaje - banda 1 * | reclaim | airside | 641 | câți oameni sunt în zonă, oameni / m², așteptare bagaj mediană, așteptare bagaj p90 |
| G14 | `G_RECLAIM_2` | Bagaje - banda 2 * | reclaim | airside | 651 | câți oameni sunt în zonă, oameni / m², așteptare bagaj mediană, așteptare bagaj p90 |
| G15 | `G_ARRIVALS_PASSPORT` | Coridor sosiri + pașapoarte * | queue | airside | 105 | câți oameni sunt în zonă, oameni / m², lungimea cozii, timp de așteptare median, timp de așteptare p90, câți trec în 15 min |
| G16 | `G_GATE_DOOR_1` | Ușă peron poarta 1 * | stairs | airside | 22 | câți trec în 15 min |
| G17 | `G_GATE_DOOR_2` | Ușă peron poarta 2 * | stairs | airside | 22 | câți trec în 15 min |
| G18 | `G_GATE_DOOR_6` | Ușă peron poarta 6 * | stairs | airside | 22 | câți trec în 15 min |
| G19 | `G_GATE_DOOR_7` | Ușă peron poarta 7 * | stairs | airside | 22 | câți trec în 15 min |
| G20 | `G_GATE_DOOR_8` | Ușă peron poarta 8 * | stairs | airside | 22 | câți trec în 15 min |
| G21 | `G_GATE_DOOR_9` | Ușă peron poarta 9 * | stairs | airside | 22 | câți trec în 15 min |
| G22 | `G_GATE_DOOR_10` | Ușă peron poarta 10 * | stairs | airside | 22 | câți trec în 15 min |

### Etaj 1

| Cod | Id | Nume | Tip | Parte | m² | Valori de afișat |
|---|---|---|---|---|---|---|
| U1 | `U_SECURITY_QUEUE` | Coadă securitate | queue | landside | 154 | câți oameni sunt în zonă, oameni / m², lungimea cozii, timp de așteptare median, timp de așteptare p90, câți trec în 15 min |
| U2 | `U_SECURITY` | Control de securitate (benzi) * | service | landside | 365 | câți oameni sunt în zonă, timp de servire median, câți trec în 15 min, benzi deschise |
| U9 | `U_ESCALATOR_TOP` | Capăt scări + escalator | stairs | landside | 39 | câți oameni sunt în zonă, oameni / m², câți trec în 15 min |
| U3 | `U_CONCOURSE` | Galerie landside | circulation | landside | 610 | câți oameni sunt în zonă, oameni / m² |
| U4 | `U_PASSPORT_DEP` | Control pașapoarte plecări * | queue | airside | 164 | câți oameni sunt în zonă, oameni / m², lungimea cozii, timp de așteptare median, timp de așteptare p90, câți trec în 15 min |
| U5 | `U_DUTY_FREE` | Duty free * | shops | airside | 180 | câți oameni sunt în zonă, oameni / m² |
| U6 | `U_CAFE` | Cafenea airside * | shops | airside | 96 | câți oameni sunt în zonă, oameni / m² |
| U7 | `U_WC` | Toalete airside * | wc | airside | 42 | câți oameni sunt în zonă, oameni / m² |
| U8 | `U_CORRIDOR_EAST` | Coridor airside (peste check-in) * | circulation | airside | 618 | câți oameni sunt în zonă, oameni / m² |
| P1 | `U_GATE_1` | Poarta 1 (non-Schengen) * | gate | airside | 364 | câți oameni sunt în zonă, oameni / m², coadă la îmbarcare, timp de așteptare median |
| P2 | `U_GATE_2` | Poarta 2 (non-Schengen) * | gate | airside | 363 | câți oameni sunt în zonă, oameni / m², coadă la îmbarcare, timp de așteptare median |
| P3 | `U_GATE_3` | Poarta 3 (non-Schengen) * | gate | airside | 339 | câți oameni sunt în zonă, oameni / m², coadă la îmbarcare, timp de așteptare median |
| P4 | `U_GATE_4` | Poarta 4 (Schengen) * | gate | airside | 227 | câți oameni sunt în zonă, oameni / m², coadă la îmbarcare, timp de așteptare median |
| P5 | `U_GATE_5` | Poarta 5 (Schengen) * | gate | airside | 184 | câți oameni sunt în zonă, oameni / m², coadă la îmbarcare, timp de așteptare median |
| P6 | `U_GATE_6` | Poarta 6 (Schengen) * | gate | airside | 362 | câți oameni sunt în zonă, oameni / m², coadă la îmbarcare, timp de așteptare median |
| P7 | `U_GATE_7` | Poarta 7 (Schengen) * | gate | airside | 268 | câți oameni sunt în zonă, oameni / m², coadă la îmbarcare, timp de așteptare median |
| P8 | `U_GATE_8` | Poarta 8 (Schengen) * | gate | airside | 318 | câți oameni sunt în zonă, oameni / m², coadă la îmbarcare, timp de așteptare median |
| P9 | `U_GATE_9` | Poarta 9 (Schengen) * | gate | airside | 361 | câți oameni sunt în zonă, oameni / m², coadă la îmbarcare, timp de așteptare median |
| P10 | `U_GATE_10` | Poarta 10 (Schengen) * | gate | airside | 364 | câți oameni sunt în zonă, oameni / m², coadă la îmbarcare, timp de așteptare median |

### Exterior

| Cod | Id | Nume | Tip | Parte | m² | Valori de afișat |
|---|---|---|---|---|---|---|
| X1 | `X_KERB_DEPARTURES` | Bordură plecări * | kerb | landside | 262 | câți oameni sunt în zonă, oameni / m², vehicule, cât stau vehiculele |
| X2 | `X_KERB_ARRIVALS` | Bordură sosiri * | kerb | landside | 144 | câți oameni sunt în zonă, oameni / m², vehicule, cât stau vehiculele |
| X3 | `X_TAXI_RANK` | Stație taxi * | queue | landside | 427 | câți oameni sunt în zonă, oameni / m², taxiuri la rând |
| X4 | `X_BOLT` | Preluare Bolt * | kerb | landside | 97 | câți oameni sunt în zonă, oameni / m², vehicule |
| X5 | `X_BUS_221` | Stație autobuz RAT 221 * | waiting | landside | 112 | câți oameni sunt în zonă, oameni / m² |
| A1 | `ASSEMBLY_LANDSIDE_WEST` | Punct adunare vest * | assembly | landside | 447 | câți oameni sunt în zonă, evacuați ajunși aici |
| A2 | `ASSEMBLY_LANDSIDE_EAST` | Punct adunare est * | assembly | landside | 447 | câți oameni sunt în zonă, evacuați ajunși aici |
| A3 | `ASSEMBLY_AIRSIDE` | Punct adunare peron * | assembly | airside | 447 | câți oameni sunt în zonă, evacuați ajunși aici |
| X6 | `X_PARKING_T2` | Parcare T2 | parking | landside | 5702 | vehicule, locuri libere, oameni pe jos |
| X7 | `X_PARKING_EAST` | Parcare est | parking | landside | 4045 | vehicule, locuri libere, oameni pe jos |
| X8 | `X_FORECOURT` | Esplanadă + drum acces * | circulation | landside | 963 | câți oameni sunt în zonă, oameni / m², vehicule |

## Ce e stabilit și ce nu

- Id-urile zonelor sunt cele pe care le va folosi și simularea pentru timpi și aglomerație.
- Fluxul de date live către frontend **nu e definit încă**. Câmpurile din coloana „Valori de afișat” sunt propunerea mea, nu un API existent.
- Etajul 1 după securitate, bagajele și porțile nu au fost filmate: poziția lor e aproximativă și se poate schimba puțin. Id-urile rămân aceleași.
- Harta acoperă T2 și exteriorul lui. T1 nu e inclus, fiindcă fluxurile de pasageri din simulare trec prin T2.

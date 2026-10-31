# vision/: serviciul de vision al lui Clarion

În lucru (Marius). Python. Citește camerele, calculează cozile, timpii, prognoza și evacuarea și le trimite backend-ului ca client WebSocket separat (`client=vision`). Algoritmii sunt descriși în [`docs/SPEC-v2.md`](../docs/SPEC-v2.md), secțiunea „Algoritmi” (A1–A11), iar mesajele în secțiunea „Contractul”.

| Pas | Algoritm | Trimite |
|---|---|---|
| Detecție (A1) | YOLO11 reantrenat pe cadre CCTV, ByteTrack, omografie spre podea | `crowd.positions` |
| Corecția numărătorii (A2) | LightGBM | |
| Număr și flux pe zonă (A3) | filtru Kalman cu conservarea fluxului | `flow.report`: `waiting`, `waitingSd`, `density` |
| Așteptarea acum (A4) | oamenii din coadă ÷ (rata pe linie × linii), cu corecție ML | `flow.report`: `waitMin`, `waitMinP90` |
| Prognoza (A5) | curbe de prezentare × orar, coadă fluidă, corecție ML | `flow.report`: `forecast` |
| Sfatul pentru linii (A7) | cele mai puține linii care țin prognoza sub țintă | `flow.report`: `advice` |
| Evacuarea (A9, A10) | flux maxim pe graful terminalului extins în timp, rute pe ieșiri după capacitate | `evac.plan` |
| Antrenare (A11) | zile simulate cu seed-uri diferite, adevărul din Unity ca etichete | |

În demo, camerele sunt cele virtuale din simularea Unity. Serviciul nu primește niciodată adevărul din simulare: acela merge direct de la Unity la backend (`truth.report`), doar pentru măsurarea acurateței.

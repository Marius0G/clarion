# Alerte admin — D32

Contract comun backend Node și Worker, calculat în `backend/src/alerts.ts` prin `SimStore`.
Unity nu primește aceste comenzi. `ops.command` și `ops.ack` rămân neschimbate.

## Snapshot și flux

`GET /api/sim` include câmpul nou `alerts: Alert[]`. `GET /api/state` și mesajele
WebSocket existente `{"type":"state","ts":"<ISO-8601>","data":{...}}` includ
același câmp la `data.alerts`. Consola poate folosi polling-ul existent pentru
`/api/sim`; acesta recalculează inclusiv pierderea camerelor. Evenimentele `state`
transportă alertele la conectare și la schimbările de stare/comenzi/rapoarte.
Nu există un flux nou obligatoriu. Lista include jurnalul: alertele inactive
confirmate rămân în listă. Pentru lista de intervenții afișați
`active || state !== "acked"`; pentru jurnal afișați toate.

Forma exactă `Alert` (toate câmpurile sunt întotdeauna prezente):

```ts
{
  id: string;                       // stabil, kind + subiect canonic
  priority: "P1" | "P2" | "P3";
  kind: "zone-target" | "forecast-target" | "density" |
        "staff-security" | "staff-report" | "flight-risk" | "camera-loss";
  zoneId: string | null;            // id de hartă / alias din raport
  flight: string | null;            // numai la flight-risk
  text: string;                     // etichetă scurtă în română
  numbers: { [key: string]: number };
  createdAt: number;                // secunde simTime, NU epoch / ISO
  updatedAt: number;                // secunde simTime
  state: "unacked" | "acked" | "cleared-unacked" | "shelved";
  active: boolean;                 // condiția există acum
  adviceId: string | null;
  shelvedUntil: number | null;      // secunde simTime
  shelveReason: string | null;
}
```

Exemplu (fragment de snapshot):

```json
{
  "simTime": 54900,
  "alerts": [{
    "id": "zone-target:U_SECURITY_QUEUE",
    "priority": "P2",
    "kind": "zone-target",
    "zoneId": "security",
    "flight": null,
    "text": "Țintă depășită",
    "numbers": { "waitMin": 12.4, "targetMin": 10 },
    "createdAt": 54600,
    "updatedAt": 54900,
    "state": "unacked",
    "active": true,
    "adviceId": null,
    "shelvedUntil": null,
    "shelveReason": null
  }]
}
```

`adviceId` leagă un sfat identificat, dacă există. Contractul vision actual are
`advice {lanes, by, waitMinIfNot}` fără id; în acest caz câmpul este `null`.
Nu se inventează un id de sfat; UI poate lega sfatul existent prin `zoneId`.

## Confirmare și amânare

În ambele runtime-uri: `POST /api/alerts/command`, `Content-Type: application/json`,
`Authorization: Bearer <DEMO_TOKEN>` când tokenul este configurat. Comanda
funcționează și când Unity este deconectat. Răspuns `200 {"alerts":[...]}`;
comandă invalidă, id necunoscut sau lipsă simTime: `400 {"error":"..."}`;
token absent/greșit: `401`.

Confirmare:

```json
{"type":"ack","id":"zone-target:U_SECURITY_QUEUE"}
```

Amânare (durata în secunde de simulare, >0 și ≤86400; motiv obligatoriu,
1–200 caractere după eliminarea spațiilor de la capete):

```json
{"type":"shelve","id":"zone-target:U_SECURITY_QUEUE","durationSec":600,"reason":"Verificare cameră"}
```

Aceleași date pot fi trimise pe WebSocket-ul autentificat `client=console`
sau prin endpoint-ul existent `POST /api/action`, în acest envelope:

```json
{
  "type":"console.alert.command",
  "ts":"2026-11-01T00:00:00.000Z",
  "data":{"type":"ack","id":"zone-target:U_SECURITY_QUEUE"}
}
```

Doar consola poate trimite `console.alert.command`; `viewer`, `vision` și
`twin` nu pot confirma sau amâna alerte. Nu trimiteți comanda ca `ops.command`.

## Reguli și cifre

| kind | Prioritate | Condiție | numbers |
|---|---|---|---|
| zone-target | P2 | `waitMin > 10` securitate / `> 15` check-in, bag drop | waitMin, targetMin |
| forecast-target | P3 | prima prognoză peste țintă, `0 < inMin <= 60` | waitMin, targetMin, inMin, at (simTime) |
| density | P1 | `density > 3` mișcare / `> 5` staționare | density, threshold |
| staff-security | P1 | raport deschis `securitate` sau `bagaj_abandonat` | reports (număr de rapoarte deschise) |
| staff-report | P2 | alt raport deschis | reports |
| flight-risk | P2 | estimare camera >0, poarta închide în ≤max(15, cozi+5) minute | estimatedBeforeSecurity, minutesToClose, waitMin, estimated: 1 |
| camera-loss | P3 | zonă vision stale (>5s fără raport) sau coverage=0 | {} |

Staționare: securitate, check-in, bag drop, porți, zone de așteptare, recuperare
bagaje; celelalte zone folosesc pragul de mișcare. Comparațiile sunt stricte.
Datele stale și `coverage=0` produc numai camera-loss, nu valori vechi periculoase.
O zonă care nu a fost raportată vreodată nu are încă o cameră cunoscută de pierdut.

Estimarea de zbor este conservatoare, nu o numărare per zbor: suma persoanelor
din coada de securitate și din grupul de check-in/bag drop al zborului, limitată
la `flight.pax` dacă este cunoscut. Cozile comune pot include alte zboruri și
pot avea suprapunere; cifra este explicit estimată (`estimated: 1`). Nu prezentați
această cifră ca poziții reale ale pasagerilor acelui zbor. Lipsa camerei nu
înseamnă zero pasageri; în acel caz rămâne alerta de cameră. Se aplică `delayMin`
la închiderea porții; zborurile anulate, plecate sau cu poarta deja închisă sunt
excluse. Marja de mers folosită este 5 minute, pragul minim „aproape” este 15.

D0: numai rânduri `flow.report` cu `source=vision`, orarul și rapoartele staff.
`truth.report`, `agent.batch.stage` și fallback-ul legacy `source=twin` nu
alimentează niciun trigger. Până la primul `sim.status` nu se creează alerte:
ceasul real nu înlocuiește simTime. Detectarea staleness folosește timeout-ul
existent al transportului; timestamp-urile și amânările folosesc numai simTime.

Worker-ul conectează automat rapoartele WhatsApp la alerte, inclusiv închiderea
lor. Backend-ul Node acceptă rapoarte prin `POST /api/reports` (operator token),
cu `{id, kind, node, text, status:"open"|"closed"}`; același id înlocuiește
raportul anterior. `GET /api/reports` este autentificat. Lista Node este în
memorie; Worker păstrează rapoartele în storage-ul existent.

## Lifecycle și deduplicare

- O condiție nouă → `unacked`. Același `(kind, zonă/zbor)` își păstrează id-ul
  și `createdAt`; se actualizează cifrele, fără alerte repetate. Aliasurile de
  hartă sunt normalizate; check-in și bag drop rămân cozi distincte.
- Confirmarea → `acked`. Rămâne activă până dispare condiția.
- Revenire la normal: `unacked` → `cleared-unacked`; `acked` rămâne `acked`,
  cu `active=false`. Confirmarea unei alerte revenite → `acked, active=false`.
- Reapariția după revenire → `unacked`, cu același id. Un nou raport staff în
  același grup cere din nou confirmare; retransmiterea aceluiași raport nu cere.
- Amânarea → `shelved`, cu termen și motiv. Expirarea → `unacked` dacă activă,
  altfel `cleared-unacked`. Confirmarea în timpul amânării anulează timerul.
- `updatedAt` se schimbă la cifre/stare noi, nu la fiecare polling identic.
- Alertele sunt în memorie, ca telemetria sim; resetul demo sau restartul DO
  șterg lifecycle-ul. Rapoartele staff persistate sunt reîncărcate la pornire.
  Persistența jurnalului de alerte peste restart nu este implementată.

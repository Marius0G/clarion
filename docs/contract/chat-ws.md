# Conversație live: `/m` și `/s`

Contract identic în Worker (Durable Object Tower) și backend Node (`ws`). Mesajele personale sunt JSON la nivelul rădăcinii, fără plicul `data` folosit de consolă.

## Conectare

1. `POST /api/chat/ticket`, cu `Authorization: Bearer <sesiune D3>`, întoarce `{ "ticket": "...", "expiresIn": 60 }`. Nu cere corp. Ticket-ul este de unică folosință, expiră după 60 secunde reale și este legat de telefon, rol și sesiunea emitentă.
2. Deschide `wss://<backend>/ws?client=person&ticket=<ticket>`. Ticket-ul este consumat atomic. Pentru fiecare reconectare cere unul nou. Ticket invalid, expirat, folosit, sesiune revocată sau rol schimbat: upgrade urmat de close **4401**.
3. Prima livrare este `{ "type": "history", "entries": [...] }`, ultimele 50 de intrări din istoricul comun WhatsApp/web și alerte. Mai multe socket-uri pot folosi același telefon, fiecare cu propriul ticket.

Worker acceptă socket-urile cu tag `person:<telefon E.164>` și păstrează telefonul/rolul/sesiunea în attachment, folosind hibernarea existentă. Nu depinde de un registru de conexiuni în memorie. Codul de închidere anormală 1006 folosește tratarea D31 existentă.

## Server → browser

- `{ "type": "chat", "entry": { "id": "...", "role": "user|clarion", "text": "...", "at": "HH:MM", "timestamp": 123, "channel": "whatsapp|web", "buttons": [{ "id": "...", "title": "..." }], "image": "https://..." } }`. `buttons`, `image` și timestamp-ul pentru istoricul vechi sunt opționale. Evenimentul urmează persistarea intrării; un turn poate avea mai multe bule. Include intrările WhatsApp, turnurile web, alertele proactive, schimbările de zbor, evacuarea și notificările de raport. Turnurile web obișnuite nu trimit mesaje WhatsApp: rămân context comun prin `wa:ctx:<telefon>` / `chatHistory` pentru următoarea conversație WhatsApp. Toate socket-urile telefonului primesc în continuare intrarea web ca eveniment `chat`.
- `{ "type": "report", "report": { ... } }`: raportul propriu când se schimbă, inclusiv crearea. Staff vede numai rapoartele telefonului său.
- `{ "type": "me" }`: invalidare; recitește `/api/me` (și `/api/staff` pentru staff). Se trimite după turnuri, asocierea zborului, `flight.update` și `sim.status` (etapa estimată din ceas). Poate apărea și când datele relevante nu s-au schimbat.
- `{ "type": "typing", "on": true|false }`: agentul începe/termină un turn pentru telefonul respectiv, indiferent de canal; `false` apare și la eroare.
- `{ "type": "error", "status": 400|429, "error": "...", "retryAfter": 60 }`: mesaj invalid sau limită. `retryAfter` apare la 429.

Intrările noi au ID persistat; cele vechi primesc un ID derivat stabil din conținut. Browserul unește snapshot-ul și evenimentele după `entry.id`, inclusiv la reconectare. Textul respectă redacția istoricului; link-ul personal generat pentru telefonul respectiv rămâne utilizabil. Socket-urile personale nu primesc niciodată starea consolei sau datele altui telefon. Evenimentele de raport sunt idempotente; browserul actualizează după `report.id`.

## Browser → server

`{ "type": "chat", "text": "...", "replyId": "..." }` execută același turn ca `POST /api/chat`. Text obligatoriu, nevid, maximum 2.000 caractere; `replyId` opțional, maximum 120 caractere. Răspunsurile apar ca evenimente `chat` pe toate socket-urile acelui telefon. Nu există răspuns HTTP pe socket.

Limita comună HTTP/WS este **12 turnuri/minut/sesiune D3**, inclusiv toate ticket-urile și socket-urile acelei sesiuni. Mesajele invalide nu consumă limita. Sesiunea și rolul sunt reverificate înaintea fiecărui mesaj pe socket; la invalidare, close 4401. `POST /api/chat` și `GET /api/chat` rămân fallback.

Heartbeat opțional JSON `{ "type": "ping" }` → `{ "type": "pong" }`, fără consumarea limitei de chat. Nu impune timer nou pentru consolă; reconectarea și obținerea ticket-ului nou rămân responsabilitatea browserului.

Intrările operaționale provin din camere, orar și rapoarte, conform D0; `truth.report` nu generează conversații personale.

## Acțiuni web importante → WhatsApp

WhatsApp Cloud API trimite numai din partea business-ului; nu poate afișa mesajele web ca mesaje proprii ale utilizatorului. Nu oglindim fiecare linie web.

La crearea unui raport de pe site (formular HTTP sau turn de chat HTTP/WS, inclusiv instrumentele agentului), Clarion trimite **un singur mesaj scurt**, cu eticheta categoriei și a locului unite prin ` · `:

> Raportul tău de pe site a fost trimis: Aglomerație · Securitate. Te anunț când echipa îl preia.

Confirmarea se trimite numai în fereastra de customer service de 24h, urmărită prin `wa:last:<telefon>` (ultimul mesaj WhatsApp primit, timp real). La 24h sau mai târziu, ori fără un mesaj WhatsApp anterior, nu se trimite nimic pe WhatsApp și nu se folosește un template. Acțiunile web nu deschid și nu prelungesc această fereastră. Raportul și evenimentele browserului se păstrează și în afara ferestrei. Confirmarea livrată apare în istoricul comun ca mesaj Clarion pe canalul `whatsapp`.

Notificările existente pentru schimbarea stării raportului rămân neschimbate. Orice alt turn web, inclusiv întrebările și răspunsurile agentului, rămâne doar în contextul comun și în evenimentele browserului, fără mesaj WhatsApp.

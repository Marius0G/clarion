# Algoritmii Clarion, pentru pitch

Varianta tehnică e în `docs/SPEC-v2.md`, secțiunea „Algoritmi” (A1–A11). Aici e ce spunem juriului, pe scurt.

## Ideea într-o frază

Clarion vede terminalul doar prin camere, ca un sistem real, și transformă imaginile în trei răspunsuri: cât se stă acum la coadă, cât se va sta peste o oră și cât durează evacuarea. Simularea Unity știe adevărul exact, așa că putem măsura cât de bine ghicim.

## Lanțul, pe un slide

Camere → oameni detectați → număr și flux pe zone → așteptarea acum → prognoza → „când să vii”, sfatul pentru linii, evacuarea → mesaje pe WhatsApp

## Ce face fiecare pas, cu vorbele pentru juriu

| Pas | Ce spunem | De ce e credibil |
|---|---|---|
| Detecția (A1) | „Un model de vision găsește fiecare om în imaginea camerei și îl pune pe harta terminalului.” | YOLO, modelul standard pentru detecție, reantrenat pe imagini de cameră de supraveghere cu zgomot și distorsiuni. |
| Corecția (A2) | „În coada aglomerată oamenii se ascund unii pe alții. Un al doilea model corectează numărătoarea.” | E antrenat pe mii de cadre din simulare, unde știm exact câți oameni sunt. |
| Fluxul (A3) | „Combinăm ce văd camerele cu cine intră și cine iese, ca un GPS care se corectează din mers.” | Filtrul Kalman, metoda clasică din navigație. Dacă o cameră cade, sistemul continuă și spune cât de sigur e. |
| Așteptarea acum (A4) | „Câți oameni sunt în fața ta, împărțit la cât de repede lucrează liniile deschise.” | Se schimbă în secunda în care se deschide o linie nouă. |
| Prognoza (A5) | „Știm orarul zborurilor și cât de devreme vin pasagerii. Din asta calculăm coada de peste 30, 60, 90 și 120 de minute.” | Model de coadă din cercetarea operațională, corectat de ML. Reacționează la întârzieri și la liniile noi. |
| Când să vii (A6) | „Îți spunem ora la care să fii la intrare ca să prinzi poarta, cu o marjă care crește când suntem mai puțin siguri.” | Folosește prognoza pentru ora la care ajungi tu, nu pentru acum. |
| Sfatul (A7) | „Clarion îi spune adminului: deschide o linie până la 14:05, altfel la 14:30 se stă 18 minute.” | Adminul decide. Clarion îl anunță înainte să se formeze coada. |
| Evacuarea (A9, A10) | „Calculăm în cât timp se golește fiecare zonă și împărțim oamenii pe ieșiri, ca nicio ușă să nu se blocheze.” | Capacitățile ușilor vin din standardele de inginerie a focului (SFPE). Flux maxim pe graful terminalului. |
| Învățarea (A11) | „Am antrenat modelele pe zeci de zile simulate, în care știm adevărul. Pe un aeroport real le recalibrăm pe datele lui.” | Seed-uri ținute deoparte pentru test, deci cifrele de acuratețe nu sunt pe datele de antrenare. |

## Cifrele de pe slide (D19)

Aceeași zi simulată, cu și fără Clarion:

1. Așteptarea la securitate (medie și p90) și pasagerii care pierd îmbarcarea.
2. Timpul până se golește zona evacuată (t90 și ultimul ieșit).
3. Acuratețea camerelor: eroarea la numărare și la timpul de așteptare.

Cifrele vin din rulările lui Marius. Până nu le avem, nu le inventăm pe slide.

## Ce nu facem

Nu recunoaștem fețe și nu urmărim persoane de la o cameră la alta. Lucrăm doar cu numărători și fluxuri, așa că sistemul nu știe cine e fiecare om. Asta contează pentru GDPR și pentru aeroport.

## Întrebări probabile

- **„Cum știți că merge pe camere reale?”** Modelul de detecție e pre-antrenat pe imagini reale și reantrenat pe imagini simulate cu defectele camerelor reale. Pe un aeroport, primul pas e recalibrarea pe câteva ore de imagini proprii.
- **„Ce faceți unde nu sunt camere?”** Zona apare ca „necunoscut” și nu primește un număr inventat. Filtrul estimează din cine intră și cine iese, cu o incertitudine afișată.
- **„De ce nu doar ML?”** Modelele de coadă și de flux explică de ce crește coada și reacționează corect la o linie nouă, chiar dacă nu au mai văzut situația. ML-ul corectează doar eroarea lor.

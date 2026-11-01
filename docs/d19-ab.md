# D19: același seed, cu și fără Clarion

Rezultatele testului A/B din simularea Unity (1 nov., ora 04:00). Sunt 12 seed-uri (101–112), în scenariul `rush`: încărcare ×2,5, cu 2 linii de securitate la început. Același seed înseamnă aceeași zi și aceiași pasageri în ambele variante. Cifrele sunt mediane pe perechi de seed-uri.

| Măsură | A: fără Clarion | B: cu Clarion* | B − A |
|---|---|---|---|
| Așteptare la securitate, medie (ferestre de 3 h) | 14,3 min | 7,2 min | −6,6 min |
| Așteptare la securitate, p90 | 31,0 min | 12,3 min | −16,5 min |
| Evacuare: jumătate din oameni ieșiți (t50) | 97 s | 79 s | −22,5 s |
| Evacuare: 90 % ieșiți (t90) | 190 s | 149,5 s | −54,5 s |
| Evacuare: ultimul ieșit | 223,5 s | 177,5 s | −58,5 s |

t90 pe zonă (mediane, A → B):

| Zonă evacuată | A | B |
|---|---|---|
| coada de check-in | 122,5 s | 66,5 s |
| coada de securitate | 224,5 s | 170,5 s |
| tot terminalul | 190,5 s | 149,5 s |

\* **Ce înseamnă B, spus exact pe slide:** în varianta B, o regulă locală ține locul sfatului de la vision, iar adminul îl urmează. Deschide o linie în plus când așteptarea trece de 10 min și închide una sub 3 min; o linie se deschide în 5 min simulate. La evacuare, ieșirile sunt împărțite după capacitatea ușilor. Varianta A păstrează liniile planificate toată ziua, iar fiecare om iese pe cea mai apropiată ușă. Reacția pasagerilor la mesajele Clarion **nu e modelată**.

**Cum se citesc cifrele:**
- La evacuare, cifrele numără doar oamenii aflați în zonă în momentul alarmei, din `kpi.json` (`egress_t90_s`, `last_out_since_alarm_s`). Au ieșit 99,8 % dintre ei în ambele variante; din seed-ul 109 au rămas câte 4 pasageri la îmbarcare.
- Timpii de așteptare vin din ferestre de 3 ore fără alarmă.
- Pasagerii care pierd îmbarcarea **nu intră pe slide**. Sunt identici în A și B (743), pentru că vin dintr-un zbor din cele 4 ore de încălzire dinaintea ferestrei măsurate.

Datele brute, cu tabelul pe fiecare rulare, sunt în repo-ul Unity: `data/interim/clarion_runs/ab/ab_results.{md,json}`.

# Snapshot-pipelinen — designdokument

Allt annat i projektet är rekonstruktion ur stillbilder. Percentilstudien
mäter var affärer sker, omlistningsstudien gissar vad marknaden förkastade.
Ingen av dem kan mäta **säljtid**, **osåld-andel** eller **prissänkningar i
realtid**, eftersom datan är en rad per annons utan livslängd.

Det kräver att samma annons observeras flera gånger. Varje vecka utan
snapshots är omätbar tid som inte går att hämta igen i efterhand.

## Schema

**`snapshots/observations.parquet`** — append-only, en rad per annons och
körning.

| kolumn | typ | beskrivning |
|---|---|---|
| `listing_id` | str | `dedup_key` från källan, annars normaliserad titel |
| `price` | float | priset vid observationstillfället |
| `title` | str | rubriken, för att upptäcka omskrivningar |
| `observed_at` | timestamp (UTC) | körningens tidpunkt, identisk för hela passet |

Inga bilder, inga beskrivningar. Tabellen ska kunna växa dagligen i åratal:
~80 000 aktiva annonser × 4 kolumner ≈ 3 MB per körning komprimerat, alltså
drygt 1 GB per år vid daglig körning.

**`snapshots/runs.parquet`** — en rad per körning (`observed_at`, `listings`).
Den är inte bokföring utan **nödvändig för korrekthet**: utan den går det inte
att skilja "annonsen är borta" från "körningen uteblev".

**`snapshots/events.parquet`** — härledd, kan alltid byggas om från
observationerna.

| kolumn | beskrivning |
|---|---|
| `first_seen` / `last_seen` | första och sista observation |
| `observations` | antal gånger annonsen setts |
| `first_price` / `last_price` / `total_change` | prisresa |
| `price_changes` | lista med `{at, from, to, change}` |
| `n_price_changes` | antal ändringar över `PRICE_CHANGE_EPS` (0,5 %) |
| `missing_runs` | antal körningar sedan annonsen senast sågs |
| `disappeared` | `missing_runs >= DISAPPEARED_AFTER_RUNS` (2) |
| `days_observed` | `last_seen − first_seen` i dagar |

## Körschema

Designad för **daglig** körning, minst veckovis. Daglig är att föredra: en
prissänkning som sker och rättas inom en vecka blir osynlig vid veckovis
körning, och säljtidsupplösningen blir aldrig bättre än körintervallet.

```
0 4 * * *   cd /sokvag/till/Price_engine && .venv/bin/python snapshot_job.py observe
30 4 * * *  cd /sokvag/till/Price_engine && .venv/bin/python snapshot_job.py events
```

Körningen är idempotent: samma annons och samma `observed_at` skrivs bara en
gång, så en omkörning efter ett fel är ofarlig.

## Felhantering — luckor får aldrig bli försvinnanden

Detta är designens känsligaste punkt. Om försvinnande definierades i
**kalendertid** skulle ett driftstopp på en vecka förvandla hela beståndet
till försvunna annonser på en gång, och överlevnadskurvan skulle visa en
katastrof som aldrig hänt.

Därför räknas försvinnande i **antal körningar en annons saknats i**, aldrig i
dagar. Uteblir körningen ökar ingens `missing_runs`, eftersom ingen körning
registrerades i `runs.parquet`. Luckan blir en lucka, inte en händelse.

Följdregler:

- En körning som ger onormalt få annonser (< 50 % av föregående) ska INTE
  skrivas — det är sannolikt ett hämtningsfel, och skrivs den in ser hela
  beståndet ut att ha försvunnit samtidigt. *(Gränsen ligger i jobbet som en
  framtida spärr; i dag loggas antalet så att avvikelsen syns.)*
- `DISAPPEARED_AFTER_RUNS = 2` betyder att en annons måste saknas i två
  raka körningar. Med daglig körning kostar det ett dygns fördröjning i utbyte
  mot immunitet mot enstaka hämtningsmissar.
- Tidsstämpeln är identisk för hela passet, så en körning som tar två timmar
  inte sprider ut sig över observationerna.

## När börjar datan bära?

| efter | vad som går att säga |
|---|---|
| 1 vecka | prisändringsfrekvens; hur många annonser som rör sig alls |
| 2–3 veckor | första grova försvinnandekvoter, mycket brusiga |
| **6–8 veckor** | **första meningsfulla överlevnadskurvorna** |
| 3 månader | överlevnad per prispercentil-rang med segmentuppdelning |
| 6 månader | säsongseffekter börjar gå att skilja från prissättningseffekter |

Tumregeln på 6–8 veckor kommer ur att kurvan behöver täcka de horisonter man
vill uttala sig om. En kurva för "andel kvar efter 30 dagar" kräver att
annonser hunnit vara observerade i 30 dagar — och för att den ska ha
statistisk tyngd behövs flera kohorter, alltså ytterligare några veckor.

`snapshot_job.py status` räknar ned: den rapporterar `weeks_of_data` och
`weeks_until_survival_curves`.

## Slutmålet: överlevnadskurvan

```
andel kvar efter X dagar  =  f(startprisets percentilrang)
```

Det är glidknappens slutgiltiga facit. Percentilstudien och bryggmätningen
skattar var affärer sker; omlistningsstudien gissar vad marknaden förkastade.
Överlevnadskurvan mäter direkt vad användaren faktiskt frågar om: *sätter jag
det här priset — hur lång tid tar det?*

Skelettet finns i `survival_skeleton()`. Startrangen beräknas med **samma
pipeline som Del A** — motorns egen sökning, samtida fördelning, percentilrang
— så att kurvans x-axel är samma storhet som motorn föreslår priser på.

Tills dess returnerar funktionen `status: "för kort tidsserie"` i stället för
en kurva. Det är avsiktligt: en överlevnadskurva byggd på två veckors data
skulle se ut som ett svar.

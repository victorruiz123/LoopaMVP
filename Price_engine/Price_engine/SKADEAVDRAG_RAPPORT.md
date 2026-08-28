# Skadeavdragssystemet

Byggt 2026-08-19 bakom `DAMAGE_PRICING = False`. **650 tester passerar**,
benchmarken identisk med flaggan av. Inga API-anrop gjorda.

---

## Arbetsdelningen som styr allt

```
LLM:en SER och KLASSIFICERAR.  Tabellen VÄRDERAR.
Uppskattad lagningskostnad täcker gapet däremellan.
```

Modellen får aldrig svara på vad en skada gör med priset — den frågan kräver
marknadsdata den inte har, och ett svar därifrån vore en gissning förklädd till
mätning. Den får svara på vad den **ser** (kategori, grad, placering) och, för
skador tabellen inte känner, vad det **kostar att laga**. Omvandlingen från
kostnad till avdrag är vår.

Prompten säger det uttryckligen: *"Bedöm ALDRIG priset eller värdeminskningen.
Du svarar bara på vad du ser och vad det kostar att åtgärda."*

---

## Tabellschemat — det här ska fyllas

`config/damage_deductions.json`. **`rows` är tom.** Filen innehåller schemat och
fyra exempelrader märkta `"EXEMPEL, ej verkligt"`.

```json
{
  "category": "flack",
  "furniture_type": "soffa",        // eller "*" för generisk fallback
  "grade": 1,                       // 0 knappt synlig, 1 synlig, 2 framträdande
  "deduction": 0.12,
  "ci_low": 0.08, "ci_high": 0.17,
  "source": "measured",
  "n_groups": 42,
  "repair_cost_sek": 800,
  "note": "kemtvätt dyna, prisnivå aug 2026"
}
```

### `source` — fyra värden med olika status

| värde | betyder | ger avdrag? |
|---|---|---|
| `measured` | uppmätt kvot flaggade/oflaggade inom modellgrupp | ja |
| `repair_anchor` | härledd ur lagningskostnad × `HASSLE_FACTOR`, inte ur prisdata | ja |
| `structure_only` | raden finns för att strukturen ska vara komplett | nej (0) |
| `insufficient_data` | under 30 grupper — ingen siffra ges | **nej, aldrig** |

En rad med `insufficient_data` dokumenterar att kategorin är **känd men omätt**.
Den prissätter aldrig. Det är skillnaden mot att utelämna raden: utelämnad
kategori blir `unmapped` och går till kostnadsuppskattning; `insufficient_data`
säger "vi vet att detta finns, vi vet inte vad det kostar".

### Uppslagsordningen

`category × furniture_type × grade`, med typspecifik före generisk `*`. En
`flack`-rad för `soffa` vinner över `flack`-raden för `*`.

**Beslutat 2026-08-20: tabellen kör enbart andelar.** `deduction × bas` gäller
alltid för kategorier som finns i tabellen. Ingen min()-regel, ingen jämförelse
mot kostnad, ingen omräkning. Mitt tidigare förslag om ett `unit`-fält (andel
mot fast summa) är avvisat.

`repair_cost_sek` behålls i filen men **ingår inte i beräkningen**. Fältet finns
för att en människa ska kunna se om en uppmätt andel är rimlig: ett avdrag för
fläck som vida överstiger vad en kemtvätt kostar är en varningssignal om
confounding, inte ett fynd.

Det är kommenterat i schemat och låst av
`test_table_repair_cost_never_enters_valuation`, som ger två rader identisk
`deduction` men `repair_cost_sek` 50 respektive 40 000 kr och kräver samma
avdrag. Skulle någon återinföra kostnaden i värderingen går testet sönder.

---

## API-kontraktet

**Prismotorn detekterar inte skador.** Ett separat system ser dem och levererar
en färdig lista. Motorn tolkar och värderar den.

```json
POST /price
{
  "name": "Ektorp", "brand": "IKEA",
  "damages": [
    {"description": "fläck på sittdynan",   // obligatorisk, fritext
     "severity": "synlig",                  // valfri: 0/1/2 eller text
     "location": "sittyta",                 // valfri
     "image": "<base64>"}                   // valfri, bara vid kostnadsuppskattning
  ]
}
```

`severity` tolkas ur både siffror och text, svensk och engelsk: *knappt synlig,
liten, minor* → 0; *synlig, måttlig, moderate* → 1; *framträdande, kraftig,
omfattande, severe* → 2. **Följer severity med används den — den bedöms aldrig
om.** Skadesystemet har sett skadan; att göra om bedömningen vore att kasta bort
information och riskera att två system säger olika saker om samma foto.

Saknas severity antas grad 1 och posten märks `gradeAssumed`.

## Matchningen: två steg

### Steg 1 — deterministiskt, gratis, konsekvent

Beskrivningen matchas mot kategoriernas synonymer, längsta träff vinner.

```
"fläck på sittdynan"      -> flack
"stor reva i tyget"       -> reva_hal
"soffan är vinglig"       -> stomskada
"repa i skinnet"          -> repa_skinn      (inte repa_hard)
"spjälkat fanér på hörnet"-> ingen träff -> steg 2
```

Längsta-match-först är nödvändigt: utan den matchar `repa` inuti *repa i skinn*
och en skinnrepa hamnar i fel kategori. Samma regel som möbeltypslexikonet
använder, av samma skäl.

Synonymkartan tar **bara** tabellens kategorier. En kategori som inte finns i
tabellen kan aldrig värderas, så den ska heller aldrig matcha — annars skickas
skadan till en kategori utan rad och uppslaget missar tyst. Tabellens egna
`categories[x].synonyms` vinner när de finns, så listan går att utöka utan
kodändring.

### Steg 2 — modellanrop, bara för svansen

Anropas **enbart** för poster steg 1 inte klarade, en post i taget, och bara för
att mappa mot kategorilistan eller uppskatta en lagningskostnad.

Prompten säger uttryckligen: *"Din uppgift är INTE att titta efter skador"*,
*"Bedöm inte hur allvarlig skadan är — det har det andra systemet redan gjort"*
och *"Bedöm ALDRIG priset på möbeln eller värdeminskningen"*.

`apply_mapping` väver in svaret men **rör aldrig graden**. Att låta modellen
justera den vore att återinföra bedömningen som togs bort.

Svaret redovisar `matchedDeterministically` och `needsModel`, så andelen som
kräver anrop går att följa över tid. En modell som anropas för varje skada är
både dyrare och mindre förutsägbar än en ordlista; steg 2 finns för svansen,
inte för normalfallet.

### Steg 3 — ingen modell → inget avdrag

Priset sätts utan skadejustering och det redovisas. **Ett dött API får aldrig
fälla ett prissvar.**

## De fyra reglerna

### Basregeln mot dubbelräkning

Jämförelsemängden innehåller redan skadade annonser, så medianen är redan
nedtryckt av deras skador. Att dra av från den medianen straffar skadan två
gånger.

Basen räknas därför på de **oflaggade** annonserna. Räcker de inte till
filtergolvet (30) används blandad bas — men avdraget **halveras** och svaret
märks `mixed_halved`.

Verifierat i motorn: med 40 oskadade à 10 000 kr och 40 skadade à 7 000 blir
basen 10 000, inte den blandade medianen 8 500.

### Ingen stapling — totalen är den värsta skadan

```
total = max(d_i)
```

En köpare prissätter möbelns värsta problem. Ytterligare skador bekräftar samma
intryck utan att flytta priset igen: den som redan avfärdat en soffa för en stor
reva bryr sig inte om att det också finns en fläck, och den som accepterar revan
har redan gjort avkallet.

`STACK_DECAY` är **borttagen**, inte satt till noll — ett kvarlämnat värde hade
inbjudit till att koppla in dämpningen igen utan att beslutet omprövas.
`test_stack_decay_stays_removed` failar om namnet dyker upp i kod igen.

**CI propageras som max över kanterna**, inte från den bindande posten. Med
A(0,38, CI 0,25–0,50) och B(0,35, CI 0,30–0,45) blir undre kanten 0,30 — B:s
kant — eftersom B finns kvar även när A visar sig mild.

### Deduplicering: en post per kategori

Skadesystemet rapporterar varje enskild skada. En normalsliten möbel ger 8–12
poster. Utan deduplicering staplades de till taket, och alla slitna möbler fick
samma pris.

En post per kategori med gruppens **högsta** grad. Antalet redovisas som `count`
men påverkar inte avdraget — utom via `COUNT_ESCALATION_AT = 3`, som höjer graden
ett steg vid tre eller fler i samma kategori, högst till 2. **Ovaliderad.**

Omappade skador saknar kategori och grupperas på beskrivningen i stället.

### Taken är rena skyddsnät

| tak | värde | biter? |
|---|---|---|
| `MAX_UNMAPPED_DEDUCTION` | 25 % per post | ja — enda taket som biter i praktiken |
| `MAX_TOTAL_DEDUCTION` | 50 % totalt | **nej, kan inte** |

Med `max()` kan totaltaket bara lösa ut om en **enskild** tabellrad överstiger
det. Största raden i 0.2 är mögel grad 2 på 45 %, så taket kan inte binda. Det
skyddar mot framtida rader och mot kostnadsuppskattningar som spårar ur — inte
mot möbler med många fel.

Under den tidigare staplingen löste taket ut i 38 % av scenarierna, vilket
gjorde det till normalfallet i stället för ett skyddsnät.

### Väsentlighetströskeln

Grad 0 (knappt synlig) **listas men prissätts till noll**. AI:n ser mer än
köparen bryr sig om, på samma sätt som biluthyrarnas skadeskannrar hittar repor
ingen människa reagerar på. Att prissätta varje sådan iakttagelse gör systemet
överkänsligt och säljaren misstrogen.

---

## Nya konstanter — alla ovaliderade

| konstant | värde | status | vad som skulle validera den |
|---|---|---|---|
| `REPAIR_HASSLE_FACTOR` | **2,0** | **ovaliderad** | utfallsdata: såldes möbeln, till vilket pris, med vilken deklarerad skada |
| `STACK_DECAY` | 0,6 | **ovaliderad** | skadestudiens Fas 2:3, som inte kunde köras |
| `MAX_UNMAPPED_DEDUCTION` | 0,25 | **ovaliderad** | — |
| `MAX_TOTAL_DEDUCTION` | 0,50 | **ovaliderad** | biter nästan aldrig, se ovan |
| `MATERIALITY_MIN_GRADE` | 1 | **ovaliderad** | medvetet produktval, inte en mätning |

`STACK_DECAY` förtjänar en särskild not: hypotesen "första skadan kostar mest,
marginalen avtar" är rimlig men **omätt**. Skadestudiens Fas 2:3 skulle ha
svarat, och den kunde inte köras eftersom det finns noll flaggade asking-rader.
Se `SKADESTUDIE_FAS0.md`.

---

## Svaret

```json
"damage": {
  "items": [
    {"category": "flack", "grade": 2, "location": "sittyta",
     "deduction": 0.20, "source": "table", "evidence": "mörk fläck",
     "ciLow": 0.15, "ciHigh": 0.29, "nGroups": 35},
    {"category": "unmapped", "description": "spjälkat fanér på hörn",
     "repairCostSek": 900, "repairAction": "fanerlagning",
     "deduction": 0.18, "source": "estimated_repair"}
  ],
  "totalDeduction": 0.30,
  "basis": "undamaged_comparables",
  "basisN": 40,
  "capped": false,
  "estimatedCount": 1
}
```

Konfidensen sänks vid `estimated_repair` och vid `mixed_halved`. Varje post bär
sin källa, så "−20 % framträdande fläck på sittytan" går att visa för
användaren med angivande av om siffran är uppmätt eller uppskattad.

---

## Den självförbättrande taxonomin

Varje omappad skada loggas till `type_system/unmapped_damages.jsonl` med
beskrivning, uppskattad kostnad, åtgärd, möbeltyp och datum.

```bash
python report_unmapped_damages.py
```

Rapporten grupperar loggen och rangordnar efter frekvens, med mediankostnad och
vanligaste möbeltyp per beskrivning. **Den listan är prioriteringsordningen för
vilka kategorier som ska in i tabellen härnäst** — taxonomin växer ur verklig
användning i stället för ur en gissning om vad som brukar gå sönder.

Loggen är tom i dag; den fylls först när flaggan slås på.

---

## Verifiering

| test | antal |
|---|---|
| mekaniken (tabell, max(), bas, kostnad, tak, tröskel, andelsregeln) | 29 |
| indata och tvåstegsmatchning | 26 |
| deduplicering och skugglogg | 20 |
| integrationen (flaggan, kedjan, loggen) | 8 |
| syntetiska fall (känd skada + känd bas → känt avdrag) | 10 |
| **totalt nya** | **79** |

De tio syntetiska fallen låser mekaniken numeriskt — bland annat att
`0,20 + 0,08` blir **0,2384** genom staplingen, att ordningen normaliseras, och
att grad 0 inte bidrar.

Benchmarken med flaggan av: **12 av 12 möbler identiska**, 58,3 % oförändrat.

---

## Rekommendation

**Låt flaggan vara av tills tabellen har innehåll.** Med tom tabell blir varje
skada `unmapped` och prissätts på modellens kostnadsgissning ensam — det är
kedjans svagaste led och var aldrig tänkt som normalfall.

Ordningen jag föreslår:

1. **Fyll tabellen** för de kategorier vi kan mäta. Med dagens data betyder det
   auktionsdata och riktningsstudien — eller väntan på Blocket-skrapningen.
2. **Slå på flaggan i skuggläge** — beräkna och redovisa avdraget i svaret utan
   att låta det påverka `default`. Då fylls `unmapped`-loggen med verklig
   användning, och taxonomin kan växa innan systemet påverkar ett enda pris.

Punkt 2 är den jag helst skulle göra först. Den ger data utan risk.

---

## Tabell 0.2 — utfall

Installerad 2026-08-20. 32 rader, 13 kategorier, alla `source: judgment`.

| scenario | in → ut | avdrag | CI | bindande skada |
|---|---|---|---|---|
| normalslitet A | 10 → 3 | **22,0 %** | 15–30 | flack |
| normalslitet B | 10 → 2 | 8,0 % | 4–14 | flack |
| en stor skada | 1 → 1 | 30,0 % | 20–40 | reva_hal |
| två grova | 2 → 2 | 35,0 % | 25–45 | lukt |
| tre grova | 3 → 3 | 35,0 % | 25–46 | lukt |
| fyra grova | 4 → 4 | 35,0 % | 25–46 | lukt |
| blandat | 4 → 3 | 22,0 % | 14–32 | nedsutten |
| lätt | 1 → 1 | 0,0 % | — | repa_hard (grad 0) |
| mögel | 1 → 1 | 45,0 % | 35–50 | mogel |

**median 30,0 %  ·  max 45,0 %  ·  min 0,0 %  ·  totaltaket löste ut 0/9**

Kalibreringsankaret stämmer: en 20 000 kr-soffa med stor fläck ger 22 % →
**15 600 kr**, inom det angivna 15 000–16 000.

### Utveckling över de tre versionerna

| | stapling 0,6 | stapling 0,4 | max() + 0.1 | **max() + 0.2** |
|---|---|---|---|---|
| median | 38,9 % | 38,0 % | 38,0 % | **30,0 %** |
| max | 50,0 % | 50,0 % | 45,0 % | **45,0 %** |
| taket löste ut | 38 % | 38 % | 0 % | **0 %** |

Sänkningen av grad 1 till 4–15 % syns tydligast i `normalslitet B` (8 %) och
`normalslitet A` (22 %) — de fall där en vanlig, synlig skada är det värsta som
finns. Det var kalibreringens uttalade syfte.

## Synonymmatchningen: ett fel lagat, ett kvar

Tabellens synonymlistor är frasbaserade, vilket avslöjade en brist i matcharen.
Av tjugo realistiska beskrivningar missade fyra.

**Lagat — ordföljd.** Flerordssynonymer matchar nu oavsett ordföljd:
`"hyllplan saknas"` mot tabellens `"saknas hyllplan"`. Både delsträng och
ordmängd prövas, och endera räcker — ordmängd ensam bröt `"repa i skinnet"` mot
`"repa i skinn"`, eftersom `skinnet` inte är samma ORD som `skinn`, varpå
`repa_hard` vann på sitt enordiga `"repa"`.

Träffandelen gick 16/20 → **17/20**.

**Kvar — böjning.** Tre beskrivningar matchar inte:

| användaren skriver | tabellen har |
|---|---|
| `skinnet flagnar` | `flagande skinn` |
| `nedsuttna dynor` | `nedsutten` |
| `en skruv saknas` | `skruvar saknas` |

Det kräver stamning, vilket är en större ändring med egna felkällor. Konsekvensen
är hanterad: posterna faller igenom till steg 2, som är den designade
reservvägen — de kostar ett modellanrop, inte ett fel svar. **Enklaste
botemedlet är att lägga till böjningsformen som synonym i tabellen**, vilket inte
kräver någon kodändring.

Tre tester dokumenterar luckan explicit i stället för att dölja den.

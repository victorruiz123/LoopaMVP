# Prismotor för begagnade möbler

Föreslår ett pris för en begagnad möbel genom att slå upp liknande annonser i
lokal data. Ingen ML, ingen modell — bara uppslagning, median och ett
positionsbaserat fönster.

Priset returneras som ett **intervall** avsett för en glidknapp:

```
low ──────────── default ──────────── high
p30              p40                  p60
lättsålt         startläget           svårsålt
```

## Installation

Kräver Python 3.9 eller senare.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Peka ut datamappen

Motorn letar i denna ordning:

1. `$PRICE_ENGINE_DATA` om den är satt
2. `./data` om mappen finns
3. `~/Price_engine/vips-ml-data/vips-fas0` (den uppackade vips-datan)

```bash
export PRICE_ENGINE_DATA=/sokvag/till/min/data
```

Filformat som stöds: `.parquet`, `.csv`, `.tsv`, `.xlsx`, `.xls`, `.ndjson`,
`.jsonl`. Finns `master.parquet` i mappen används den plus allt i `extra/`;
annars läses alla datafiler och slås ihop.

Kolumnnamn behöver inte matcha exakt — inläsaren letar efter kända alternativ
(`price_sek`/`pris`/`slutpris`, `title_norm`/`namn`/`rubrik`, osv). Se
`COLUMN_CANDIDATES` i [price_engine/config.py](price_engine/config.py).

## Lägga till ny data (t.ex. en ny Blocket-skrapning)

**Kopiera filen till `$DATA_DIR/extra/` och starta om.** Det är hela ingreppet.

```bash
mkdir -p ~/Price_engine/vips-ml-data/vips-fas0/extra
cp blocket_2026_08.parquet ~/Price_engine/vips-ml-data/vips-fas0/extra/
python corpus_health.py            # verifiera att raderna kom in
```

Inget behöver byggas om för hand. Cachenyckeln innehåller varje läst fils
sökväg, ändringstid och storlek, så en tillagd fil ger en ny nyckel och nästa
uppstart städar om av sig själv. **`CACHE_VERSION` ska INTE höjas för ny data** —
den versionen beskriver städ*logiken*, inte innehållet.

### Kolumnkrav

Fyra kolumner måste finnas, under något av de kända namnen:

| innehåll | godtagna namn | krav |
|---|---|---|
| rubrik | `title_norm`, `title_raw`, `title`, `namn`, `rubrik`, `modell` | måste vara ifylld, annars kastas raden |
| pris | `price_sek`, `price`, `pris`, `slutpris`, `belopp`, `summa` | tolkas ur text ("1 299 kr" går bra); måste ligga i 1–1 000 000 |
| prissort | `price_kind` | **`asking`** för marknadsplatsannonser, `realized` bara för klubbade auktionspriser |
| datum | `listed_at_ms` (epoch-ms), `created_at`, `listed_at` — eller `sold_at` för auktioner | utan datum kan raden aldrig räknas som färsk |

Frivilligt men nyttigt: `source` (för `corpus_health.py`), `brand`, `condition`,
`image_url`, `dedup_key`.

**`price_kind` är den farligaste kolumnen.** Sätts en Blocket-skrapning felaktigt
till `realized` blandas utropspriser med auktionspriser, och motorn tror att den
har faktiskt betalda priser. Kanalerna har olika prisnivå och olika sortiment —
se avsnittet om prisbas.

### Dubbletter

Dedupas på `dedup_key` när kolumnen finns i datan, annars på
(rubrik, pris, skick). En omskrapning av samma vecka lägger alltså inte till
dubbletter, förutsatt att rubrik och pris är oförändrade. Ändras rubriken mellan
skrapningarna räknas den som en ny annons — vilket är rätt för prisstatistik men
värt att veta.

### Efter inläsningen

```bash
python corpus_health.py --benchmark
```

Kontrollera två saker: att `andel_farska` steg, och att `andel extended` föll.
Den andra är den viktiga — se nästa avsnitt.

## Snabbtest utan server

```bash
.venv/bin/python -m price_engine.cli "Landskrona" --brand IKEA
.venv/bin/python -m price_engine.cli "Landskrona" --brand IKEA --condition "gott skick"
.venv/bin/python -m price_engine.cli "Kivik" --brand IKEA --price-kind realized --show 5
.venv/bin/python -m price_engine.cli "Vimle" --brand IKEA --variant fotpall
.venv/bin/python -m price_engine.cli "Landskrona" --brand IKEA --image soffa.jpg
.venv/bin/python -m price_engine.cli "Poang" --brand IKEA --bands
```

Flaggor: `--brand`, `--condition`, `--variant`, `--image FIL`,
`--price-kind {auto,realized,asking,all}`, `--data`, `--show N`,
`--variants`, `--bands`, `--verbose`.

## Starta API:et

```bash
.venv/bin/uvicorn price_engine.api:app --reload
```

Datan läses och städas **en gång vid uppstart** och hålls i minnet.

```bash
curl -X POST http://127.0.0.1:8000/price \
  -H "Content-Type: application/json" \
  -d '{"name": "Landskrona", "brand": "IKEA", "condition": "gott skick"}'
```

```json
{
  "query": { "name": "Landskrona", "brand": "IKEA", "condition": "gott skick", "variant": null },
  "priceBasis": "asking",
  "variantMethod": "none",
  "variantCandidates": ["soffa", "hörnsoffa", "fåtölj", "fotpall"],
  "conditionMethod": "filtered",
  "conditionBand": null,
  "matchCount": 46,
  "halfInterval": 5,
  "default": 2700,
  "low": 2000,
  "high": 3500,
  "confidence": "high",
  "note": "Baserat på 46 liknande annonser. Baserat på utropspriser i annonser. Endast annonser i Bra skick."
}
```

`condition` är valfritt — utelämnas det filtreras inte på skick.
`price_kind` styr prisbasen, se avsnittet om prissorter nedan.
`GET /health` visar antal inlästa annonser. Interaktiva docs på `/docs`.

## Algoritmen

Implementerad i [price_engine/pricing.py](price_engine/pricing.py), steg för steg:

| Steg | Vad som händer |
|---|---|
| 1 | `N` = antal matchande annonser |
| 2 | `HalvIntervall = round(N * 0.1)` |
| 3 | Om `HalvIntervall < 5` → sätt till `5` |
| 4 | Sortera annonserna på pris, billigast → dyrast |
| 5 | `default` = **p40** (glidknappens startläge), `low` = p30, `high` = p60 |
| 6 | Ta `HalvIntervall` annonser åt vänster och åt höger om medianens position → **fönstret** |
| 7 | `low` = lägsta priset i fönstret, `high` = högsta priset i fönstret |

**Startläget ligger under medianen.** Medianen är per definition
genomsnittsfart — hälften av marknaden är billigare. Två oberoende mätningar
drog ned startläget från ~p45 till p40: bryggmätningen, som mäter mot exakt den
fråga motorn ställer, landade på p34, och omlistningsstudien visar att
prissänkningarna passerar 50 % redan i decilen p40–50.

**Fönstret, inte hela träffmängden.** Steg 7 tittar bara på annonserna runt
medianen. Det är det som gör intervallet snävt och okänsligt för extremvärden:
en enda felprissatt annons på 500 000 kr påverkar inte `high`. Vill du istället
ha absolut min/max av hela sökträffen, byt `window` mot `ordered` i steg 7.

### Kantfall

| Situation | Beteende |
|---|---|
| `N == 0` | `default`/`low`/`high` = `null`, `confidence: "none"`, förklarande `note` |
| `N < 10` | Svar ges ändå, men `confidence: "low"` — fönstret (±5) täcker hela träffmängden |
| Färre annonser än fönstret kräver på en sida | Indexen clampas till listans gränser |
| Jämnt antal | Medianen är medelvärdet av de två mittersta; fönstrets mittpunkt är den övre |

Avrundning av `N * 0.1` sker alltid **.5 uppåt**. Pythons inbyggda `round()`
avrundar mot jämnt tal (`round(6.5) == 6`), vilket inte är avsikten här.

## Matchning

1. **Varumärke** — normaliserat och skiftlägesokänsligt.
2. **Modellnamn** — ordbaserad matchning i annonstexten.
3. **Skick** — bara om det angavs, se nedan.

Matchningen är **ordbaserad, inte delsträngsbaserad**: varje ord i sökningen
måste finnas någonstans i annonstexten, oberoende av ordning och skiljetecken.

Delsträngsmatchning krävde en sammanhängande teckensekvens och missade därför
majoriteten av de giltiga träffarna. Alla dessa är 3-sits Landskrona-soffor,
och ingen av dem hittades:

```
Soffa IKEA LANDSKRONA Grå 3-sits     ord emellan
Ikea 3-sitssoffa Landskrona          omvänd ordning
Soffa IKEA Landskrona 3 sits         mellanslag i stället för bindestreck
Soffa, IKEA, Landskrona, 3-sits      kommatecken emellan
```

| Sökning | Delsträng | Token |
|---|---|---|
| `Landskrona 3-sits` | 95 | **183** |
| `Landskrona 3 sits` | 18 | **183** |
| `Landskrona hörnsoffa` | 14 | **24** |
| `Landskrona fåtölj` | 23 | **72** |

Två detaljer i implementationen:

**Söksträngen delas på skiljetecken**, inte bara mellanslag — `3-sits` blir
`["3", "sits"]` och matchar därför både `3-sits` och `3 sits` i annonserna.

**Rena siffror kräver ordgräns.** Vanliga ord matchas som delsträng, vilket
ger böjningsformer gratis (`soffa` träffar `soffor` och `3-sitssoffa`). Men
som delsträng skulle `2` träffa varje titel som råkar innehålla siffran —
`2024`, `1200 kr`, `12 mm` — så siffror matchas med `\b`-gräns.

Två- och flerordsmärken fungerar därmed också: `Fritz Hansen` hittas även när
orden står isär i titeln.

## Vad systemet håller — och inte håller

Efter upphovsrättssaneringen 2026-08-19. Detta är den exakta beskrivningen av
vad som ligger lagrat, och den är avsedd att kunna citeras rakt av.

### Systemet HÅLLER

| kategori | omfattning |
|---|---|
| **Faktafält** | pris, datum, källa, prissort, märke, modellbeteckning, kategori, mått |
| **Annonsrubriker** | 1 525 135 st, median **27 tecken** — produktbeteckningar för sökmatchning |
| **Strukturerade attribut** | möbeltyp, sitsantal, storlek, skicknivå, cellflaggor (bunt/tillbehör/sektion) |
| **Härledda skadeflaggor** | sex booleska fält + antal, utvunna ur skicktext som därefter raderades |
| **Bildvektorer** | 93 230 DINOv2-vektorer om 384 dimensioner + färghistogram |
| **Bild-URL:er** | referens till källan, ingen kopia |
| **Aggregat** | prismultiplikatorer, percentiltabeller, modellnamnsvitlista, typprior |

### Systemet HÅLLER INTE

| kategori | vad som gjordes |
|---|---|
| **Annonsbilder** | 94 356 JPEG (5,3 GB) raderade 2026-08-19, plus 30 beskurna och 52 benchmarkbilder |
| **Beskrivningstexter** | 3 728 139 förekomster av `description` raderade ur alla filer |
| **Skicktexter i fritext** | 1 728 658 förekomster av `condition_text` raderade — informationen finns kvar som flaggor |
| **GPS-koordinater** | 202 539 `lat`/`lon`-par raderade |
| **Säljaruppgifter** | 202 539 `seller_type` raderade |
| **Länkar till annonserna** | 1 602 297 `url` + 1 946 018 `href`/`click_id` raderade |
| **Sammanslagen fritext** | `canonical_text` raderad ur master |

Bildvektorer är irreversibla representationer, inte kopior: 384 flyttal går inte
att återskapa ett fotografi ur.

### Inläsningen är restriktiv

Bara kolumner på vitlistan (`config.ingest_columns()`) läses från disk. Fält på
`FORBIDDEN_COLUMNS` släpps aldrig in, ens om någon lägger till dem i
kandidatlistan. `tests/test_column_whitelist.py` failar om en okänd kolumn
passerar.

Tidigare var inläsningen tillåtande — den läste allt och kastade det okända
efteråt. Det är skälet till att `description`, `lat` och `lon` följde med in i
minnet vid varje uppstart utan att någon valt det.

## Korpusens hälsa — kanariefågeln

```bash
python corpus_health.py --benchmark
```

Färskhetsfiltret behåller annonser inom 8 månader **bakåt från idag**. Fönstret
rör sig med kalendern; korpusen gör det inte. När den dominerande källan passerar
bakom gränsen slutar filtret filtrera, varje sökning faller till `extended`, och
funktionen dör **tyst** — motorn svarar precis som förut, men på gamla priser i en
fallande marknad, alltså systematisk överprisning.

Mätt 2026-08-17 har det redan hänt för den största källan:

| källa | rader | senaste | färska | utgår ur fönstret |
|---|---|---|---|---|
| `archive` | 973 009 | 2025-12-15 | **0** | 2026-08-15 — passerat |
| `auctionet` | 461 564 | 2026-07-10 | 35 839 | 2027-03-10 |
| `blocket` | 82 731 | 2026-07-13 | 82 731 | 2027-03-13 |
| `tradera` | 7 831 | 2026-07-11 | 7 820 | 2027-03-11 |

8,3 % av korpusen är färsk, och **45,7 % av benchmarkfrågorna faller till
`extended`** (nivå GULT).

Nivåerna går på andelen `extended`, inte på andelen färska rader — det är vad som
faktiskt händer i sökningarna som räknas:

| andel `extended` | nivå | innebörd |
|---|---|---|
| < 30 % | GRÖNT | filtret arbetar |
| 30–60 % | GULT | fönstret börjar tömmas — planera datainsamling |
| > 60 % | RÖTT | filtret är i praktiken ur funktion |

### Degraderingsskyddet

Används `extended` **och** är även den färskaste annonsen i jämförelsemängden
äldre än `STALE_AFTER_MONTHS` (10), sätts `confidence: "low"` och förbehållet
skrivs ut i `note`. Svaret ges ändå — ett gammalt pris är bättre än inget — men
motorn får inte framställa det som aktuellt. Åldern redovisas i `dataStaleness`:

```json
"dataStaleness": {"newest": "2025-10-15", "ageMonths": 10.1, "stale": true}
```

Skyddet är riktat, inte generellt: av de 33 benchmarkmöbler som får svar flaggas
**en**, eftersom de flesta `extended`-mängder ändå innehåller auktionsrader från
2026. Hög extended-andel betyder alltså inte automatiskt gammal data.

## Färskhet

Marknaden faller mätbart, och underlaget är gammalt:

```
archive   973 009 annonser   2024-07 – 2025-12   ← 92 % av datan
blocket    82 731 annonser   2026-04 – 2026-07   ← dagens marknad

median i hela datan:  1 167 kr (2024-07)  →  995 (2025-07)
                        800 kr (2025-10)  →  700–750 (2026)
```

Utan filter dominerar gamla priser. Mio Madison landade på 6 000 kr mot
5 000 på dagens Blocket.

Motorn använder därför bara annonser från de senaste **8 månaderna**. Räcker
inte det utökas fönstret bakåt: de senaste annonserna tas med även utanför
fönstret tills **15** är uppnått. Hellre några gamla priser än ett svar byggt
på tre annonser.

| Metod | När |
|---|---|
| `window` | ≥ 15 annonser inom 8 månader |
| `extended` | Färre — de 15 senaste används oavsett ålder |
| `none` | Ingen tidsstämpel alls i underlaget |

Filtret körs **sist** i kedjan, så att golvet på 15 räknas på de annonser som
faktiskt ska prissättas: rätt möbeltyp, rätt skick, rätt prissort.

Effekten på Mio Madison:

| Underlag | n | Median |
|---|---|---|
| Allt | 627 | 6 000 kr |
| **Senaste 8 mån** | **97** | **5 000 kr** |

**Två datumkolumner slås ihop.** `listed_at_ms` finns på 100 % av
utropspriserna men 0 % av auktionerna; `sold_at` tvärtom. Utan
sammanslagningen hade filtret raderat hela ena halvan. Täckningen efter
sammanslagning är 99,5 %.

Justeras med `RECENCY_MONTHS` och `RECENCY_MIN_LISTINGS` i
[price_engine/config.py](price_engine/config.py).

## Möbeltyp

Modellnamnet ensamt räcker inte. `Landskrona` är en IKEA-**serie**, inte en
produkt — samma namn bärs av soffa, hörnsoffa, fåtölj och fotpall. Spannet
inom ett modellnamn är större än skickets:

| Modell | Typ | Pris | | Typ | Pris | Spann |
|---|---|---|---|---|---|---|
| Vimle | bäddsoffa | 5 500 kr | ↔ | fotpall | 1 000 kr | **5,5×** |
| Malm | säng | 1 250 kr | ↔ | byrå | 400 kr | **3,1×** |
| Söderhamn | hörnsoffa | 2 000 kr | ↔ | fotpall | 750 kr | **2,7×** |
| Landskrona | hörnsoffa | 3 000 kr | ↔ | fåtölj | 1 950 kr | 1,5× |

Användaren skriver aldrig "fotpall" själv — men ett foto visar det direkt.
Skicka `image_base64`, så läses möbeltypen ur bilden och används som filter.
Vet klienten redan typen går den att skicka direkt som `variant`; det är
gratis och kan inte gissa fel, så explicit `variant` vinner alltid över bilden.

### Kedjan

| Metod | När | Vad som händer |
|---|---|---|
| `filtered` | ≥ 15 annonser av rätt typ | Filtrera strikt |
| `relaxed` | Färre, men minst 1 | Uteslut bara annonser som positivt är en *annan* typ; behåll de omärkta |
| `ignored` | Noll märkta träffar, eller för tunt ändå | Släpp typfiltret |
| `none` | Ingen typ angiven, eller otolkbar | — |

**Varför `relaxed` finns:** 26,5 % av annonserna anger ingen typ i titeln. De
kan vara vad som helst och får inte uteslutas i onödan.

**Varför noll märkta träffar ger `ignored`:** det finns ingen Landskrona-säng.
Utan den regeln skulle `variant: "säng"` behålla de 44 omärkta Landskrona-
annonserna och svara 3 000 kr på en möbel som inte existerar.

Typfiltret körs **före** skicket, så skickets tröskel räknas på den typrätta
delmängden.

### Taxonomin

Tolv typer, i prioritetsordning — mest specifik först, så att `bäddsoffa` inte
fastnar på `soffa` och `matbord` inte fastnar på `bord`:

```
bäddsoffa  hörnsoffa  matgrupp  soffa  fotpall  fåtölj
stol       säng       byrå      hylla  spegel   bord      + okänd
```

Tilldelningen är **exklusiv** — varje annons får precis en typ. Utan det
hamnar "Landskrona 3-sits soffa med divan och fotpall" i tre hinkar och
medianerna blir meningslösa: i den överlappande varianten kostade en fotpall
lika mycket som en soffa (2 500 kr), mot 1 350 kr med exklusiv tilldelning.

`GET /variants` (eller `--variants`) visar etiketterna och antal annonser per
typ. Fördelningen över hela datan:

```
297 245  okänd      189 077  stol      136 256  byrå       49 013  fotpall
226 224  bord       107 247  soffa      96 290  fåtölj     31 322  hörnsoffa
181 795  hylla       78 124  matgrupp   69 419  säng       25 637  spegel
                                                           22 902  bäddsoffa
                                        14 584  del/tillbehör
```

### Delar och tillbehör

Modellnamnet bärs inte bara av möbeln utan av **hela dess
reservdelssortiment**. En sökning på "IKEA PAX" plockade 473 annonser där
17,5 % låg under 200 kr — gångjärn, klädstänger, hyllplan, skåpshandtag — och
medianen blev 750 kr för en garderob. "Kivik" drog in klädsel för 150 kr,
"Mio Madison" en matta för 200 kr.

Delarna förstörde också skickmätningen, och där var felet värre än ett brett
intervall: de är **snedfördelade över skicknivåerna**. 11,3 % av
nyskick-raderna var delar mot 6,5 % av slitet-raderna, eftersom en reservdel
oftast säljs oanvänd. Nettoeffekten var att nyskick såg *billigare* ut än gott
skick — 400 kr mot 500 kr. Utan delarna vänder ordningen rätt: 990 mot 800.

`del/tillbehör` är därför en egen klass som utesluts både ur kandidatmängden
och ur multiplikatorjobbet. Två mekanismer avgör, båda hämtade ur hur
annonstitlar faktiskt ser ut:

**"med X" beskriver en egenskap, inte varan.** "Säng med förvaringslådor" är
en säng, "PAX garderob med dörrar och inredning" är en garderob.

**Det som nämns först är det som säljs.** Auktionstexterna räknar upp
detaljer efter möbelordet — "BOKHYLLA; 1930/40-tal, 2 flyttbara hyllplan",
"KARMSTOL, barock, klädd med blommig klädsel" — medan en reservdelsannons
leder med delen: "Klädsel till Ikea Kivik". Vid samma startposition vinner
längsta träffen, så `garderobsdörrar` slår `garderob`. Undantaget är
konstruktionen "X till Y", som vinner oavsett position ("Garderobsinredning
till IKEA PAX") — men inte "till salu", som bara är svenska.

Utfall (1,0 % av alla annonser, medianpris 500 kr mot möbelns 900 kr):

```
sökning              träffar före/efter    median före/efter
IKEA PAX                  473 -> 281          750 -> 1 500 kr
IKEA Bestå                875 -> 779          600 ->   700 kr
IKEA Billy                357 -> 335          350 ->   400 kr
IKEA Landskrona            86 ->  86        2 500 -> 2 500 kr
Mio Madison                97 ->  97        5 000 -> 5 000 kr
```

Modulmöbler påverkas mest, klassiska soffor knappt alls. Kvarvarande
felkällor: sektioner av modulsystem ("PAX Stomme", "påbyggnadsdel",
"mittsektion") räknas fortfarande som möbler, och auktionsannonser som
nämner en detalj *före* möbelordet kan felklassas ("stomme i ek … linneskåp").

### Bildklassningen

Detta är motorns **enda** modellanrop, och det görs bara när det behövs.

**Alternativen härleds ur datan.** En modell som väljer fritt ur den globala
taxonomin kan svara `bäddsoffa` på en Landskrona — och då blir resultatet noll
annonser, eftersom Landskrona aldrig gjorts som bäddsoffa. Därför slås det
först upp vilka typer som faktiskt finns för den sökta modellen, och bara de
erbjuds. Tröskeln är densamma som för strikt filtrering, så varje alternativ
klarar garanterat filtret:

```
Landskrona  ->  soffa (405), hörnsoffa (92), fåtölj (50), fotpall (27)
Vimle       ->  soffa (465), bäddsoffa (208), hörnsoffa (179), fotpall (47), fåtölj (26)
Malm        ->  byrå (2499), säng (689), bord (547), spegel (61), hylla (42)
Friheten    ->  bäddsoffa (1078), soffa (78)
Billy       ->  hylla (1540)                    <- bara en typ, inget anrop görs
```

**Färre än två alternativ ⇒ inget anrop.** En Billy är alltid en hylla; då
finns inget att välja mellan och filtret skulle ändå inte ändra något.

**Modellen får svara med flera typer.** En bäddsoffa ser ut som en vanlig soffa
när den är ihopfälld — ett foto kan omöjligt avgöra saken. Att tvinga fram ett
val ger fel svar i halva fallen. Istället tas unionen:

| Svar | N | Intervall |
|---|---|---|
| bara `soffa` | 465 | 3 000 kr |
| bara `bäddsoffa` | 208 | 5 500 kr |
| **`soffa` eller `bäddsoffa`** | **673** | **3 000 – 3 500 – 4 400 kr** |
| bara `fotpall` | 47 | 1 000 kr |

Osäkerheten breddar intervallet istället för att ge ett självsäkert fel svar —
och fotpallen är fortfarande utesluten, vilket var hela poängen.

Antalet annonser per typ skickas med i prompten som prior, så modellen kan väga
in hur vanlig varje typ är när bilden är tvetydig.

**Robusthet.** Svaret filtreras mot kandidatlistan även efter att schemat
låst det — om modellen ändå hittar på en typ släpps den. Låg konfidens eller
tomt svar ger inget filter alls: att gissa fel filtrerar bort rätt
jämförelseannonser, vilket är sämre än att inte filtrera.

Misslyckas anropet — saknad nyckel, trasig bild, nätverksfel — loggas det och
prisförfrågan fortsätter utan typfilter. Bilden är ett hjälpmedel, inte ett krav.

### Nyckel och modell

```bash
cp .env.example .env      # fyll i OPENAI_API_KEY
```

`.env` läses automatiskt vid uppstart och är gitignorerad. Redan satta
miljövariabler vinner över filen.

Default är **`gpt-4o-mini`**. Byt med `VARIANT_MODEL` i `.env` eller
`price_engine/config.py`. Kostnaden domineras av bilden, inte texten — skala
ner fotot innan uppladdning, 768 px räcker gott för möbeltyp.

Utan nyckel fungerar allt utom bildklassningen. `openai` och `python-dotenv`
är valfria beroenden.

## Bildmatchning

Samma modellnamn kan betyda tyg eller skinn, beige eller mörkblå,
originalklädsel eller omklädd. Namn och märke skiljer inte dessa åt, så
medianen blandar varianter som borde prissättas olika. Säljarens egen bild
avgör vilka annonser som faktiskt är jämförbara.

### Principen: omsortering, inte sökmotor

```
1. Filtrera på märke, modell, typ, skick, färskhet   -> ~200 kandidater
2. Ranka DESSA på bildlikhet mot säljarens bild
3. Behåll de närmaste
4. Kör den befintliga prisalgoritmen på den mängden
```

Tre fördelar samtidigt: en fåtölj kan inte matcha en soffa för att bakgrunden
är lika; vi jämför mot ~200 vektorer i stället för 94 000; och prislogiken
behöver inte röras — den matas bara med en bättre urvalsmängd.

### Modellval

**`facebook/dinov2-small`** (384 dim, Apache 2.0). CLIP är stark på det
semantiska ("grön sammetssoffa") men trubbig på finkorniga skillnader. DINOv2
fångar visuell identitet — benens form, sömmar, klädselstruktur, proportioner
— vilket är precis smärtpunkten. Byt i `EMBED_MODEL` i
[config.py](price_engine/config.py).

Utöver embeddingen räknas ett **HSV-färghistogram** (32 bins/kanal). DINOv2 är
förvånansvärt tolerant mot färg, och färg är ofta en verklig prisskillnad.
Vikten är konfigurerbar:

```
poäng = (1 - COLOR_WEIGHT) * bildlikhet + COLOR_WEIGHT * färglikhet
```

### Beskärning

Annonsbilder är fulla av vardagsrum, mattor och husdjur. Varje bild körs genom
**YOLO11n**, beskärs till möbeln, och först då embeddas den. Hittas ingen möbel
används hela bilden och raden märks som obeskuren (~33 % av fallen).

Uppmätt på denna maskin: `imgsz=640` 154 ms/bild, `imgsz=320` **38 ms** — och
träffsäkerheten sjunker inte (44 % mot 42 %). Därför 320.

Spara exempel att ögna med `--samples`:

```bash
.venv/bin/python embed_images.py --recent-only --samples 30
open .cache/vectors/crops/
```

### Kör jobbet

```bash
# 1. Hämta bilderna (~32 min, 5,3 GB)
.venv/bin/python -m price_engine.images prefetch --recent-only

# 2. Embedda (~4 h på CPU) — avbrottssäkert, kör om för att fortsätta
.venv/bin/python embed_images.py --recent-only
.venv/bin/python embed_images.py --status

# 3. Rensa bildcachen när vektorerna är klara — STEG 3 ÄR OBLIGATORISKT
.venv/bin/python -m price_engine.images clear
```

Uppmätt: nedladdning **48 bilder/s**, embedding **148 ms/bild**.

> **Steg 3 hoppades över en gång, och 94 356 JPEG-filer (5,3 GB) låg kvar i
> fyra månader** innan en upphovsrättsinventering hittade dem. Kommandot fanns
> dokumenterat men hade aldrig körts. Filerna är raderade. Kör steg 3 i samma
> session som steg 2 — en cache som "ska rensas senare" rensas inte.

**Bilderna sparas aldrig permanent — bara vektorerna.** En embedding är ingen
kopia av bilden, vilket gör upphovsrättsfrågan kring annonsbilder betydligt
mindre obekväm. Bildcachen är temporär och rensas med ett kommando.

### Lagring

```
embeddings.npy   (N, 384) float16    ~70 MB för 94k
colors.npy       (N, 96)  float16
cropped.npy      (N,)     bool
ids.json         radindex -> URL-hash
index.faiss      för helbeståndssökning och analys
```

Vektorerna nycklas på **URL-hash, inte annons-ID**, så flera annonser med samma
bild delar rad (tradera har 65 % dubbletter). FAISS finns för analys och
dedupning; API-flödet använder numpy — vid ~200 kandidater är en skalärprodukt
snabbare än ett indexuppslag.

### Validera innan du litar på det

```bash
# Vad tycker modellen är likt?
.venv/bin/python validate_images.py peek min_soffa.jpg --name Madison --brand Mio

# Var går gränsen? CSV: bild_a,bild_b,samma|olika
.venv/bin/python validate_images.py pairs mina_par.csv
```

Märk upp tio par av varje sort för hand. Verktyget rapporterar
poängfördelningen per grupp, föreslår tröskeln som separerar bäst, och varnar
om separationen är under 80 %.

**`IMAGE_SIMILARITY_MIN = 0.45` är provisorisk.** Den bygger på en mätning över
2 000 vektorer: samma möbeltyp landar på 0,52–0,75, medianen mot slumpmässiga
annonser är 0,22, och en fråga utan bra match toppar på 0,21. Sätt den på
riktigt med `pairs`-läget.

### I API:et

Bilden är **valfri**. Utan bild beter sig API:et exakt som förut.

```bash
curl -X POST http://127.0.0.1:8000/price \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Madison\",\"brand\":\"Mio\",
       \"image_base64\":\"$(base64 -i min_soffa.jpg)\"}"
```

Svaret utökas med `imageFiltered` (`filtered` / `loosened` / `none`),
`imageMatchCount` och `similarityRange`. Alla befintliga fält är oförändrade.

**Fallback:** överlever färre än 5 annonser tröskeln lättas den stegvis
(0,45 → 0,35 → 0,25 → 0,15), och sista utvägen är de 30 mest lika. Metoden
säger alltid vilket som hände.

Samma uppladdade bild används till **två** saker: möbeltyp via `gpt-4o-mini`
(om `variant` inte angetts) och visuell likhet via DINOv2 lokalt. Sätt
`image_rerank: false` för att bara använda den till möbeltyp.

## Skick

> **AVSTÄNGT.** `config.CONDITION_PRICING = False` — priset är just nu **helt
> oberoende av skick**. Ingen filtrering, ingen multiplikator, ingen
> bandskalning. Kvar är grundalgoritmen: matcha, sortera, median och fönstret
> runt den. Ett angivet `condition` tas emot och ekas tillbaka i svaret men
> påverkar ingenting, och `conditionMethod` blir `disabled` så att det syns
> att skicket ignorerades avsiktligt och inte av databrist.
>
> Slå på igen med `PRICE_ENGINE_CONDITION=1` eller genom att sätta flaggan
> till `True`. Allt som beskrivs nedan är orört och testat — testsviten kör
> skickkedjan med flaggan påslagen, så maskineriet fortsätter verifieras.
>
> Bakgrunden: leave-one-out visade 37 % medianfel för `nyskick` (bara 1,2 ×
> bättre än att strunta i skicket), 14 % för `mycket_gott` och 20 % för
> `slitet`, att jämföra med en intervallbredd på ±33 %. Skickmodellen görs om.

Skick är märkt på bara **7,8 %** av utropspriserna (`archive`: 0 %, `blocket`:
99,7 %) men på 72,1 % av auktionspriserna. Strikt filtrering är mest exakt när
underlaget räcker, men kollapsar snabbt: Landskrona har 624 träffar, varav
1 i `Nyskick` och 3 i `Okej skick`. Det gav absurda svar — en Poäng i nyskick
prissattes till 1 725 kr av två extremvärden, mot 400 kr för alla skick.

Motorn kör därför en kedja och redovisar alltid vilket steg som användes i
`conditionMethod`:

| Metod | När | Vad som händer |
|---|---|---|
| `filtered` | ≥ 15 annonser i rätt skick | Filtrera strikt. Riktiga observationer slår varje kvot. |
| `reference` | Toppskick utan eget underlag | Medianen används som den är |
| `capped` | Skickfiltret gav ett högre pris | Förkastas — medianen höjs aldrig |
| `band` | Färre än så, bas `asking` | Räkna på alla skick, skala **ned** |
| `ignored` | Bas `realized`, eller band saknas | Släpp skicket, justera inte |
| `none` | Inget skick angavs, eller otolkbart | — |
| `disabled` | `CONDITION_PRICING = False` | Hela steget hoppas över (nuvarande läge) |

### Banden — medianen sänks, aldrig höjs

Skicket justerar priset **bara nedåt**. Den obetingade medianen behandlas som
toppskickspris, och sämre skick drar ner. Maxfaktorn är 1,00.

**Varför taket finns.** Två skäl. Dels var uppräkningen motorns värsta
felkälla: bandet gav 2,00× för Nyskick på hög prisnivå, medan direkt jämförelse
per modell ger ~1,14× (Söderhamn 1,14 · Ektorp 0,65 · Billy 1,14 · Malm 1,14) —
resultatet blev 5 000 kr för en Landskrona i nyskick. Dels går det inte att
fastställa vilket skick baslinjen motsvarar, se nedan. Taket gör felet
strukturellt omöjligt istället för bara osannolikt.

**Nyskick och Mycket bra skick är samma nivå** (`Toppskick`). De har nästan
identisk kvot (1,43 mot 1,39) men Nyskick spretar 2,5× mer (IQR/median 0,72 mot
0,29). Sammanslagningen kostar inget i träffsäkerhet och ger dessutom fler
annonser åt det strikta filtret — Landskrona går från 20 + 1 separat till 21
gemensamt, vilket räcker för `filtered`.

### Sänkningstabellen

Kvoterna räknas parvis inom undergrupp, mot Toppskick, grupperat på prisnivå:

| Prisnivå | Bra skick | Okej skick | Grupper |
|---|---|---|---|
| låg (≤ 750 kr) | 0,83 → **−17 %** | 0,60 → **−40 %** | 15 |
| mellan (750–1 100 kr) | 0,76 → **−24 %** | 0,50 → **−50 %** | 12 |
| hög (> 1 100 kr) | 0,60 → **−40 %** | 0,30 → **−70 %** | 14 |
| **(alla)** | **0,72 → −28 %** | **0,50 → −50 %** | **41** |

Monotont och tolkbart: dyra möbler tappar mer på slitage.

### Varför bara prisnivå

Leave-one-out mot ny möbel, medianfel på kvoten:

| Schema | Bra skick | Okej skick |
|---|---|---|
| Global konstant | 0,218 | 0,146 |
| **Per prisnivå** | **+19 %** | **+25 %** |
| Per möbeltyp | +10 % | +10 % |
| **Per märke** | **+1 %** | **−3 %** |
| Prisnivå × möbeltyp | +16 % | +26 % |

Märke ser lovande ut i råtabellen men bara IKEA (36 grupper), Jysk (30) och Mio
(31) har underlag — och alla tre är billiga märken som bara reproducerar den
låga prisnivån. Resten har 3–7 grupper och ger nonsens (Elfa 2,00, Sweef 0,98).
Möbeltyp hjälper men tillför inget utöver prisnivå när de kombineras.

### Taket gäller alla vägar, även `filtered`

Skicketiketten mäter delvis **vilken möbel det är**, inte bara slitaget. Den
som säljer en nästan ny dyr soffa skriver "nyskick"; den som säljer en gammal
billig skriver "bra skick". Ett filter på toppskick selekterar därför för dyra
objekt.

Mio Madison, rak soffa, senaste 8 månaderna:

```
17 000 kr  MIO Madison soffa, helt ny i förpackning        <- oöppnad
11 900 kr  *NYSKICK BEIGE MIO MADISON SOFFA*(fri leverans) <- återförsäljare
 7 000 kr  Madison Lux 3-sits + fotpall                    <- paket
       ...
 2 900 kr  MIO MADISON 3 SITS SOFFA                        <- privatannons
 2 500 kr  Madison                                         <- privatannons
```

Toppskicksfiltret gav **7 000 kr** mot 5 000 för hela underlaget. Därför kapas
varje skickväg mot den obetingade medianen — inte bara bandet:

| Sökning | Metod | Svar |
|---|---|---|
| Madison utan skick | `none` | 4 000 – 5 000 – 5 800 kr |
| Madison + mycket bra skick | `capped` (var 7 000) | 4 000 – **5 000** – 5 800 kr |
| Madison + gott skick | `filtered` (35 st) | 3 000 – **4 000** – 5 000 kr |
| Madison + okej skick | `band` | 1 121 – **1 505** – 1 847 kr |

`capped` betyder att skickfiltret gav ett högre pris än det obetingade och
därför förkastades. Metoden syns i svaret, och `note` skriver ut vilket pris
som kapades bort.

### Vilket skick motsvarar baslinjen? Det går inte att veta

Det ligger nära till hands att fråga vad den obetingade medianen "egentligen"
representerar, och justera därifrån. **Datan kan inte svara på det**, och tre
försök misslyckades på tre olika sätt:

| Ansats | Resultat | Varför den inte håller |
|---|---|---|
| Blandningsmedianen mot varje nivås median | "Bra skick" | Nästan cirkulärt — Bra skick är 45,6 % av de märkta, och en blandningsmedian hamnar vid den vanligaste komponenten |
| Archive (omärkt) mot blockets nivåer | "Bra skick" | Blandar ihop källa och skick; två marknadsplatser på samma prisnivå säger inget om skick |
| Omärkta **inom** blocket | "Okej skick" | Enda rena testet, men 242 annonser över ~10 grupper — och kan mäta annonskvalitet snarare än möbelskick |

92 % av annonserna saknar skickuppgift per definition. Ingen mätning återskapar
den.

**Därför taket.** En uppräkning kräver att man vet vad man räknar upp *från*.
Det gör man inte, så motorn räknar aldrig upp. Det svaga testet som finns pekar
dessutom mot att baslinjen ligger sämre än antaget — i så fall är sänkningarna
snarare för milda än för hårda.

`BAND_MAX_FACTOR` i [config.py](price_engine/config.py) styr taket om du vill
mjuka upp det, men gör det då med öppna ögon: det finns inget mätvärde att
kalibrera mot.

### När svaret märks osäkert

`confidence` sänks till `"low"` i två fall:

- **Vidd band** — `p75/p25 > 2`. Kvoten spretar för mycket för att lita på.
  Vidden mäts på p25/p75, inte på skalningskvantilerna (p40/p60), eftersom de
  senare är för smala för att flaggan någonsin skulle lösa ut.
- **Tunt band** — färre än 10 undergrupper. Ett *smalt* band från 7 grupper är
  inte ett välbestämt band.

Inspektera banden med `--bands` eller `GET /condition-bands`.

## Anpassningar till den faktiska datan

Datan visade sig se annorlunda ut än specen antog. Fyra saker styr designen:

**`brand` är null på 97,7 % av raderna.** En ren kolumnmatchning på varumärke
hade kastat bort nästan hela underlaget. Motorn accepterar därför träff
antingen i `brand`-kolumnen **eller** i annonstexten. För IKEA ger det 58 848
kandidatrader istället för 19 783.

**Två prissorter får inte blandas — och `realized` är auktionsdata.**
Datan innehåller 1 055 740 utropspriser (`asking`) och 470 379 realiserade
priser (`realized`). Av de realiserade är **99,97 % auktion** (auctionet
461 564 + tradera 8 674); bara 141 rader är marknadsplatsförsäljning.

Det betyder att `realized` mäter vad möbler *klubbas för på auktion*, inte vad
de säljs för på Blocket. Skillnaden är systematisk:

| Sökning | realized | asking | diff |
|---|---|---|---|
| Landskrona / IKEA | 910 kr (N=14) | 2 500 kr (N=624) | −64 % |
| Kivik / IKEA | 500 kr (N=17) | 1 500 kr (N=1 593) | −67 % |
| Ektorp / IKEA | 450 kr (N=55) | 1 000 kr (N=2 131) | −55 % |
| Bruno Mathsson | 4 200 kr (N=8 024) | 6 500 kr (N=2 390) | −35 % |
| Wegner | 5 132 kr (N=1 972) | 8 250 kr (N=224) | −38 % |

Täckningen är dessutom spegelvänd: auktionshusen säljer designklassiker, inte
IKEA. Mathsson har 8 024 realiserade priser men bara 2 390 utropspriser;
Landskrona har 14 respektive 624.

### `auto`: välj bas på marknadsdominans

Default är `"auto"`, som väljer realiserade priser bara när auktion faktiskt
**är** marknaden för möbeln — inte när det bara råkar finnas tillräckligt
många rader:

```
realized_N >= max(AUTO_MIN_REALIZED, asking_N * AUTO_REALIZED_SHARE)
```

Utfallet på riktig data. Separationen är entydig — det finns inget gränsfall
mellan 0,64 och 0,026, så tröskeln på 0,50 är ingen finjustering:

| Sökning | realized | asking | andel | bas | pris |
|---|---|---|---|---|---|
| Wegner | 1 972 | 224 | 8,80 | `realized` | 5 132 kr |
| Bruno Mathsson | 8 024 | 2 390 | 3,36 | `realized` | 4 200 kr |
| String | 5 358 | 6 813 | 0,79 | `realized` | 550 kr |
| Pall | 22 285 | 34 854 | 0,64 | `realized` | 550 kr |
| | | | *0,50* | | |
| Ektorp | 55 | 2 131 | 0,026 | `asking` | 1 000 kr |
| Landskrona | 14 | 624 | 0,022 | `asking` | 2 500 kr |
| Söderhamn | 41 | 2 995 | 0,014 | `asking` | 2 500 kr |
| Kivik | 17 | 1 593 | 0,011 | `asking` | 1 500 kr |

Designklassiker prissätts alltså på vad de faktiskt betalats för, IKEA på vad
marknadsplatserna begär. Vilken bas som användes returneras alltid i
`priceBasis` och upprepas i `note` — nivåerna skiljer sig för mycket för att
det ska få vara implicit.

Sätt `price_kind` till `"realized"`, `"asking"` eller `null` för att gå förbi
automatiken.

**`condition` är null på 72,4 % av raderna** och har bara fyra värden:
`Nyskick`, `Mycket bra skick`, `Bra skick`, `Okej skick`. Fritext mappas via
synonymtabell — `"gott skick"` finns inte som värde i datan och blir
`Bra skick`. Se `CONDITION_SYNONYMS` i [price_engine/config.py](price_engine/config.py).
Hur skicket hanteras vid prissättning beskrivs i eget avsnitt nedan.

**`canonical_text` används inte.** Kolumnen är trunkerad i datan och innehåller
ofta bara skicktexten (`"Okej skick"`), vilket förstör namnmatchningen.
Sökningen bygger på `title_norm` + `title_raw` + `brand` + `ikea_model` +
`designer` + `material` + `type_word` + `era`.

## Prestanda

Den städade tabellen cachas som parquet i `.cache/`. Cachenyckeln är
filsökväg + mtid + storlek + `CACHE_VERSION`, så cachen ogiltigförklaras
automatiskt när datan eller städlogiken ändras.

| | Tid |
|---|---|
| Första inläsningen (1,5M rader, bygger cache) | ~32 s |
| Efterföljande inläsningar (från cache) | ~2,7 s |
| En prisförfrågan | ~0,6 s |

Förfrågningstiden domineras av delsträngssökningen över ~1M rader. Räcker det
inte är nästa steg ett inverterat index över titelord.

## Benchmarken och dess instrument

De 35 benchmarkmöblerna körs med `evaluate_examples.py`. Specarna byggs ur
PDF:erna av `extract_benchmark_specs.py`, så PDF:en är källan och JSON-filen en
härledning.

```bash
python extract_benchmark_specs.py --images
CELL_FILTER_ENABLED=1 python evaluate_examples.py \
    --specs benchmark/items_11.json --images benchmark/images_11.json \
    --modes "kärnnamn,kärnnamn + bild" --frozen --out bench/11
```

### Instrumentet är fryst

Harnessen ändrades **fem gånger** under utvecklingen. Följden var att inga två
körningar var jämförbara, och till slut orsakade instrumentet självt 5 av 13
missar — 14,3 procentenheter som tillskrevs motorn men var mätfel:

| spec | söknyckel som skickades | rätt nyckel |
|---|---|---|
| `soffa med puff` | `med puff` — ett fotpallsord | `soffa med puff` |
| `säng 303` | `303` — noll träffar | `säng 303` |
| `Ekbord med stolar` | `matbord` | `Ekbord stolar` |
| `Matbord trä` | `matbord` — identisk med raden ovan | `Matbord trä` |
| `Matgrupp byCrea` | `matgrupp` | `Matgrupp byCrea` |

**Regeln från och med nu:**

1. `HARNESS_VERSION` i `evaluate_examples.py` höjs vid **varje** ändring av
   söknyckelregeln, specextraktionen eller lägesnamnen. Versionen skrivs till
   varje `sammanfattning.json`.
2. Varje sådan ändring rapporteras som **MÄTRÄTTELSE** med omkörning av alla
   fyra lägen — **aldrig som en förbättring**. En rättad mätning som ger en
   högre siffra har inte gjort produkten bättre.
3. `tests/test_harness_frozen.py` låser söknyckelregeln. Går ett test där
   sönder är det instrumentet som ändrats, inte motorn.
4. `spec_fingerprint` i resultatfilen identifierar testmängden; ändras facit
   ändras avtrycket.

## Tester

```bash
.venv/bin/python -m pytest tests/ -q
```

170 tester mot syntetisk data: median (jämnt/udda), `HalvIntervall`-golvet,
fönsterlogiken, extremvärdesskydd, kantfallen (0 träffar, 1 träff, färre
annonser än fönstret), prisparsning, skicknormalisering, val av prisbas
(`auto`-tröskeln i båda riktningarna), hela skickkedjan inklusive att
banden aldrig räknas på auktionsdata, tokenmatchningen (ordning,
skiljetecken, siffrornas ordgräns, flerordsmärken) samt möbeltypen
(exklusiv tilldelning, hela filterkedjan, att kandidaterna härleds ur datan,
att inget modellanrop görs när bara en typ är möjlig, och att bildanropet
bygger rätt prompt och data-URL — verifierat mot en fejkad klient). Delar och
tillbehör har egna tester: att delorden träffar, att "med X" och
auktionsbeskrivningar *inte* gör det, att längsta träffen vinner vid samma
position, och att delarna faktiskt försvinner ur kandidatmängden.

## Filer

| Fil | Ansvar |
|---|---|
| [price_engine/config.py](price_engine/config.py) | Sökvägar, kolumnmappning, tröskelvärden, synonymer |
| [price_engine/data_loader.py](price_engine/data_loader.py) | Inläsning, städning, normalisering, cache |
| [price_engine/pricing.py](price_engine/pricing.py) | Matchning, prisbas, skickkedja + intervallalgoritmen |
| [price_engine/condition.py](price_engine/condition.py) | Skickband (percentiler) härledda ur datan |
| [price_engine/variant.py](price_engine/variant.py) | Möbeltyp: taxonomi, textklassning, bildklassning |
| [price_engine/images.py](price_engine/images.py) | Bildkällor: hitta, normalisera, cacha (fas 1) |
| [price_engine/vision.py](price_engine/vision.py) | Beskärning, DINOv2-embedding, färghistogram (fas 2–3) |
| [price_engine/vectors.py](price_engine/vectors.py) | Vektorlagret, uppslag per annons (fas 4) |
| [build_condition_multipliers.py](build_condition_multipliers.py) | Nattjobb: härleder skickmultiplikatorerna ur egen data |
| [embed_images.py](embed_images.py) | Batchjobbet — återupptagningsbart |
| [validate_images.py](validate_images.py) | Ögna- och trösklingsläge (fas 5) |
| [price_engine/api.py](price_engine/api.py) | FastAPI-lagret |
| [price_engine/cli.py](price_engine/cli.py) | CLI för snabbtest |
| [tests/test_pricing.py](tests/test_pricing.py) | Enhetstester |

## Percentilstudie

Motorns percentiler (default ≈ p45, kanter p30/p60) var **valda, inte
uppmätta**. Studien mäter dem mot 104 237 auktionsförsäljningar matchade mot
samtida utropsannonser, med budantal som utfallsmått.

```bash
.venv/bin/python run_percentile_study.py profile   # fas 0: profilering
.venv/bin/python run_percentile_study.py all       # fas 1-4: hela studien
```

Resultatet ligger i [percentile_study/](percentile_study/) — `RAPPORT.md` med
sammanfattningen först, `sell_percentiles.json` för maskinläsning, figurer och
`PROGRESS.md`. Trösklar och märkesklasser bor i
[study_config.py](study_config.py) och är avsedda att redigeras.

**Ingenting av studien är inkopplat i motorn.** Kort svar på huvudfrågan:
mätt på den smala matchningen — den enda som liknar produktionens fråga —
ligger säljpercentilen på **p34**, mot motorns nuvarande ~p45. Men
smalhetstestet visar att en percentil uppmätt mot en bred fördelning bara
delvis överförs till en smal (korrelation 0,73, 38 % inom 10 percentilenheter),
så siffran ska inte kopieras rakt in utan att man först läser förbehållen.

## Bryggmätning, omlistningskedjor och snapshots

Tre uppföljningar till percentilstudien. **Ingen av dem är inkopplad i motorn.**

```bash
.venv/bin/python bridge_embed.py            # embedda auktionsbilder (Del A)
.venv/bin/python run_bridge_study.py        # Del A: percentil på motorns nivå
.venv/bin/python run_relist_study.py        # Del B: "för dyrt"-gradienten
.venv/bin/python snapshot_job.py observe    # Del C: en observation
.venv/bin/python snapshot_job.py events     # Del C: härled händelser
.venv/bin/python snapshot_job.py status     # Del C: när bär datan?
```

**Del A — [bridge_study/](bridge_study/)** mäter säljpercentilen mot exakt den
fråga motorn ställer: samma märke *och* modellnamn, ingen fallback-breddning.
4 703 försäljningar, medianjämförelsemängd 98 annonser. Svaret är **p34**, och
trappan bred → smal → motornivå konvergerar (p61 → p34 → p34).

**Del B — [relist_study/](relist_study/)** letar omlistningar i archive-datan:
samma möbel annonserad igen, till nytt pris. Resultatet är `indicative_only` —
precisionen når 0,74 mot kravet 0,90.

**Del C — [snapshot_job.py](snapshot_job.py)** bygger tidsserien framåt.
Designen står i [SNAPSHOT_DESIGN.md](SNAPSHOT_DESIGN.md); den viktigaste regeln
är att en missad körning aldrig får tolkas som att annonser försvunnit.
Första meningsfulla överlevnadskurvorna efter 6–8 veckors körning.

## Testfall och frysregler

Nya facit-möbler struktureras enligt [TESTFALL_MALL.md](TESTFALL_MALL.md).
Kontrollera sammansättningen innan mätning:

```bash
.venv/bin/python evaluate_examples.py --specs mina_fall.json --check-composition
.venv/bin/python evaluate_examples.py --specs mina_fall.json --images bilder.json \
    --out resultat --modes "kärnnamn,kärnnamn + bild" --frozen
```

**Frysregel:** inga trösklar, golv, taxonomiregler eller k-värden får justeras
mot en testmängd som används som bevis. Hittas ett fel och fixas är mängden
förbrukad. `--frozen` skriver specfilens hash till resultatet så att en ändrad
mängd inte tyst förväxlas med den ursprungliga. Resultatet rapporteras per
felklass (`storlek`, `anonym`, `tunt`, `övrigt`), inte som en totalsiffra.

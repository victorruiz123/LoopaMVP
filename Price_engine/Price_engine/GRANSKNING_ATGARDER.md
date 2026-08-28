# Åtgärdspaket efter extern granskning

Genomfört 2026-08-17. Sju delar, mätning mellan varje, 447 tester passerar.

**Tre av granskningens fem fynd bekräftades. Två visade sig vara felaktiga
premisser — och i båda fallen var mitt eget underlag i `ARKITEKTUR.md` det som
var fel, inte granskningen.** Detaljerna står under respektive del.

## Sluttabell

| mått | före (bench5, harness v5) | efter (bench6, harness v6) |
|---|---|---|
| default inom facit, läge D | 62,9 % | **60,0 %** |
| default inom facit, läge A | 57,1 % | 57,1 % |
| katastrofandel (>±50 %), läge D | 5/35 = 85,7 % rena | **5/35 = 85,7 % rena** |
| katastrofandel, läge A | 6/35 | **5/35** |
| andel `extended` (färskhetsfiltret) | okänd | **45,7 % — GULT** |
| teoretiskt tak | 73,1 % | **74,2 %** (81,2 % på de med underlag) |
| andel av taket uppnådd | 86 % | **81 %** |
| intervallbredd, läge D | 114,4 % | 115,4 % |

**Siffran gick NED 2,9 procentenheter, inte upp 10–14 som granskningen och jag
båda förväntade.** Det är den viktigaste enskilda upptäckten i paketet och
förklaras i del 2.

---

## Del 1 — Åldrande korpus

### Fyndet var värre än granskningen trodde: deadlinen har passerat

Granskningen skrev "inom veckor". Mätningen säger **för två dagar sedan**:

| källa | rader | senaste annons | färska | utgår ur fönstret |
|---|---|---|---|---|
| `archive` | 973 009 (63,8 %) | 2025-12-15 | **0** | **2026-08-15 — passerat** |
| `auctionet` | 461 564 | 2026-07-10 | 35 839 | 2027-03-10 |
| `blocket` | 82 731 | 2026-07-13 | 82 731 | 2027-03-13 |
| `tradera` | 7 831 | 2026-07-11 | 7 820 | 2027-03-11 |

**8,3 % av korpusen är färsk.** Den största källan bidrar med noll färska rader.

### Vad som byggdes

**1. Kanariemätaren** — `corpus_health.py`, med `--benchmark`.

Nivåerna går på andelen svar som föll till `extended`, inte på andelen färska
rader. Det är vad som faktiskt händer i sökningarna som räknas.

```
recencyMethod över benchmarken: {'window': 17, 'extended': 16, 'none': 2}
andel extended: 45,7 %   NIVÅ: GULT
```

Rapporterar dessutom senaste datum per källa, **utgångsdatum** per källa (dagen
källans färskaste rad faller ur fönstret) och möbeltyper med >1 000 rader men
under färskhetsgolvet — noll sådana i dag.

**2. Degraderingsskyddet** — `STALE_AFTER_MONTHS = 10`, konfigurerbart.

Används `extended` **och** är även den färskaste annonsen i mängden äldre än
gränsen: `confidence: "low"` plus förbehåll i `note`. Nytt svarsfält:

```json
"dataStaleness": {"newest": "2025-10-15", "ageMonths": 10.1, "stale": true}
```

Sex tester låser beteendet, bland annat att priset **inte** ändras av flaggan —
att tysta ett osäkert svar genom att flytta priset vore att blanda två beslut.

**Skyddet är riktat, inte generellt: av 33 besvarade benchmarkmöbler flaggas en.**
De flesta `extended`-mängderna innehåller ändå auktionsrader från 2026. Hög
extended-andel betyder alltså inte automatiskt gammal data — vilket är värt att
veta innan larmet tas som bevis.

**3. Inmatningsberedskapen — och en tyst bugg på vägen**

Verifieringen avslöjade att mottagningen **inte fungerade**:
`PREFERRED_FILES = ("master.parquet",)` gjorde att bara den filen lästes när den
fanns. En ny Blocket-fil i katalogen hade ignorerats utan felmeddelande — samma
antal rader, samma svar, ingen ledtråd.

Åtgärdat: `master.parquet` läses nu tillsammans med allt i `extra/`. Mottagningen
är därmed den handvändning du bad om:

```bash
cp blocket_2026_08.parquet $DATA_DIR/extra/
python corpus_health.py
```

`CACHE_VERSION` ska **inte** höjas för ny data — cachenyckeln innehåller varje
läst fils mtid och storlek, så en tillagd fil bygger om av sig själv. Fem tester
verifierar hela kedjan inklusive dedup mot befintliga rader. Kolumnkraven är
dokumenterade i README, med `price_kind` utpekad som den farligaste kolumnen.

**4. Snapshot-motsägelsen: `ARKITEKTUR.md` hade fel, och jag rättar den**

`snapshot_job.py` **finns** (10 030 byte), har kommandona `observe`, `events`,
`status`, och har egna tester. Mitt dokument påstod "designad, inte byggd" — det
var felaktigt.

**Men katalogen `snapshots/` existerar inte. Jobbet har aldrig körts. Noll dagar
observationer.** Tidsseriedatan finns inte, och varje dag utan körning är omätbar
tid som inte går att hämta i efterhand.

---

## Del 2 — Mäträttelse och frysning

### Vad som rättades

Exakt **6 av 35 söknycklar** ändrades. 29 är orörda, och de 12 första
benchmarkmöblerna gav identiskt resultat före och efter — vilket bekräftar att
rättelsen är riktad.

| spec | före | efter |
|---|---|---|
| `soffa med puff` (Bolia) | `med puff` | `soffa med puff` |
| `säng 303` (DUX) | `303` | `säng 303` |
| `Ekbord med stolar` | `matbord` | `Ekbord stolar` |
| `Matbord trä` | `matbord` | `Matbord trä` |
| `Matgrupp byCrea` | `matgrupp` | `Matgrupp byCrea` |
| `Matgrupp 5 stolar` | `matgrupp` | `Matgrupp 5 stolar` |

Att `puff` saknades i harnessens typordlista **var** buggen — ordet är ett
fotpallsord, så "soffa med puff" ströps till en sökning efter fotpallar.

### Frysningen

- `HARNESS_VERSION = 6`, skrivs till varje `sammanfattning.json` tillsammans med
  `spec_fingerprint`, `cell_filter_enabled` och `price_cells_enabled`.
- **21 tester** i `tests/test_harness_frozen.py` låser söknyckelregeln, inte
  implementationen: vad nyckeln BLIR för varje typ av specpost, att två olika
  möbler aldrig får samma nyckel, att tomt modellfält inte kraschar, att
  facit-overrides tillämpas.
- Regeln står i README: **varje framtida harnessändring rapporteras som
  MÄTRÄTTELSE med omkörning av alla lägen, aldrig som en förbättring.**

### Resultatet: −2,9 procentenheter, inte +10 till +14

| läge | före | efter | diff | katastrofer före → efter |
|---|---|---|---|---|
| A | 57,1 % | 57,1 % | ±0 | 6/35 → 5/35 |
| B | 57,1 % | 57,1 % | ±0 | 6/35 → 5/35 |
| C | 60,0 % | 57,1 % | **−2,9** | 4/35 → 5/35 |
| D | 62,9 % | 60,0 % | **−2,9** | 5/35 → 5/35 |

Fem möbler ändrades i läge D:

| id | möbel | facit | före | efter | träff |
|---|---|---|---|---|---|
| b1#9 | Matgrupp 5 stolar | 1 500–2 500 | 2 000 | **549** | ✓ → ✗ |
| b2#11 | Matgrupp byCrea | 5 000–15 000 | 1 250 | **inget svar** | ✗ → ✗ |
| b2#2 | Bolia soffa med puff | 8 000–11 000 | 2 599 | 3 593 | ✗ → ✗ |
| b1#4 | IKEA karlstrand | 500–2 000 | — | — | ✗ → ✗ |
| b2#12 | DUX säng 303 | 50 000–80 000 | — | — | ✗ → ✗ |

### Varför prognosen var fel — och vad det avslöjar

Min analys i `ARKITEKTUR.md` antog att en fullständigare söknyckel ger motorn mer
att arbeta med. **Motsatsen gäller.** `find_listings` kräver att SAMTLIGA ord
träffar, utan uppmjukning, så varje tillagt ord smalnar av monotont:

| söknyckel | träffar | median |
|---|---|---|
| `matgrupp` | 17 386 | 1 000 kr |
| `Matgrupp 5 stolar` | **231** | 662 kr |
| `Matgrupp byCrea` | **0** | — |
| `matbord` | 53 348 | 1 400 kr |
| `Ekbord stolar` | **404** | 612 kr |
| `Matbord trä` | 2 350 | 1 600 kr |

`byCrea` förekommer 8 gånger i korpusen, men aldrig tillsammans med `matgrupp` —
konjunktionen dödar sökningen.

**Det här är ett verkligt motorfel som den gamla harnessen gömde.** En användare
som beskriver sin möbel utförligare får färre jämförelser, och förbi en gräns
inga. Ingen termuppmjukning finns: motorn provar aldrig att släppa ett ord som
inte ger träff.

Jag har **inte** rullat tillbaka rättelsen för att jaga siffran. Instrumentet är
nu ärligt och mäter en svaghet i stället för att dölja den. Men det gör att
`GRANSKNING_ATGARDER.md` rapporterar ett lägre tal än `ARKITEKTUR.md` gjorde, och
skillnaden är mäträttelse — inte försämrad motor.

**Ny prioritet som följer av detta:** termuppmjukning i sökningen — släpp det ord
som ger noll träffar och redovisa att det släpptes — är sannolikt värd mer än
något av de fem förslagen i `ARKITEKTUR.md`. Den ligger inte i detta paket.

---

## Del 3 — Brusgolvet och taket, räknat om

Granskningen hade rätt. Att mäta brusgolvet på "identisk normaliserad rubrik"
blandar in produktvariation: rubriken "Matbord" är identisk mellan tusen olika
bord.

| population | grupper | rader | σ (log) | p75/p25 |
|---|---|---|---|---|
| alla identiska rubriker | 22 865 | 517 703 | 0,812 | 2,99× |
| **med validerat modellnamn** | **7 082** | **119 588** | **0,638** | **2,37×** |

σ faller **21 %**, och taket stiger:

| σ-modell | alla 35 | de 32 med underlag |
|---|---|---|
| 0,812 | 68,1 % | 74,5 % |
| **0,638 (gällande)** | **74,2 %** | **81,2 %** |
| per möbels egen jämförelsemängd | 45,6 % | 49,8 % |

### Den tredje modellen falsifierade sig själv

Att räkna taket ur varje möbels egen jämförelsemängd — härledd ur motorns
rapporterade p30 och p60 — gav 49,8 %, alltså **under** motorns uppmätta 60,0 %.
Ett tak under uppmätt prestation är inget tak.

Felet är instruktivt: spridningen i en jämförelsemängd mäter
**produktheterogenitet**, inte skattningsfel. "Alla Bolia-soffor" är en bred
mängd, men medianen av den kan ändå vara en bra skattning. Att dividera
heterogeniteten med √n och kalla det osäkerhet överskattar felet kraftigt.

Talet är däremot användbart som heterogenitetsmått, och det pekar ut missarna:
Bolia (9,8 %), Stalands happy (14,8 %), Matgrupp 5 stolar (15,6 %).

**Gällande tak: 74,2 %. Motorn ligger på 81 % av det, och 14 procentenheter är
åtkomliga — inte 10.** Avsnitt 8 i `ARKITEKTUR.md` är uppdaterat; den bekväma
versionen ligger inte kvar.

---

## Del 4 — Måttkonflikten: beslutsunderlag (inget ändrat)

Mätt i **en** körning, inte två: `percentileGrid` i svaret bär p05–p95 räknade med
motorns egen kvantilfunktion på exakt den jämförelsemängd frågan gav, så båda
tolkningarna läses ur samma svar. Två körningar hade riskerat att variera något
annat.

| tolkning | inom facit | för lågt | för högt | katastrofer |
|---|---|---|---|---|
| **dagens: default = p40** | **57,1 %** | 11 | 1 | 5/35 |
| alternativet: default = p50 | 51,4 % | 7 | 7 | 5/35 |

**p50 ligger 20,7 % högre än p40** (median över de 32 besvarade). Måttkonflikten
är alltså verklig och stor.

Tio möbler byter träffstatus mellan tolkningarna — sex vinner på p40, fyra på p50:

| id | möbel | facit | p40 | p50 | vinner |
|---|---|---|---|---|---|
| 11#1 | IKEA Ektorp | 400–900 | 900 | 1 100 | p40 |
| 11#3 | IKEA Vimle | 1 500–3 000 | 3 000 | 3 600 | p40 |
| 11#6 | IKEA Strandmon | 1 000–2 000 | 900 | 1 000 | **p50** |
| 11#11 | Kinnarps Capella X | 1 300–1 600 | 1 480 | 4 000 | p40 |
| b1#1 | Mio Town | 7 000–12 000 | 5 539 | 7 500 | **p50** |
| b1#2 | Mio Saturday | 3 000–6 000 | 5 565 | 6 900 | p40 |
| b1#7 | Stalands happy | 3 000–6 000 | 3 658 | 9 900 | p40 |
| b2#3 | Mio Harper soffa | 4 000–6 500 | 5 223 | 7 000 | p40 |
| b2#5 | Jysk Allese | 4 000–6 500 | 3 420 | 5 000 | **p50** |
| b2#7 | Swedese Lamino | 8 500–12 000 | 7 644 | 8 500 | **p50** |

### Vad valet betyder för produkten

**p40 — "pris som säljer".** Defaultet användaren ser är kalibrerat mot vad som
faktiskt byter ägare: bryggmätningen landade på p34, och omlistningsstudien visar
att prissänkningarna passerar 50 % redan i decilen p40–50. Glidknappens lägen
betyder då `low` = p30 "säljs snabbt", `high` = p60 "svårsålt men möjligt".
Löftet är *rimligt men snabbsäljande*.

**p50 — "rimligt utrop".** Defaultet blir marknadens mitt bland det som begärs,
vilket är samma storhet som facit är satt i. Glidknappen får då en annan
innebörd: `low` = "under marknaden", `high` = "över marknaden". Löftet är
*marknadsmässigt pris*, och säljaren får själv välja hur snabbt.

### Vad mätningen säger

**p40 vinner på träffsäkerhet, p50 vinner på bias.** p40 ger 57,1 % mot 51,4 %,
men dess fel är kraftigt osymmetriska (11 för lågt mot 1 för högt). p50 balanserar
felen nästan perfekt (7 mot 7) men träffar mer sällan — den överskjuter i stället
för att bara rätta skevheten.

Katastrofandelen är identisk (5/35) i båda, så måttkonflikten förklarar **inte**
katastroferna. De sitter i jämförelsemängden, inte i percentilen. Det är ett svar
på granskningens hypotes, och det motsäger den delvis.

**Inget är ändrat i produktionen.** `HALF_INTERVAL_RATIO` och allt annat är orört.

---

## Del 5 — Basvariant-viktning: premissen håller inte

**Detta byggdes inte, och skälet är en mätning.**

Fyndet antog att unionen ger varje typ vikt 1/3. Det gör den inte. `_apply_variant`
**filtrerar** till unionen och viktar sedan varje rad 1,0, så korpusens naturliga
proportioner gäller redan:

| modell | union | faktisk typmix i jämförelsemängden |
|---|---|---|
| Ektorp | soffa, bäddsoffa, hörnsoffa | **soffa 81 %**, bäddsoffa 11 %, hörnsoffa 8 % |
| Vimle | soffa, bäddsoffa, hörnsoffa | soffa 71 %, bäddsoffa 21 %, hörnsoffa 8 % |
| Kivik | soffa, bäddsoffa, hörnsoffa | soffa 85 %, hörnsoffa 13 %, bäddsoffa 3 % |
| Madison | soffa, bäddsoffa, hörnsoffa | soffa 100 % |

Att vikta soffa med 0,81 ovanpå en mängd som redan är 81 % soffa hade **kvadrerat**
koncentrationen, inte rättat något. Frekvensen är redan implicit i mängdens
sammansättning.

### Men den underliggande oron är verklig, och här är dess pris

Vad händer om mängden i stället begränsas till majoritetstypen?

| modell | union (alla typer) | bara majoritetstypen | skillnad | facit |
|---|---|---|---|---|
| Ektorp | 900 (n=90) | 850 (n=73) | −5,6 % | 400–900 |
| **Vimle** | 3 000 (n=75) | **2 200 (n=53)** | **−26,7 %** | 1 500–3 000 |
| Kivik | 2 000 (n=79) | 1 700 (n=67) | −15,0 % | — |
| Strandmon | 900 (n=44) | 900 (n=44) | ±0 | 1 000–2 000 |
| Madison | 4 500 (n=62) | 4 500 (n=62) | ±0 | — |

Föroreningen kostar upp till **26,7 %**, och riktningen är alltid uppåt —
hörnsoffor (1,205×) väger tyngre än bäddsoffor (0,823×) drar ned.

Både Ektorp och Vimle skulle hamna **mer centralt** i facit efter begränsningen
(900 → 850 respektive 3 000 → 2 200, båda från kanten in mot mitten).

**Varför jag inte byggde det ändå:** att smalna unionen till majoritetstypen
strider mot din instruktion "viktning, aldrig filtrering", och mot systemets
unionsprincip — ett okänt attribut ska ge bredare underlag, aldrig falskt precist.
Det är en designändring, inte en justering, och beslutet är ditt. Underlaget ovan
är vad det skulle vara värt.

---

## Del 6 — Antalsdetektering: byggd, mönstren mätta, flaggan AV

Du bad om att se mönstren innan regeln aktiveras. Här är de, mätta över
1 525 135 rader:

| mönster | träffar | andel | exempel |
|---|---|---|---|
| `N st` | 76 577 | 5,02 % | Karmstolar, 8 st, "Louis Ghost" |
| `par` | 43 733 | 2,87 % | Fåtöljer "Mina", ett par |
| `N stycken` | 10 318 | 0,68 % | STOLAR, 2 stycken, gustavianska |
| `N-pack` | 284 | 0,02 % | Möbelben i vitt, 4-pack |

### Uteslutna mönster, med skäl

| mönster | träffar | varför uteslutet |
|---|---|---|
| `N delar` | 23 652 | **"3delar, bok, Avanti, DUX. tv-bänk" är en TREDELAD möbel, inte tre enheter.** Ordet beskriver konstruktion. |
| `set om N` | 196 | för få för att gå att validera |
| `N-sits` | 24 768 | **fälla** — sitsantal, aldrig styckantal |
| `N år` | 508 | **fälla** — ålder |

Vanligaste antalen i `N st`: 2 (62 468), 4 (39 314), 6 (22 746), 3 (13 236).
`N st` är jämnt fördelad mellan archive (36 143) och auctionet (35 919).

### Vad som byggdes

`type_system/quantity.py` med `units(title)` och `per_unit(price, title)`.
Konservativ av konstruktion: returnerar `None` — "rör inte priset" — vid noll
träffar, vid **flera olika antal** i samma titel, vid antal över 12, och vid
`1 st`. Fälltermer maskeras bort innan siffran läses, så "Soffa 3-sits +
fåtöljer, 2 st" läses korrekt som 2.

**27 tester**, med fler fällor än träffar — eftersom risken bara går ett håll: en
felaktig styckdelning gör priset katastrofalt lågt, och alla sex katastrofmissar
i benchmarken är redan negativa.

### Varför flaggan är AV

Detektorn träffar **128 566 rader (8,43 % av korpusen)**, och medianpriset bland
dem skulle gå från 400 kr till **150 kr**. 84 612 av träffarna ligger i
auktionsdatan.

Det är en för stor förändring att aktivera på egen hand innan du godkänt
mönsterlistan, precis som du skrev. Inkopplingen i `price_query` är inte gjord —
`quantity.py` är ett fristående, testat bibliotek. Ordet från dig och den mäts
isolerat i alla fyra lägen.

---

## Del 7 — Matgruppsgranskningen: bekräftad ordning

Ligger efter del 2, som du specificerade. Den läser nu rättade siffror.

**En sak har ändrats i dess underlag.** Med rättad harness söker PINNTORP-fallen
och de anonyma matgrupperna på andra nycklar, och `Matgrupp byCrea` ger noll
träffar i stället för 30 generiska matgrupper. Matgruppsrabatten har fortfarande
tre oberoende observationer (0,52× parvis, Mio Santos, PINNTORP), men
benchmarkunderlaget för de anonyma matgrupperna är nu tunnare — inte tjockare.
Granskningen av 50 annonser är därmed viktigare, inte mindre viktig.

---

## Vad jag INTE ändrade

- **Ingen tröskel eller percentil justerad mot benchmarkutfall.** `k = 6` förblir
  märkt övertränad. `HALF_INTERVAL_RATIO` orört trots del 4:s underlag.
- **Rättelsen i del 2 rullades inte tillbaka** när siffran gick ned. Att jaga
  talet genom att återinföra ett trasigt instrument vore det värsta av alla
  utfall.
- **Del 5 byggdes inte** — mätningen falsifierade premissen.
- **Del 6:s flagga aktiverades inte** — 8,43 % av korpusen kräver ditt
  godkännande.
- **`PRICE_CELLS_ENABLED` förblir av.** `CELL_FILTER_ENABLED` förblir på.

## Beslut jag fattade själv

| beslut | motivering |
|---|---|
| `STALE_AFTER_MONTHS = 10` | `RECENCY_MONTHS + 2`. Marginalen finns för att en mängd vars färskaste rad ligger precis utanför fönstret inte är nämnvärt sämre än en vars ligger precis inuti. **Valt, inte mätt** — kör `corpus_health.py` för att se hur ofta det löser ut. |
| Läsa `extra/` tillsammans med master | Verifieringen visade att mottagningen annars var tyst trasig. Att dokumentera en trasig procedur hade varit sämre än att laga den. |
| `N delar` uteslutet ur antalsmönstren | Mätt: mönstret beskriver konstruktion ("tredelad tv-bänk"), inte antal. Att ta med det hade delat 23 652 rader felaktigt. |
| Utfyllnadsord (`med`, `och`, `till`) stryks ur etikettnycklar | `find_listings` kräver att alla ord träffar; `med` som hårt krav smalnar utan att identifiera. |
| Kompletterade harnessens typordlista med 20 ord | Att `puff` saknades var själva buggen. Utan komplettering hade rättelsen inte fungerat. |

## Nästa steg, i den ordning jag skulle ta dem

1. **Termuppmjukning i sökningen.** Del 2 avslöjade att `find_listings` är
   konjunktiv utan reservväg. Släpp det ord som ger noll träffar, redovisa att
   det släpptes. Sannolikt värd mer än något av de fem förslagen i
   `ARKITEKTUR.md` — tre av de fem katastroferna är nolltreffar eller
   överspecificerade sökningar.
2. **Din datainsamling.** `extra/` är redo och testad. Kör `corpus_health.py`
   efteråt och kontrollera att extended-andelen föll under 30 %.
3. **De nya benchmarkmöblerna**, efter frysningen — de blir de första ärliga
   testfallen och kan validera `k = 6`.
4. **Matgruppsgranskningen** (del 7).
5. **Ditt beslut om del 4 (p40/p50), del 5 (unionens smalning) och del 6:s
   flagga.**

# Prismotorn — fullständig arkitektur

Beskriver systemet som det faktiskt är den 2026-08-17, verifierat mot källkoden
och mot körningar på riktig data. Skriven för en granskare som inte har tillgång
till repot.

Systemets uppgift: en användare vill sälja en möbel och får ett prisförslag med
ett intervall. Ingången är märke, modellnamn och eventuellt möbeltyp, storlek,
skick och en bild. Utgången är `low` / `default` / `high` plus ett fyrtiotal
redovisningsfält som förklarar hur svaret kom fram.

**Systemet innehåller ingen maskininlärd prismodell.** Priset är alltid en
percentil över en mängd historiska annonser. Allt arbete ligger i att välja
VILKA annonser som hamnar i den mängden. De två modeller som används — DINOv2
för bildlikhet och YOLO11n för beskärning — rör bara möbeltypen, aldrig priset.

---

## 1. Flödet, steg för steg

### Översikt

```
förfrågan
  → STEG 0   normalisering
  → STEG A   textsökning över 1 525 135 annonser        → kandidater
  → STEG A2  cellfiltret: rensa bort skräp              → renad mängd
  → STEG B   prisbas: utrop eller korrigerad auktion    → bas
  → STEG C   möbeltyp ur attributkedjan L0–L5           → typ(er)
  → STEG C1  variantfilter på typen                     → smalnad mängd
  → STEG C2  färskhetsfilter, 8 månader                 → färsk mängd
  → STEG C3  storleksfilter                             → slutlig mängd + vikter
  → STEG E   skick (AVSTÄNGT i dag)
  → STEG F   percentiler p30 / p40 / p60                → intervall
  → STEG G   shrinkage mot bredare underlag om n < 30   → justerat intervall
  → STEG H   kohortanalys, confidence, noteringar       → svar
```

### STEG 0 — normalisering

All text NFKD-normaliseras, diakriter fälls till ASCII (`å ä ö → a a o`),
gemener, kollapsade blanksteg. Korpusen är förnormaliserad vid inläsning; en ny
förfrågan går genom samma funktion.

Konsekvensen är genomgående och lätt att missa: **alla lexikon och ordlistor i
systemet måste vara ASCII-foldade**. En ordlista som innehåller `bäddsoffa`
matchar aldrig, eftersom korpusen innehåller `baddsoffa`.

*Vid fel:* tom sträng ger tom sökning, vilket ger hela korpusen som kandidater.
Det fångas av att `find_listings` med tomt `name` bara används avsiktligt (i
shrinkage-steget).

### STEG A — textsökningen

**In:** normaliserat märke och modellnamn.
**Ut:** delmängd av korpusen.

Söker i `search_blob`, en sammanslagning av titel och extra textkolumner
(`ikea_model`, `designer`, `material`, `type_word`, `era`).

Tre delsteg i ordning:

1. **Reservdelar bort.** Rader vars `variant` är `PART` tas bort direkt.
   Modellnamnet bärs av hela reservdelssortimentet — "IKEA PAX" drog in gångjärn
   för 25 kr, och 17,5 % av underlaget låg under 200 kr.
2. **Märket.** Träff antingen i kolumnen `brand_norm` **eller** i annonstexten.
   Kolumnen är tom i 97,7 % av korpusen, så en ren kolumnmatchning skulle kasta
   nästan hela underlaget.
3. **Modellnamnet, ord för ord.** Varje ord måste finnas någonstans i texten,
   oberoende av ordning. Filtreringen sker sekventiellt så att varje efterföljande
   ord söks i en allt mindre delmängd.

Matchningsregeln per ord: **vanliga ord matchas som delsträng** (ger böjning
gratis — `soffa` träffar `soffor` och `3-sitssoffa`), **rena siffror kräver
ordgräns** (annars träffar `2` varje titel med "2024" eller "1200 kr").

Mätt konsekvens av ordbaserad matchning: "Landskrona 3-sits" som delsträng gav
95 träffar; ordbaserat hittas även "Soffa IKEA LANDSKRONA Grå 3-sits" och
"Landskrona 3 sits grön".

*Vid tomt resultat:* svaret blir `no_data` — `default=None`, `confidence="none"`,
noteringen "Hittade inga liknande annonser." Ingen fallback till bredare sökning
sker här; shrinkage i steg G kräver att den smala mängden är icke-tom.

**Känd svaghet:** ingen stavningstolerans. `karlstrand` (benchmark b1#4) ger noll
träffar och därmed inget svar.

### STEG A2 — cellfiltret

**In:** kandidatmängden, samt hela användartexten.
**Ut:** renad mängd + eventuell mjukmask för nedviktning + räknare per orsak.

Styrs av `CELL_FILTER_ENABLED`, **på sedan 2026-08-16**.

Varje annons i korpusen har fem flaggor beräknade vid inläsning (se avsnitt 4).
Filtret kastar rader som aldrig är rätt jämförelse:

| flagga | betyder | antal i korpusen |
|---|---|---|
| `is_bundle` | flera möbler i en annons ("soffa + fotpall") | 155 929 (10,2 %) |
| `is_accessory_only` | tillbehör ("klädsel till Ektorp") | 59 191 (3,9 %) |
| `is_comparison` | jämförelseannons ("liknande Lamino") | 43 446 (2,8 %) |
| `is_section` | lös modulsektion ("schäslongdel") | 5 675 (0,4 %) |

Dessa fyra kastas **utan golvprövning**. En klädsel är aldrig rätt jämförelse för
en soffa, inte ens när det är det enda som finns.

Ett femte kriterium, **typmotsägelse**, behandlas annorlunda: rader vars celltyp
är känd och skiljer sig från frågans typ kastas *om* mängden tål det. Rader med
**okänd** typ behålls alltid — 24,2 % av korpusen har ingen utskriven möbeltyp,
och att behandla okänt som motsägelse hade tömt mängden på sitt underlag utan
att ta bort ett enda fel.

**En bunt räknas som skräp bara när frågan inte själv är en bunt.** Söker
användaren "matgrupp bord och 4 stolar" är buntarna precis rätt jämförelse.

Cellnyckeln byggs ur **hela** användartexten (`attribute_text`), inte ur
söknyckeln. Anroparen får kapa söknyckeln — "Söderhamn bäddsoffa" kan skickas som
`name="Söderhamn"` med typordet enbart i attributtexten — och en kapad text
saknar möbelordet. Det var en verklig bugg: cellnyckeln blev `ikea|okand|`, slog
upp en uppsamlingscell på 1 489 rader och prissatte Söderhamn till 299 kr mot
facit 2 000–2 500.

*Filtergolvet:* skulle typmotsägelsedelen ta mängden under 30 rader behålls
raderna men viktas ned till 0,25. Det redovisas som
`filtersConverted: ["cellfilter_typ"]`.

### STEG B — prisbas

**In:** renad kandidatmängd.
**Ut:** delmängd med en enda prissort, plus basnamn.

Korpusen innehåller två oförenliga prissorter:

| prissort | rader | median | vad det är |
|---|---|---|---|
| `asking` | 1 055 740 | 900 kr | utropspris i annons — rätt marknad, men aspirationspris |
| `realized` | 469 395 | ~800 kr | klubbat auktionspris — faktiskt betalt, men fel population |

Beslutsordningen (`BASIS_PREFER_ASKING = True`):

1. **Är identiteten anonym** — varken märke eller modellnamn kan fastställas —
   används **alltid** utropspriser. Auktionsdata får aldrig prissätta en anonym
   förfrågan.
2. Annars: räcker utropspriserna till 30 rader används de.
3. Annars, om auktionsraderna är fler: auktionspriserna används men **räknas upp**
   med en mätt faktor (budget 1,04 / mellan 1,42 / premium 1,36).
4. Annars används vad som finns.

Regel 1 finns för ett mätt fel: "Ekbord med stolar" landade på 300 kr mot facit
2 000–5 000 kr (−85 %) just för att den gamla dominansregeln valde auktionsdata
för en anonym förfrågan.

Regel 3 finns för Swedese Lamino: 1 834 auktionsrader mot 363 utropspriser gav
basen `realized` och svaret 4 600 kr mot facit 8 500–12 000. Utropsmedianen för
samma möbel är 8 000 kr.

**Anonymitetsprövningen** är egen kod: ett ord räknas som generiskt om det står i
en lista på ~250 ord, ELLER om det slutar på ett listat typord på minst fyra
tecken och resten också är generiskt. Svenska sammansättningar kräver det —
`ekbord` är `ek` + `bord` och `sitssoffa` är `sits` + `soffa`, men ingen av dem
står i listan. Foge-s hanteras (`sammetssoffa`). Fyra tecken är minimum för att
`Landskrona` (slutar på `ona`) och `Strandmon` (slutar på `mon`) inte ska falla.

### STEG C — möbeltypen: attributkedjan L0–L5

**In:** hela användartexten, märket, eventuell frågebildsvektor.
**Ut:** en **lista** av möjliga typer, plus källa och konfidens.

Detta är systemets mest utarbetade del och skiljer sig från en vanlig
klassificerare på en avgörande punkt: **den gissar aldrig fram ett typval för att
slippa säga "vet inte".** Blir ett prisviktigt attribut okänt returneras unionen
av möjliga typer, och sökningen blir bredare i stället för falskt precis.

Typen härleds ur **attribut**, inte ur en etikett. Nio attribut med mätt
prispåverkan (1–5):

| attribut | påverkan | värden |
|---|---|---|
| `base` | 5 | soffa, bord, förvaring, stol, säng, sänggavel, spegel, fotpall |
| `sub` | 5 | matbord, soffbord, sidobord, skrivbord, matgrupp |
| `chair_kind` | 5 | fåtölj, matstol, … |
| `seats` | 4 | 1–8 |
| `set_items` | 4 | antal stolar i en matgrupp |
| `storage_kind` | 4 | hylla, byrå, skänk, vitrin |
| `corner` | 3 | hörnsoffa eller inte |
| `convertible` | 3 | bäddsoffa eller inte |
| `chaise` | 1 | divan/schäslong — **sammanslagen**, härleder ingen egen typ |

Lagren körs i **kostnadsordning**, och varje lager fyller bara det tidigare
lämnat tomt. Det upprätthålls strukturellt av `Attributes.set`, inte av
konvention.

| lager | källa | kostnad | vad det sätter |
|---|---|---|---|
| **L4/användare** | användarens svar | gratis, exakt | vad som helst; kan aldrig överskrivas |
| **L0 text** | ordlexikon över titeln | gratis, nästan exakt | alla attribut som står utskrivna |
| **L2 bild** | DINOv2-grannröstning | gratis, grov | endast `base` |
| **L1 prior** | modellnamnets fördelning i korpusen | gratis, statistisk | `base` (om bilden avstod), `sub`, `storage_kind`, `seats` |
| **L3 vision** | multimodal LLM | kostar per anrop | det L0–L2 lämnade tomt |
| **L5 union** | — | gratis | slår ihop till en lista när något är okänt |

**Ordningen mellan L1 och L2 är omvänd mot det ursprungliga uppdraget, och det är
en mätning som avgjorde det.** Uppdraget sa att priorn skulle vinna över bilden
vid låg entropi. På 658 fall där båda svarar har bilden rätt bas i 78,3 % och
priorn i 67,5 %; när de är oense har bilden rätt i 66,4 % mot priorns 18,8 %, i
varje enskild bastyp. Att strama åt priorns entropigräns gjorde det monotont
sämre. Bilden går därför först för `base`; priorn behåller förtur för `sub`,
`storage_kind` och `seats`, som bilden aldrig sätter.

Effekt på huvudmåttet: väntevärdet av prisfelet gick 438 → 342 kr, bas rätt
75,6 → 81,7 %, till priset av täckning 89,6 → 80,8 %.

**Asymmetrisk trovärdighetsspärr.** Ett lager som får gissa (L2, L3) måste nå
högre konfidens för att göra möbeln *billigare* (0,75) än *dyrare* (0,50). Skälet
är mätt: grannröstningen kallade 87 % av bäddsofforna "soffa" och 71 % av
hörnsofforna "soffa" — alla felkällor lutar mot att förenkla nedåt. Texten och
användaren går aldrig genom spärren; de vet.

**L3 anropas aldrig från prismotorn.** `use_vision=False` är hårdkodat i båda
anropen. Vision-lagret är byggt, testat och mätt men används bara av mätskript.

**L4 beräknas men styr inget.** Klargörande frågor och osäkerhetsåtgärder
(`clarifyingQuestions`, `typeUncertaintyAction`) räknas ut och exponeras i svaret,
men prissättningen läser dem inte. Kopplingen till ett användargränssnitt är
designad och obyggd.

*Vid fel:* hela kedjan är omgärdad av `try/except`. Ett fel i typsystemet får
aldrig fälla ett prissvar; källan blir `type_system_error` och motorn fortsätter
utan typfilter.

### Synonymexpansion

Sökningen expanderar **alltid** via ordgruppen, aldrig på det enskilda ord
användaren skrev. `schäslong` söker även `divan`, `chaiselongue`, `chaise longue`.

Två grupper expanderar till varandra utan att slås ihop som attributvärden:
`skänk ↔ vitrin` (mätt prisskillnad 9,4 %, konfidensintervallet utesluter 1,00)
och `divan ↔ hörn` (beskrivs ofta om varandra i annonser).

Stavfelstolerans (redigeringsavstånd 1) tillåts **bara** för tio ord som stavas
fel i verkliga annonser — `schaslong`, `hornsoffa`, `baddsoffa`, `vitrinskap` och
liknande. Generell tolerans är avvisad eftersom `bord`/`bort` och `soffa`/`sofa`
också ligger på avstånd 1.

### STEG C1 — variantfiltret

**In:** basmängd + lista av måltyper.
**Ut:** filtrerad mängd + metod (`filtered` / `relaxed` / `ignored` / `none`).

Tre steg:

1. **Strikt.** Behåll bara rader vars typ finns i mållistan. Räcker det till 15
   rader används det (`filtered`).
2. **Noll strikta träffar** betyder att typen inte gäller den här modellen — det
   finns ingen Landskrona-säng. Då släpps filtret helt (`ignored`). Att behålla de
   omärkta hade prissatt en möbel som inte existerar.
3. **Relaxat.** Uteslut bara rader som positivt ÄR något annat; behåll de okända.
   Räcker det till 15 används det (`relaxed`).
4. Annars släpps filtret (`ignored`) — hellre bredare än tomt.

Vilken kolumn som filtreras beror på taxonomi: attributsystemets typer
(`hornsoffa`, `skank`, `fatolj`) finns bara i `derived_type`, den gamla
taxonomins (`hörnsoffa`, `byrå`) bara i `variant`. Att blanda dem ger noll
träffar. `TYPE_SYSTEM_DRIVES_SEARCH` är på, så `derived_type` används; en
översättningstabell finns för det motsatta fallet.

### STEG C2 — färskhetsfiltret

**In:** mängden.
**Ut:** mängd inom 8 månader, eller de 15 senaste.

Marknaden faller mätbart: medianen i hela korpusen går 1 167 kr (2024-07) → 995
(2025-07) → 800 (2025-10) → 700–750 (2026). Samtidigt är 92 % av annonserna från
`archive`, som slutar 2025-12. Utan filter dominerar gamla priser — Mio Madison
landade på 6 000 kr mot 5 000 på dagens Blocket.

Räcker inte fönstret utökas det bakåt: de 15 senaste tas oavsett ålder
(`recencyMethod: "extended"`). Hellre några gamla priser än ett svar byggt på
tre annonser.

**Detta är det mest brutala filtret i kedjan.** I det spårade exemplet nedan går
1 332 rader till 90.

### STEG C3 — storleksfiltret

Storleken läses ur förfrågan eller ur texten (`2-sits`, `160x230`). Filtret
följer samma golvregel som resten: går mängden under 30 rader konverteras
filtret till nedviktning i stället för bortkastning.

Saknas storleksuppgift men spretar jämförelsemängden över storlekar — dyrastes
median mer än 1,5× billigastes — breddas intervallet och grupperna redovisas i
`sizeWarning`. Kivik hörnsoffa (2-sits 1 250 kr mot 5-sits 4 900 kr = 3,9×) löser
ut den.

### STEG E — skick

**Hela steget är avstängt.** `CONDITION_PRICING = False`. Priset är i dag helt
oberoende av skick: ingen filtrering, ingen multiplikator, ingen bandskalning.
Ett angivet skick tas emot, ekas tillbaka och märks `conditionMethod: "disabled"`
så att det syns i svaret att skicket ignorerades avsiktligt och inte av
databrist.

Maskineriet är byggt, testat och mätt (se avsnitt 4 och 7).

### STEG F — percentilberäkningen

**In:** en lista priser, eventuellt med vikter.
**Ut:** `low` / `default` / `high` / `confidence` / `note`.

```
n            = antal priser
halfInterval = round(n * 0,10), golv 5
lowOffset    = max(round(n * 0,20), 10)
ordered      = priserna sorterade
medianIndex  = n // 2

low     = ordered[medianIndex − lowOffset]        ≈ p30
default = min(ordered[medianIndex − round(n*0,10)], median)   ≈ p40
high    = ordered[medianIndex + halfInterval]     ≈ p60
```

Fönstret är **asymmetriskt och lutar nedåt**. Symmetriskt spände det p40–p60,
alltså mittersta 20 % av marknaden, och då låg även vänsterläget över 35:e
percentilen — den som drog reglaget till "säljs snabbt" konkurrerade ändå med en
tredjedel av marknaden som var billigare.

`default` ligger på p40, inte på medianen. Två oberoende mätningar drog det dit:
bryggmätningen (som mäter mot exakt den fråga motorn ställer) landade på p34, och
omlistningsstudien visar att prissänkningarna passerar 50 % redan i decilen
p40–50.

Vid vikter används en viktad kvantil i stället, med samma percentiler.

*Kantfall:* `n = 0` ger `default=None`. `n < 10` ger `confidence="low"` och en
notering om att fönstret täcker hela träffmängden, eftersom golvet (±5) då gör
`low`/`high` till absolut min/max.

### STEG G — shrinkage mot bredare underlag

Utlöses när `n < 30`.

Den bredare mängden är **samma märke och möbeltyp, utan modellnamn**.
Modellnamnet är det som gör mängden tunn, så det är det som släpps. Märket
behålls — en Kinnarps kontorsstol jämförs med andra Kinnarps kontorsstolar, inte
med alla kontorsstolar i landet (det gav 500 kr mot facit 1 300–1 600).

```
w    = n / (n + 6)
svar = smal^w · bred^(1−w)          (blandning i logrummet)
```

Blandningen är **geometrisk** eftersom priser är multiplikativa: mellan 900 och
4 000 kr ligger den geometriska mitten på 1 900, den aritmetiska på 2 450. Den
geometriska är rätt när felet mäts i procent.

Kräver att den bredare mängden själv har minst 20 rader.

### STEG H — kohort, confidence, svar

Ett separat spår, den **visuella kohorten**, aktiveras bara när alla tre gäller:
förfrågan identifierar ingen produkt, det finns en bild, OCH ordkohortens
prisspridning är stor (p90/p10 > 6,0 i logdomän). Motiveringen är "Ekbord med
stolar": orden matchar 226 annonser vars Blocket-utrop ligger på 50–250 kr —
äkta priser, gammal brun ek är nästan värdelös — men bilden visar en tjock massiv
ekskiva där facit är 2 000–5 000 kr.

Svaret innehåller ~40 fält i fast ordning. De viktigaste redovisningsfälten:
`priceBasis`, `cellFilterDropped`, `variantMethod`, `variantSource`,
`recencyMethod`, `fallbackMethod`, `sizeWarning`, `percentileGrid`,
`possibleTypes`, `typeConfidence`.

---

## Ett konkret exempel: IKEA Ektorp

Verklig körning, faktiska mellanvärden. Förfrågan: `name="Ektorp"`,
`brand="IKEA"`, `attribute_text="Ektorp 2-sits"`. Facit (benchmark 11#1):
400–900 kr.

| steg | operation | resultat |
|---|---|---|
| 0 | normalisering | `ektorp`, `ikea` |
| A | textsökning | **2 017** kandidater (1 982 asking, 35 realized) |
| A2 | cellfiltret | **1 731** — kastade 144 buntar, 84 tillbehör, 57 sektioner, 1 jämförelse |
| B | anonym = nej, prisbas = `asking` | **1 703**, median 1 000 kr |
| C | attributkedjan | `seats=2` (text), `base=soffa` (text) → `derivedType=soffa`, `possibleTypes=[baddsoffa, hornsoffa, soffa]`, konfidens hög |
| C1 | variantfilter `filtered` | **1 332**, median 1 000 kr |
| C2 | färskhet `window`, gräns 2025-12-17 | **90**, median 1 100 kr |
| C3 | storlek — ingen önskad | **90**, median 1 100 kr |
| E | skick | hoppas över (`CONDITION_PRICING=False`) |
| F | percentiler, n=90 | halfInterval = round(9,0) = 9; lowOffset = max(18, 10) = 18; medianIndex = 45 |
| | | **low = 745, default = 900, high = 1 500** |
| G | shrinkage | ingen (n = 90 ≥ 30) |
| H | confidence | `high` |

**Svar: 745 – 900 – 1 500 kr.** Default träffar facits övre kant exakt.

Två observationer värda en granskares uppmärksamhet. Färskhetsfiltret tar bort
93 % av mängden (1 332 → 90) — det är den enskilt största beskärningen i kedjan
och den enda som inte har någon golvregel utöver 15 rader. Och `possibleTypes`
innehåller tre typer trots att texten sa `base=soffa` med hög konfidens; unionen
kommer av att `convertible` och `corner` är okända, och den breddar filtret till
alla tre soffvarianterna.

---

## 2. Beslutspunkter

| # | villkor | utfall | varför regeln finns |
|---|---|---|---|
| 1 | `variant == PART` | rad tas bort | "IKEA PAX" drog in gångjärn 25 kr; 17,5 % av underlaget under 200 kr |
| 2 | märke finns i kolumn **eller** text | rad behålls | `brand_norm` tom i 97,7 % av korpusen |
| 3 | sökordet är en ren siffra | kräver ordgräns | `2` matchade "2024", "1200 kr" |
| 4 | `is_bundle/accessory/comparison/section` | rad kastas, **utan golv** | aldrig rätt jämförelse; mätt 40,8 % av träffmängden |
| 5 | frågan är själv en bunt | buntar behålls | annars prissätts en matgrupp som ett löst bord |
| 6 | celltyp okänd | rad behålls | 24,2 % av korpusen; okänt ≠ motsägelse |
| 7 | typmotsägelse & mängd ≥ 30 efteråt | rader kastas | filtergolvet håller |
| 8 | typmotsägelse & mängd < 30 efteråt | rader **viktas ned** till 0,25 | ingen filterkedja får bryta golvet |
| 9 | identitet anonym | auktionsdata utesluts helt | "Ekbord med stolar" 300 kr mot facit 2 000–5 000 |
| 10 | asking ≥ 30 | asking används | motorn hjälper sälja på marknadsplats |
| 11 | asking < 30 & realized fler | realized × 1,04–1,42 | Lamino 4 600 kr mot facit 8 500–12 000 |
| 12 | text/användare har satt `base` | bilden körs men **skriver inte** | bilden redovisar bara om den håller med |
| 13 | bilden avstår (röstandel < 0,70) | priorn får fylla `base` | vald på kronofelsmåttet, platå 346/342/353 kr |
| 14 | gissning gör möbeln billigare | kräver konfidens ≥ 0,75 | 87 % av bäddsofforna kallades "soffa" |
| 15 | gissning gör möbeln dyrare | kräver konfidens ≥ 0,50 | asymmetrin är mätt, inte antagen |
| 16 | prisviktigt attribut okänt | **union** av möjliga typer | ett okänt attribut ska ge bredare underlag, aldrig falskt precist |
| 17 | klassificerare inskickad & unionen ≠ 1 typ | den får **smalna av**, aldrig bredda | bilden är mätt sämst av alla källor på undertyp |
| 18 | kvarvarande spridning < 1,15× | fråga inte, prissätt rakt av | unionen är redan smal nog |
| 19 | prisskillnad mellan attributvärden < 10 % | fråga inte / anropa inte | value of information under tröskeln |
| 20 | strikt typfilter ≥ 15 rader | `filtered` | |
| 21 | strikt typfilter = 0 rader | filtret **släpps** | det finns ingen Landskrona-säng |
| 22 | relaxat typfilter ≥ 15 rader | `relaxed` — okända behålls | 26,5 % anger ingen typ i titeln |
| 23 | färska rader ≥ 15 | 8-månadersfönstret | marknaden faller mätbart |
| 24 | färska rader < 15 | de 15 senaste, oavsett ålder | hellre gammalt än tre annonser |
| 25 | storleksgrupper spretar > 1,5× | intervallet breddas + varning | Kivik 2-sits 1 250 mot 5-sits 4 900 |
| 26 | n < 30 | shrinkage mot märke+typ | Kinnarps n=3 gav 4 000 kr mot facit 1 300–1 600 |
| 27 | bred mängd < 20 rader | ingen shrinkage | den bredare mängden måste själv ha underlag |
| 28 | n < 10 | `confidence = "low"` | fönstret täcker hela mängden |
| 29 | anonym + bild + spridning > 6,0× | visuell kohort | orden säger kategori, bilden bär värdet |
| 30 | ledord extraherade | **rangordnar**, filtrerar inte | staplade filter tog Vimle 117 → 40 |

---

## 3. Varje konstant med källa

Kolumnen **status** är den viktiga för en granskare.

- **mätt** = härledd ur data med redovisad mätning
- **teoretiskt** = valt av principskäl, inte ur data
- **övertränad** = inställd mot benchmarkmöblerna, alltså mot samma möbler som accuracy rapporteras på
- **ovaliderad** = ingen mätning finns; talet är en gissning som fungerat

### Percentiler och intervall

| konstant | värde | används till | hur den bestämdes | status |
|---|---|---|---|---|
| `HALF_INTERVAL_RATIO` | 0,10 | avstånd till p40 och p60 | bryggmätning (p34) + omlistningsstudie (sänkningar passerar 50 % i decilen p40–50) | **mätt** |
| `LOW_OFFSET_RATIO` | 0,20 | vänsterkanten → p30 | symmetriskt fönster lämnade `low` över p35; Landskrona 1 990 kr vid p38, Madison 4 000 vid p35 | **mätt** |
| `MIN_HALF_INTERVAL` | 5 | golv på högerkanten | specifikation | **teoretiskt** |
| `MIN_LOW_OFFSET` | 10 | golv på vänsterkanten | specifikation | **teoretiskt** |
| `LOW_CONFIDENCE_BELOW` | 10 | markera svaret osäkert | följer av att golvet ±5 täcker hela mängden vid n<10 | **teoretiskt** |

### Filtergolvet och viktning

| konstant | värde | används till | hur den bestämdes | status |
|---|---|---|---|---|
| `MIN_COMPARISON_SET` | 30 | golv för alla filter | samma tal som `MIN_ASKING_PER_MATCH` i percentilstudien; under ~30 observationer domineras en kvantil av enskilda annonser. Vid n=30 vilar p30 och p60 på tre annonser vardera | **teoretiskt** |
| `FILTER_DOWNWEIGHT` | 0,25 | vikt när golvet stoppat ett filter | fyra "fel" annonser väger som en rätt; valt för att filtren själva har felmarginaler och ett hårt nollställande skulle förutsätta att de inte har det | **ovaliderad** |
| `IMAGE_WEIGHT_FLOOR` | 0,25 | nedre vikt för bildlikhet | speglar `FILTER_DOWNWEIGHT` | **ovaliderad** |

### Shrinkage

| konstant | värde | används till | hur den bestämdes | status |
|---|---|---|---|---|
| `FALLBACK_BELOW` | 30 | tröskel för shrinkage | samma som filtergolvet | **teoretiskt** |
| `FALLBACK_SHRINKAGE_K` | 6 | blandningsvikt `n/(n+k)` | svept mot de 11 exempelmöblerna. k=6 är enda värdet som klarar båda felriktningarna: Kinnarps (n=3, förorenad uppåt) hamnar inom facit och Cordelia (n=11, smal mängd RÄTT) dras inte under. Vid k≥8 offras Cordelia, vid k≤4 räddas inte Kinnarps | **övertränad** — koden säger det själv |
| `FALLBACK_MIN_BROAD` | 20 | bred mängd måste ha underlag | — | **ovaliderad** |
| `SHRINKAGE_K` | 10 | skickmultiplikatorernas viktning | — | **ovaliderad** |
| `DIVERGENCE_LIMIT` | 0,40 | halvera w vid stor avvikelse | fyra annonser kan vara två dubbletter och en felmärkning | **teoretiskt** |

### Färskhet

| konstant | värde | används till | hur den bestämdes | status |
|---|---|---|---|---|
| `RECENCY_MONTHS` | 8 | fönstrets längd | mätt prisfall i korpusen (1 167 → 700–750 kr), 92 % från archive som slutar 2025-12 | **ovaliderad** — fallet är mätt, men just 8 månader är inte svept |
| `RECENCY_MIN_LISTINGS` | 15 | golv innan fönstret utökas | — | **ovaliderad** |

### Prisbas

| konstant | värde | används till | hur den bestämdes | status |
|---|---|---|---|---|
| `BASIS_MIN_ASKING` | 30 | asking räcker | = `MIN_COMPARISON_SET` | **teoretiskt** |
| `AUCTION_CORRECTION` | 1,04 / 1,42 / 1,36 | uppräkning av auktionspris | parvis inom (modell × möbeltyp), 99 grupper med ≥10 rader av varje sort, 24 mån. Median 1,36, p25 1,02, p75 1,65, utrop > auktion i 77 % | **mätt** |
| `AUTO_REALIZED_SHARE` | 0,50 | gamla dominansregeln | Wegner 8,80 / Mathsson 3,36 mot Ektorp 0,026 / Kivik 0,011 — entydig separation | **mätt** (regeln används inte längre) |
| `AUTO_MIN_REALIZED` | 10 | absolut golv | — | **teoretiskt** |
| `MIN_PRICE` / `MAX_PRICE` | 1 / 1 000 000 | städning | datan sträcker sig 1–499 000 kr | **teoretiskt** |

### Möbeltyp

| konstant | värde | används till | hur den bestämdes | status |
|---|---|---|---|---|
| `VARIANT_STRICT_MIN` | 15 | strikt typfilter | spannet inom ett modellnamn är 5,5× för Vimle, 5,0× för Kivik och Malm | **ovaliderad** — spannet är mätt, tröskeln inte |
| `ABSTAIN_BELOW` | 0,70 | bildlagret avstår | svept på **kronofelsmåttet** över 3 200 annonser med läckagespärr, aldrig mot benchmarken. 0,55→375 kr, 0,65→346, **0,70→342**, 0,75→353, 0,90→390. Platå, inte spik | **mätt** |
| `prior.MIN_LISTINGS` | 12 | prior kräver underlag | under detta är fördelningen brus | **teoretiskt** |
| `prior.MAX_ENTROPY` | 0,50 | prior tystas vid hög entropi | "0,5 av maxentropi valdes som mittpunkt" — kalibrerad mot kronofelsmåttet | **ovaliderad** |
| `prior.MIN_SHARE` | 0,70 | dominerande värde måste nå detta | — | **ovaliderad** |
| `VISUAL_VARIANT_K` | 40 | antal röstande grannar | — | **ovaliderad** |
| `VISUAL_VARIANT_MIN_SIM` | 0,45 | granne får rösta | mätt på 2 000 vektorer: samma typ 0,52–0,75, slumpmässig median 0,22, fråga utan match toppar 0,21 | **mätt** |
| `VISUAL_VARIANT_MIN_VOTES` | 5 | annars "vet inte" | — | **teoretiskt** |
| `VISUAL_VARIANT_RUNNERUP` | 0,60 | tvåan tas med | en hörnsoffa rakt framifrån ÄR en rak soffa i bild | **teoretiskt** |
| `DOWNGRADE_MIN_CONFIDENCE` | 0,75 | tro på billigare svar | 87 % av bäddsofforna och 71 % av hörnsofforna kallades "soffa" | **mätt** (riktningen), **ovaliderad** (nivån) |
| `UPGRADE_MIN_CONFIDENCE` | 0,50 | tro på dyrare svar | samma asymmetri | **ovaliderad** |
| `DOWNGRADE_MARGIN` | 0,05 | under detta är riktningen brus | — | **teoretiskt** |
| `MIN_VALUE_OF_INFORMATION` | 0,10 | fråga inte om skillnaden är liten | "10 % enligt uppdraget" | **teoretiskt** |
| `NARROW_ENOUGH` | 1,15 | unionen är smal nog | — | **ovaliderad** |
| `MAX_SEATS` | 8 | rimlighetstak | "212-sits" (38 förekomster) är ett artikelnummer | **mätt** |
| `MAX_SET_ITEMS` | 12 | rimlighetstak | — | **teoretiskt** |
| `NEGATION_WINDOW` | 3 | ord runt en negation | — | **ovaliderad** |

### Prisnivåer per typ (`PRICE_LEVEL`)

Används **enbart** för att avgöra riktning (är bytet en nedgradering?), aldrig
för att sätta pris. Parvisa medianer inom modellgrupp, **försonade med minsta
kvadrat i logrummet** eftersom de parvisa kvoterna inte är transitiva:
`hylla/vitrin` = 0,59 ger vitrin 1,70 medan `byra/vitrin` = 0,64 ger 1,95.

| typ | nivå | ankare |
|---|---|---|
| fåtölj | **2,600** | stol = 1,00 — störst i systemet |
| vitrin | 1,814 | hylla = 1,00 |
| skänk | 1,691 | hylla |
| hörnsoffa | 1,205 | soffa = 1,00 |
| byrå | 1,195 | hylla |
| bäddsoffa | 0,823 | soffa |
| skrivbord | 0,760 | matbord = 1,00 |
| **matgrupp** | **0,521** | matbord — se avsnitt 7, omtvistad |
| soffbord | 0,492 | matbord |
| sidobord | 0,338 | matbord |

Största kvarvarande residual: 0,065 i log (~6,7 %) för förvaring, 0,061 för
soffor, 0,036 för bord. Det är måttet på hur väl en enda skala alls beskriver
familjen. **Status: mätt.**

### Skick (allt avstängt i dag)

| konstant | värde | hur den bestämdes | status |
|---|---|---|---|
| `MULTIPLIER_MAX_UNCERTAINTY` | 0,25 | `ln(p75/p25)/√grupper`. Separerar entydigt: budget/slitet 0,06, global/nyskick 0,15, premium/mycket_gott 0,19 mot mellan/slitet 0,29, premium/nyskick 0,43 | **mätt** |
| `MULTIPLIER_HORIZON_MONTHS` | 24 | kvoter åldras långsammare än prisnivån | **teoretiskt** |
| `MULTIPLIER_MIN_PER_LEVEL` | 10 | — | **teoretiskt** |
| `MULTIPLIER_MIN_ROWS` | 5 | — | **teoretiskt** |
| `MULTIPLIER_MIN_GROUPS` | 3 | — | **teoretiskt** |
| `CONDITION_ANCHOR_MIN` | 10 | annars går medianskicket inte att bestämma | **teoretiskt** |
| `CONDITION_STRICT_MIN` | 15 | måste vara klart högre än `MIN_HALF_INTERVAL` (5) | **teoretiskt** |
| `BAND_MAX_FACTOR` | 2,0 | spärr mot gammal felkälla (bandet gav en gång 2,60× för Nyskick) | **teoretiskt** |
| `BAND_LOW_Q` / `BAND_HIGH_Q` | 0,40 / 0,60 | samma andel som huvudalgoritmens fönster | **teoretiskt** |
| `BAND_WIDE_RATIO` | 2,0 | med 0,40/0,60 hamnar alla spridningar på 1,01–1,48 och flaggan hade aldrig löst ut | **mätt** |
| `BAND_SOLID_GROUPS` | 10 | prisnivån "hög" vilar på 7 grupper | **teoretiskt** |
| `DEFAULT_CONDITION_LADDER` | 1,5625 / 1,25 / 1,0 / 0,75 / 0,5625 | "~25 % värdetapp per steg" | **ovaliderad** — ren kallstartsgissning |

### Bild och embeddings

| konstant | värde | hur den bestämdes | status |
|---|---|---|---|
| `EMBED_MODEL` | dinov2-small | DINOv2 framför CLIP: CLIP starkt semantiskt men trubbigt på finkornigt | **teoretiskt** |
| `EMBED_DIM` | 384 | följer modellen | — |
| `DETECT_IMGSZ` | 320 | mätt på denna maskin: 640→154 ms, 320→38 ms, 256→26 ms; träffsäkerhet 44 % vid 320 mot 42 % vid 640 | **mätt** |
| `DETECT_CONF` | 0,25 | — | **ovaliderad** |
| `CROP_MARGIN` | 0,08 | detektorn klipper ben och armstöd, som är just det DINOv2 ska titta på | **ovaliderad** |
| `COLOR_BINS` | 32 | — | **ovaliderad** |
| `COLOR_WEIGHT` | 0,15 | kommentaren säger "justeras mot data i fas 5, inte gissas" — **det har inte gjorts** | **ovaliderad** |
| `IMAGE_SIMILARITY_MIN` | 0,45 | mätt på 2 000 vektorer (se ovan) | **mätt** |
| `IMAGE_MIN_LISTINGS` | 5 | — | **teoretiskt** |
| `IMAGE_LOOSEN_STEPS` | 0,35 / 0,25 / 0,15 | — | **ovaliderad** |
| `IMAGE_TOP_K` | 30 | — | **ovaliderad** |

### Ledord och kohort

| konstant | värde | hur den bestämdes | status |
|---|---|---|---|
| `CUE_CORPUS_SAMPLE` | 60 000 | — | **teoretiskt** |
| `CUE_RANDOM_SEED` | 20260805 | reproducerbarhet | — |
| `CUE_MIN_NEIGHBOURS` | 3 | — | **ovaliderad** |
| `CUE_MIN_LIFT` | 3,0 | — | **ovaliderad** |
| `CUE_MAX_WORDS` | 12 | — | **teoretiskt** |
| `CUE_MIN_LISTINGS` | 15 | — | **teoretiskt** |
| `COHORT_MIN` / `COHORT_MAX` | 15 / 200 | "tak enligt uppdraget" | **teoretiskt** |
| `COHORT_DISPERSION_TRIGGER` | 6,0 | valt så att normal spridning (2–4×) inte löser ut men ekbordsfallet (~20×) gör det | **teoretiskt** |
| `COHORT_DISPERSION_WARN` | 4,0 | — | **ovaliderad** |
| `COHORT_GAP_FACTOR` | 3,0 | utan kravet delar argmax även en jämn fördelning | **teoretiskt** |
| `SIZE_WARN_RATIO` | 1,5 | naturlig variation inom en storlek ska inte lösa ut; Kivik 3,9× ska | **teoretiskt** |

### Vitlistan för modellnamn

| konstant | värde | hur den bestämdes | status |
|---|---|---|---|
| `MIN_TYPE_SHARE` | 0,60 | andel av ordets annonser som delar produkttyp | **ovaliderad** |
| `MIN_FAMILY_SHARE` | 0,75 | Ektorp föll på 0,59 i fin typ men är ett självklart modellnamn — familjen är rätta måttet | **mätt** (behovet), **ovaliderad** (nivån) |
| `MIN_BRAND_SHARE` | 0,80 | ektorp 1,00 / lamino 1,00 / madison 0,94 mot chair 0,38 / rygg 0,31 / stoppad 0,27 | **mätt** |
| `MIN_BRAND_LISTINGS` | 10 | under detta går ordet inte att bedöma på märke | **teoretiskt** |
| `MIN_LISTINGS` | 12 | minsta antal för att bedöma alls | **teoretiskt** |
| `MAX_LISTINGS` | 40 000 | ett ord i tiotusentals annonser är ett vanligt ord | **teoretiskt** |

**Sammanräkning över de 77 konstanter tabellerna ovan listar:**

| status | antal | andel |
|---|---|---|
| **mätt** — härledd ur data med redovisad mätning | 14 | 18 % |
| **teoretiskt** — valt av principskäl | 36 | 47 % |
| **ovaliderad** — ingen mätning finns | 24 | 31 % |
| **övertränad** — inställd mot benchmarkmöblerna | 1 | 1 % |
| följer av annan konstant (`EMBED_DIM`, `CUE_RANDOM_SEED`) | 2 | 3 % |

Två konstanter är dubbelmärkta: behovet är mätt men nivån inte
(`MIN_FAMILY_SHARE`, `DOWNGRADE_MIN_CONFIDENCE`).

Den enskilt mest oroande är **`FALLBACK_SHRINKAGE_K = 6`**, som är inställd mot
samma elva möbler som accuracy rapporteras på. Koden noterar det själv:
*"med en parameter och elva punkter är överanpassningen liten men verklig —
värdet bör verifieras mot nya exempel innan det betraktas som satt."*

För en granskare är de 24 ovaliderade den intressanta listan. **Nio av dem sitter
i det aktiva prisflödet** och kan påverka varje svar:

| konstant | värde | vad ett fel värde gör |
|---|---|---|
| `RECENCY_MONTHS` | 8 | tar 93 % av mängden i det spårade exemplet; för kort ger tunt underlag, för långt ger gamla priser |
| `RECENCY_MIN_LISTINGS` | 15 | styr när fönstret överges helt |
| `VARIANT_STRICT_MIN` | 15 | avgör om typfiltret alls tillämpas |
| `FILTER_DOWNWEIGHT` | 0,25 | hur mycket en misstänkt rad ändå påverkar priset |
| `FALLBACK_MIN_BROAD` | 20 | om shrinkage sker eller inte vid tunt underlag |
| `prior.MAX_ENTROPY` | 0,50 | när modellnamnets typfördelning får fylla i |
| `prior.MIN_SHARE` | 0,70 | samma |
| `UPGRADE_MIN_CONFIDENCE` | 0,50 | om en gissning som gör möbeln dyrare godtas |
| `NEGATION_WINDOW` | 3 | om "utan fotpall" tolkas rätt |

De övriga femton ligger i avstängda vägar (bildomsortering, skickprissättning,
ledord) eller i byggskript som körs offline.

`RECENCY_MONTHS` är den jag skulle granska först: den är det mest beskärande
filtret i hela kedjan, den är aldrig svept, och prisfallet den bygger på är mätt
över en period där 92 % av datan kommer från en källa som slutar 2025-12.

---

## 4. Datalagren

### Korpusen

1 525 135 rader efter städning, från `vips-ml-data/vips-fas0/master.parquet`.

| källa | rader | andel |
|---|---|---|
| `archive` | 973 009 | 63,8 % |
| `auctionet` | 461 564 | 30,3 % |
| `blocket` | 82 731 | 5,4 % |
| `tradera` | 7 831 | 0,5 % |

| prissort | rader | tidsspann | median |
|---|---|---|---|
| `asking` | 1 055 740 | 2024-07-12 → 2026-07-13 | 900 kr |
| `realized` | 469 395 | 2011-12-04 → 2026-07-11 | ~800 kr |

Priser: median 900 kr, p25 400, p75 2 200, max 499 000, medel 2 309
(standardavvikelse 6 408 — starkt högersvansad, vilket är skälet till att all
blandning sker i logrummet).

**Täckningen är kraftigt ojämn per möbeltyp**, och det är den viktigaste
egenskapen hos datan:

| möbel | asking | realized |
|---|---|---|
| IKEA Landskrona | 1 114 | 22 |
| Bruno Mathsson | 2 363 | 8 025 |

Auktionshusen säljer designklassiker, marknadsplatserna säljer IKEA. Varje
statistik som blandar kanalerna mäter sortiment, inte marknad.

### Kolumnerna motorn läser

| kolumn | null-andel | anmärkning |
|---|---|---|
| `name` / `name_norm` / `search_blob` | 0 % | rader utan text tas bort vid inläsning |
| `price` | 0 % | |
| `price_kind` | 0 % | |
| `brand_norm` | **97,7 % tom sträng** | därför matchas märket även i texten |
| `condition_norm` / `condition_tier` | **72,4 % null** | archive 0 %, blocket 99,7 %, tradera 98,3 %, auctionet 71,6 % |
| `listed_at` | 0 % | sammanslagning av `listed_at_ms` (bara asking) och `sold_at` (bara auktion) |
| `image_url` | 18,8 % | |
| `variant` | 0 % | gamla taxonomin |
| `derived_type` | 13,4 % | attributsystemets taxonomi |

Två kolumner är **medvetet uteslutna**: `canonical_text` (trunkerad i datan,
innehåller ofta bara "Okej skick" och förstör namnmatchningen) och `cat_clf`
(kommer från en `.joblib`-modell; motorn ska vara modellfri).

`condition_damaged` är **alltid False** i alla 421 554 märkta rader — kolumnen
bär ingen information och används inte.

### Dubbletthantering

Dedupas på `dedup_key` när den finns, annars på (`name_norm`, `price`,
`condition_norm`). Tradera har 65 % dubblettbilder, vilket är skälet till att
bildcachen delar fil mellan annonser med samma bild.

Kvarvarande dubblettgrupper — rader med identisk normaliserad rubrik — används
som brusgolvsmätning (avsnitt 8): 22 865 grupper med minst 5 rader, 517 703 rader
totalt.

### Cellflaggorna

Beräknas vid inläsning av `type_system/grouping.assign_cells` och cachas med
korpusen (`CACHE_VERSION = 18`).

| flagga | antal | andel |
|---|---|---|
| `is_bundle` | 155 929 | 10,2 % |
| `is_accessory_only` | 59 191 | 3,9 % |
| `is_comparison` | 43 446 | 2,8 % |
| `is_section` | 5 675 | 0,4 % |
| `is_giveaway` | 2 085 | 0,1 % |
| `is_damaged` | 2 642 | 0,2 % |
| `mentions_retail_price` | 11 488 | 0,8 % |
| `cell_excluded` (union av tre) | 101 635 | 6,7 % |

Produkttypens källa: `explicit` 989 861 (64,9 %), `none` 524 637 (34,4 %),
`majoritet` 10 637 (0,7 %). Celltypen är `okand` för 24,2 % av raderna.

**Modellnyckeln är tom för 86,1 % av raderna.** Det är den enskilt största
strukturella svagheten i cellsystemet, och orsaken är att vitlistan är
(märke, ord)-par: `ektorp` räknas som modellnamn först när "IKEA" står i samma
rubrik, och det gör det bara i 15,6 % av annonserna.

### Embeddings

| lager | innehåll | används till |
|---|---|---|
| DINOv2-small | **93 230 vektorer**, 384 dimensioner | grannröstning för möbeltyp (L2), visuell kohort, bildomsortering (avstängd) |
| Färghistogram | 32 bins per HSV-kanal | vägs in med 15 % i likhetspoängen |
| YOLO11n | ingen lagring | beskärning före embedding, imgsz 320 |

**Annonsbilderna sparas aldrig**, bara vektorerna. En embedding är inte en kopia
av bilden, vilket gör upphovsrättsfrågan kring annonsbilder betydligt mindre
obekväm. Nedladdade bilder cachas temporärt och rensas explicit.

Mätt bärighet per möbeltyp (9 779 par, textbaserat facit):

| typ | AUC | kommentar |
|---|---|---|
| soffa | 0,662 | kalibreringen gjordes ursprungligen här |
| hylla | 0,577 | |
| säng | 0,522 | |
| hörnsoffa | **0,513** | trots 99 % YOLO-beskärning |

Korsningen med beskärningen visade att det inte är detektorns fel. **Svagheten
sitter i embeddingen, och ingen tröskel räddar den.** Det är skälet till att
bilden bara får bestämma möbeltyp.

### Vitlistan och stopplistan

`config/model_names.json`: **1 495 (märke, ord)-par** över 20 märken, plus
**1 406 märkeslösa ord**.

`config/vocab.yaml`: 58 produkttyper, 23 märken, 7 familjer, samt signalordlistor
för bunt/tillbehör/jämförelse/lågpris/högpris.

Manuell stopplista, för ord som märkeskoncentrationen inte kan fälla:

| ord | skäl |
|---|---|
| `lux` | adjektiv; 0,98 Mio men beskriver utförande, inte modell |
| `fri` | fraktord; halva frasen "fri leverans" |

### Multiplikator- och percentiltabeller

| tabell | byggd | innehåll | används |
|---|---|---|---|
| `condition_multipliers.json` | 2026-08-04 | per märkesklass × skicknivå, med spridning, gruppantal och osäkerhet | **nej** — skick avstängt |
| `model_type_prior.json` | — | 4,5 MB; modellordets typfördelning | ja, L1 |
| `bridge_study/bridge_percentiles.json` | — | percentil mot exakt motorns fråga; landade p34 | motiverar p40 |
| `percentile_study/sell_percentiles.json` | — | säljsannolikhet per percentil | motiverar p40 |
| `relist_study/relist_thresholds.json` | — | omlistningsbeteende; sänkningar passerar 50 % i decilen p40–50 | motiverar p40 |
| `type_system/price_relevance.json` | — | `PRICE_LEVEL`-tabellen | ja, riktningsbeslut |

---

## 5. Felklasskartan

Underlaget är körningen 2026-08-16 på 35 benchmarkmöbler i läge D (cellfilter på,
med bild). **13 missar av 35.**

### Innan klassificeringen: två mätartefakter som måste redovisas

Granskaren behöver veta detta innan siffrorna tolkas, eftersom de flyttar flera
missar mellan klasser.

**Artefakt 1: söknyckeln kapas av harnessen.** Benchmarkharnessen simulerar "en
användare skriver modellnamnet" genom att stryka typord ur modellfältet. Det
producerar söknycklar som ingen användare skulle skriva:

| spec | söknyckel som skickades | följd |
|---|---|---|
| `soffa med puff` (Bolia) | **`med puff`** | 15 träffar, mest fotpallar |
| `säng 303` (DUX) | **`303`** | 0 träffar |
| `Söderhamn bäddsoffa` | `Söderhamn` | rimligt |

**Artefakt 2: märkeslösa specposter tappar sina ord.** Fyra poster i benchmark 1
och 2 har varken märke eller modell i specstrukturen, bara en kategori. Deras
beskrivande ord når aldrig motorn:

| spec-etikett | vad motorn faktiskt sökte |
|---|---|
| Ekbord med stolar | `matbord` |
| Matbord trä | `matbord` |
| Matgrupp byCrea | `matgrupp` |
| Matgrupp 5 stolar | `matgrupp` |

"Ekbord med stolar" och "Matbord trä" fick alltså **identisk** förfrågan och
identiskt svar, trots att facit skiljer sig (2 000–5 000 mot 3 000–7 000). En
riktig användare hade skrivit "ekbord" och "trä", och de orden bär värdet.

### Klassificeringen

| # | möbel | facit | default | avv | rotorsak | klass |
|---|---|---|---|---|---|---|
| 11#6 | IKEA Strandmon | 1 000–2 000 | 900 | −10 % | 42 färska annonser, marknaden ligger under facit | **a) marknadsbrus** |
| 11#9 | Mio Santos | 700–1 000 | 1 315 | +32 % | buntrensningen höjde medianen; matgrupperna är billigare än bordet | **e) facit ifrågasatt** |
| 11#12 | IKEA PINNTORP matgrupp | 1 500–2 500 | 500 | −67 % | två buntar finns i hela korpusen, median 350 kr | **e) + b)** |
| b1#1 | Mio Town | 7 000–12 000 | 5 874 | −16 % | 23 annonser; U-soffor och raka soffor blandas | **c) förorenad** |
| b1#4 | IKEA karlstrand | 500–2 000 | — | — | 0 träffar; modellnamnet finns inte i korpusen | **b) tunt underlag** |
| b1#8 | Kartell Victoria Ghost | 1 000–2 000 | 552 | −45 % | auktionsposter med 2–6 stolar räknas som en stol | **c) förorenad** |
| b1#10 | Ekbord med stolar | 2 000–5 000 | 800 | −60 % | sökte bara `matbord`; "ek" och "stolar" tappades | **f) mätartefakt** |
| b2#2 | Bolia soffa med puff | 8 000–11 000 | 2 599 | −68 % | sökte `med puff` | **f) mätartefakt** |
| b2#5 | Jysk Allese | 4 000–6 500 | 3 420 | −14 % | 12 annonser | **b) tunt underlag** |
| b2#9 | Matbord trä | 3 000–7 000 | 880 | −71 % | sökte bara `matbord`; "trä" tappades | **f) mätartefakt** |
| b2#10 | Mio matgrupp | 3 000–5 000 | 2 500 | −17 % | 108 annonser; matgruppsrabatten | **e) facit ifrågasatt** |
| b2#11 | Matgrupp byCrea | 5 000–15 000 | 1 250 | −75 % | sökte bara `matgrupp`; "byCrea" tappades | **f) mätartefakt** |
| b2#12 | DUX säng 303 | 50 000–80 000 | — | — | sökte `303`; DUX-sängar saknas i korpusen | **b) + f)** |

### Sammanräkning

| klass | antal | typiskt felutslag | vad som krävs för att eliminera |
|---|---|---|---|
| **f) mätartefakt** | **5** | −60 till −75 % | Rätta harnessen: skicka hela etiketten som söknyckel för märkeslösa poster, och sluta stryka typord som är enda innehållet. **Kostar ingen motorändring.** |
| **e) facit ifrågasatt** | 3 | −67 till +32 % | Avgör matgruppsrabatten. Tre oberoende observationer säger 0,3–0,52× bordet; facit säger dyrare. Annonsgranskning. |
| **b) tunt underlag** | 3 | −14 % eller inget svar | Mer data. Stavningstolerans skulle rädda `karlstrand`. |
| **c) förorenad mängd** | 2 | −16 till −45 % | Detektera **antal** i auktionsposter ("Stolar, 6 st" = 6 enheter, inte en). Ingen sådan logik finns. |
| **a) marknadsbrus** | 1 | −10 % | Inget. Motorn träffar marknaden, facit ligger annorlunda. |
| **d) fel typ** | **0** | — | — |

### Rangordning: vilken klass kostar mest accuracy?

1. **f) mätartefakt — 5 möbler, 14,3 procentenheter.** Kostar inget att åtgärda
   och är inte ett motorfel. Att den är störst betyder att **den rapporterade
   siffran 62,9 % underskattar motorn**, inte att motorn är sämre än den ser ut.
2. **e) facit ifrågasatt — 3 möbler, 8,6 procentenheter.** Kan inte åtgärdas med
   kod; kräver ett beslut om vem som har rätt.
3. **b) tunt underlag — 3 möbler, 8,6 procentenheter.** Kräver data, inte logik.
4. **c) förorenad mängd — 2 möbler, 5,7 procentenheter.** Enda klassen som pekar
   på en verklig, byggbar motorförbättring: antalsdetektering i flerpostannonser.
5. **a) marknadsbrus — 1 möbel, 2,9 procentenheter.** Irreducibel.

**Att klass d) är tom är ett resultat.** Typsystemet — den mest utarbetade delen
av systemet — orsakar inte en enda miss i den här körningen.

---

## 6. Katastrofanalysen

**Definition:** default mer än ±50 % från närmaste facitkant.

Måttet är viktigare än accuracy. Ett förslag som är katastrofalt fel skadar
förtroendet mer än tio små missar, och det är detta tal som ska mot ~100 %.

| läge | katastrofer | andel |
|---|---|---|
| A (filter av, utan bild) | 6 / 35 | 82,9 % rena |
| B (filter av, med bild) | 6 / 35 | 82,9 % rena |
| **C (filter på, utan bild)** | **4 / 35** | **88,6 % rena** |
| D (filter på, med bild) | 5 / 35 | 85,7 % rena |

Cellfiltret tar bort två katastrofer i läge C. Bilden lägger tillbaka en.

### Varje katastrof, med rotorsak

| möbel | facit | A | C | D | rotorsak |
|---|---|---|---|---|---|
| 11#12 IKEA PINNTORP matgrupp | 1 500–2 500 | −67 % | −67 % | −67 % | två buntar i hela korpusen, median 350 kr. **Facit omtvistat** |
| b2#2 Bolia soffa med puff | 8 000–11 000 | −68 % | −68 % | −68 % | sökte `med puff`. **Mätartefakt** |
| b2#9 Matbord trä | 3 000–7 000 | −70 % | −67 % | −71 % | sökte `matbord`. **Mätartefakt** |
| b2#11 Matgrupp byCrea | 5 000–15 000 | −80 % | −60 % | −75 % | sökte `matgrupp`. **Mätartefakt** |
| b1#10 Ekbord med stolar | 2 000–5 000 | −55 % | *(räddad)* | −60 % | sökte `matbord`. **Mätartefakt** |
| b2#10 Mio matgrupp | 3 000–5 000 | −51 % | *(räddad)* | *(räddad)* | matgruppsrabatten. **Facit omtvistat** |

### Tre observationer

**Alla katastrofer är negativa.** Motorn har aldrig i någon körning föreslagit
ett pris mer än 50 % **över** facit. Systemet felar systematiskt lågt när det
felar stort, och det är den mindre farliga riktningen för en säljare — men det är
en systematisk skevhet, inte slump.

**Fyra av sex är mätartefakter.** Med rättad harness skulle katastroftalet
sannolikt vara 2 av 35, alltså 94 % rena. Det är en hypotes, inte en mätning —
den kräver en omkörning.

**Alla sex tillhör bord/matgrupp-familjen eller den anonyma klassen.** Ingen
soffa, fåtölj, säng eller förvaringsmöbel med känt modellnamn har någonsin
katastroffelat. Riskzonen är väl avgränsad.

---

## 7. Kända svagheter och obyggt

### Vet vi är svagt

**Anonyma low-end-förfrågningar.** "Matgrupp 5 stolar", "Ekbord med stolar",
"Matbord trä" — inget märke, inget modellnamn. Klassens träffsäkerhet är 25 % i
läge C/D och var 0 % före cellfiltret. Motorn har inget att söka på och faller
tillbaka på kategorimedianer, som blandar 50-kronors brun ek med
travertinbord för 44 000 kr.

**Modellnyckeln är tom för 86,1 % av korpusen.** Par-vitlistan kräver
märkesordet i samma rubrik. Detta är den identifierade nästa åtgärden och är
ännu inte mätt.

**Matgruppstvisten.** Tre oberoende observationer säger att matgrupper
annonseras **billigare** än det lösa bordet:

| observation | kvot |
|---|---|
| `measure_price_relevance` (parvis inom modellgrupp) | 0,521× |
| Mio Santos (buntar 225–917 kr mot bordet 1 038 kr) | ~0,6× |
| PINNTORP (buntmedian 350 kr mot bord 850–1 000 kr) | ~0,35× |

Benchmarkfacit säger motsatsen (PINNTORP-matgrupp 1 500–2 500 mot bordet
300–800). Antingen är korpusens matgruppsannonser systematiskt något annat än
riktiga matgrupper — kanske ofullständiga set eller feltaggade lösa bord — eller
är facit fel. **Detta är den enskilt viktigaste öppna frågan i systemet**, och
den blockerar hela bord/matgrupp-familjen.

**Flerpostannonser räknas som en enhet.** "Stolar, 6 st, Victoria Ghost, 2 667 kr"
läses som en stol för 2 667 kr, inte sex för 445 vardera. `is_bundle` fångar
flera *olika* möbler men inte *flera av samma*. Det orsakade b1#8 (−45 %).

**Ingen stavningstolerans i sökningen.** `karlstrand` ger noll träffar.

**Dataluckor per märke.** DUX-sängar i 50 000–80 000-klassen finns i praktiken
inte i korpusen (0 träffar). Bolia har 14 träffar totalt för soffor. Auktionsdatan
täcker designklassiker; marknadsplatsdatan täcker IKEA. Mellansegmentet är
tunnast.

**Bilden bär inte per möbeltyp.** AUC 0,513 för hörnsoffa, 0,522 för säng. Bilden
kan skilja soffa från fåtölj men inte hörnsoffa från rak soffa — vilket är just
den skillnad som betyder 20,5 % i pris.

**Färskhetsfiltret tar 93 % av mängden** i det spårade exemplet (1 332 → 90). Det
är rätt riktning men aggressivt, och 8 månader är aldrig svept.

### Byggt men avstängt

| funktion | flagga | varför avstängd |
|---|---|---|
| Skickprissättning | `CONDITION_PRICING=False` | avstängd på begäran tills skickmodellen görs om; multiplikatortabellen är byggd och mätt |
| Bildomsortering av jämförelsemängden | `IMAGE_RERANK_ENABLED=False` | beslutat 2026-08-06: DINOv2 kan inte identifiera modeller (AUC 0,513 för hörnsoffa) |
| Ledordsfiltrering | `CUE_FILTER_ENABLED=False` | samma beslut; extraktionen exponeras som information men filtrerar inte |
| Celler som jämförelsemängd | `PRICE_CELLS_ENABLED=False` | **underkänd i mätning**: sänkte 55,9 % → 26,5 % |
| L3 vision-LLM | `use_vision=False`, hårdkodat | byggt och mätt, aldrig anropat från motorn |

Samtliga är kvar med tester så att beslutet går att ompröva när förutsättningen
ändras — främst om embeddingen byts.

### Designat men obyggt

**L4-användarfrågan i gränssnittet.** Kedjan räknar ut vilken enda fråga som
smalnar av intervallet mest (`clarifyingQuestions`, `typeUncertaintyAction`) och
exponerar den i svaret. Ingen konsument använder den. Detta är den billigaste
oanvända tillgången i systemet: en fråga ersätter oftast ett dubbelt så brett
intervall.

**Snapshot-analysen.** Designad i `SNAPSHOT_DESIGN.md`, inte byggd.

**SigLIP-attributmärkning av korpusen.** Skulle ge attribut på annonser där
titeln inte säger något — vilket är 34,4 % av korpusen.

**ArcFace-träning för modellidentitet.** Den enda vägen som skulle kunna lösa
"samma modell, olika utförande" som DINOv2 inte klarar.

**Antalsdetektering i flerpostannonser.** Krävs för klass c).

**Stavningstolerans (redigeringsavstånd ≤ 2) i modellnamnsmatchningen.**

### Mätningar som väntar på data

- **Färska benchmarkmöbler.** Alla 35 nuvarande har använts under utvecklingen.
  Varje siffra i det här dokumentet är en övre gräns.
- **Annonsgranskningen av matgrupper.** Avgör tvisten ovan.
- **Verifiering av `FALLBACK_SHRINKAGE_K = 6`** mot möbler den inte är inställd på.
- **Par-kravets uppluckring.** Nästa planerade mätning.

---

## 8. Teoretiskt tak

**Reviderat 2026-08-17 efter extern granskning.** Den tidigare versionen av det
här avsnittet var för bekväm: brusgolvet mättes på grupper med "identisk
normaliserad rubrik", men rubriken "Matbord" är identisk mellan tusen OLIKA bord.
Sådana grupper blåser upp spridningen med produktvariation som inte är brus, och
ett för högt sigma ger ett för lågt tak — alltså en för snäll slutsats om hur
nära taket motorn ligger.

### Brusgolvet, två populationer

| population | grupper | rader | σ (log) | p75/p25 |
|---|---|---|---|---|
| alla identiska rubriker | 22 865 | 517 703 | 0,812 | 2,99× |
| **varav med validerat modellnamn** | **7 082** | **119 588** | **0,638** | **2,37×** |

Den andra raden är den ärliga: grupper vars rubrik innehåller ett ord ur den
märkeskoncentrationsvaliderade vitlistan, alltså där "samma produkt" faktiskt
gäller. σ faller 21 %, och taket stiger i motsvarande grad.

En enskild annons ligger inom sin egen grupps p30–p60 i 37,0 % av fallen.

### Räkningen

```
SE = 1,2533 · σ / √n                       medianens standardfel i logrummet
P  = 2Φ(halva facitbredden i log / SE) − 1
```

Med benchmarkens faktiska facitbredder (median 2,00×) och faktiska n (median 15):

| σ-modell | alla 35 | de 32 med underlag |
|---|---|---|
| 0,812 — alla identiska rubriker | 68,1 % | 74,5 % |
| **0,638 — validerat modellnamn** | **74,2 %** | **81,2 %** |
| per möbels EGEN jämförelsemängd | 45,6 % | 49,8 % |

**Nuvarande utfall (läge D, harness v6): 60,0 %.**

### Den tredje modellen är falsifierad — och det är ett resultat

Att räkna taket ur varje möbels egen jämförelsemängd verkade rimligare än ett
globalt σ. Utfallet var 49,8 %, alltså **under** motorns uppmätta 60,0 %. Ett tak
under uppmätt prestation är inget tak; modellen är fel, inte motorn.

Felet är instruktivt. Spridningen i en jämförelsemängd — härledd ur motorns egna
p30 och p60 — mäter **produktheterogenitet**, inte skattningsfel. "Alla
Bolia-soffor" är en bred mängd, men medianen av den kan ändå vara en bra
skattning av vad en Bolia-soffa kostar. Att dividera heterogeniteten med √n och
kalla det osäkerhet överskattar felet kraftigt.

Talet är därför inte ett tak utan ett **heterogenitetsmått**, och som sådant
användbart: det pekar ut vilka jämförelsemängder som är breda. Bolia (σ_egen ger
9,8 %), Stalands happy (14,8 %) och Matgrupp 5 stolar (15,6 %) är de mest
heterogena, och de är också missar.

### Gällande tak: 74,2 %

Med den validerade σ ligger motorn på **60,0 / 74,2 = 81 % av taket**, och de
åtkomliga procentenheterna är **14**, inte 10 som den tidigare versionen sa.
Granskningen hade rätt: den bekväma versionen underskattade utrymmet.

### Per möbel: var taket är lågt

| möbel | n | facitbredd | tak (σ=0,812) |
|---|---|---|---|
| IKEA karlstrand | 0 | 4,00× | **0 %** |
| Matgrupp byCrea | 0 | 3,00× | **0 %** |
| DUX säng 303 | 0 | 1,60× | **0 %** |
| Kinnarps Capella X | 3 | 1,23× | 14 % |
| Sofacompany Clara | 2 | 1,43× | 20 % |
| Matgrupp 5 stolar | 3 | 1,67× | 34 % |
| Stalands happy | 2 | 2,00× | 37 % |
| … | | | |
| Jysk fåtölj | 79 | 2,86× | 100 % |
| IKEA Ektorp | 90 | 2,25× | 100 % |

Tre möbler har tak 0 % — ingen metod kan svara utan data. Att `Matgrupp byCrea`
hamnade där är nytt: med rättad harness söker den på hela etiketten, och
"byCrea" finns inte i korpusen, så sökningen ger noll träffar där den tidigare
gav 30 generiska matgrupper och ett felaktigt svar.

### Två kvarstående förbehåll

**Taket antar att facits mitt ÄR marknadens mitt.** Där det inte håller —
matgruppsfallen, och hela måttkonflikten mellan utrop och betalt (se
`GRANSKNING_ATGARDER.md` del 4) — är det verkliga taket lägre.

**Taket mäter samplingsfel, inte urvalsfel.** Ett n på 503 ger tak 100 % bara om
de 503 annonserna är samma produkt. Urvalsfelet är där systemets faktiska arbete
ligger, och det syns inte i formeln.

## De fem ändringar jag tror höjer accuracy mest

**Förslag, inte beslut.** Ingen av dem är mätt.

### 1. Rätta benchmarkharnessen — och räkna om allt

**Förväntad effekt:** +10 till +14 procentenheter på rapporterad accuracy, och
katastroftalet från 5/35 till kanske 2/35. **Ingen motorändring.**

Två fixar: skicka hela etiketten som söknyckel för märkeslösa specposter, och
sluta stryka typord när de är enda innehållet i modellfältet (`soffa med puff` →
`med puff` är inte en söknyckel någon skulle skriva).

**Risk: låg, men den är verklig.** Detta höjer siffran utan att förbättra
produkten, och det finns en frestelse i det. Det ska göras därför att den
nuvarande mätningen är felaktig, inte därför att den är låg. Om det görs måste
det redovisas som en mäträttelse, aldrig som en förbättring.

### 2. Avgör matgruppstvisten genom annonsgranskning

**Förväntad effekt:** +0 till +8,6 procentenheter, eller ett facitbyte. Berör 3
missar direkt och hela bord/matgrupp-familjen indirekt.

Granska 50 matgruppsannonser manuellt. Frågan är enkel: när en annons säger
"matgrupp med 4 stolar" och priset är 350 kr — är det en riktig matgrupp?

**Risk: låg.** Ren mätning. Utfallet kan gå åt båda hållen och kan visa att
`PRICE_LEVEL["matgrupp"] = 0,521` är fel, vilket i sin tur påverkar
riktningsbeslut i typsystemet.

### 3. Antalsdetektering i flerpostannonser

**Förväntad effekt:** +5,7 procentenheter (2 missar), och den enda av de fem som
är en verklig motorförbättring.

"Stolar, 6 st, Victoria Ghost, 2 667 kr" ska bli 445 kr per stol. Mönstret är
regelbundet i auktionsdatan ("N st", "1 par", "N delar"). Dela priset med antalet
när frågan gäller en enhet.

**Risk: medel.** Fel styckdelning gör priset katastrofalt lågt, alltså i den
riktning systemet redan lutar. Kräver konservativ regel: dela bara vid explicit
antal och entydig enhet, aldrig vid gissning.

### 4. Lossa par-kravet i modellnamnsvitlistan

**Förväntad effekt:** okänd, potentiellt stor — den berör 86,1 % av korpusens
rader. Men effekten på *priset* är obevisad, eftersom textsökningen redan hittar
`ektorp` utan vitlistan; det som förbättras är cellfiltrets typmotsägelsedel.

Ord med märkeskoncentration ≥ 0,80 hör per mätning till ett märke. Att kräva att
märkesordet dessutom står i rubriken kastar bort merparten av datan.

**Risk: medel.** Detta är den ändring som redan en gång gått åt fel håll
(cellerna som ersättare, −29 procentenheter). Måste mätas isolerat.

### 5. Koppla in L4-frågan i gränssnittet

**Förväntad effekt:** okänd på benchmarken — den mäter en motor utan användare —
men den är den enda ändringen som angriper `possibleTypes`-unionen vid roten.

Kedjan räknar redan ut vilken fråga som smalnar av mest. I det spårade
Ektorp-exemplet är unionen tre soffvarianter enbart därför att `convertible` och
`corner` är okända. En fråga hade gjort filtret exakt.

**Risk: låg tekniskt, hög produktmässigt.** En fråga per prissättning kostar
användarens tålamod, och `MIN_VALUE_OF_INFORMATION = 0,10` som styr när frågan är
värd att ställa är teoretiskt satt och aldrig validerad mot verkliga användare.

### Vad jag INTE föreslår

**Att röra percentilen.** p40 vilar på två oberoende mätningar och är svept per
produkt utan att något bättre hittades.

**Att slå på skickprissättningen.** Den är avstängd av ett medvetet beslut och
maskineriet väntar på en omgjord skickmodell.

**Att byta embedding för att rädda bildvägen.** AUC 0,513 för hörnsoffa är så
nära slumpen att en bättre modell krävs, inte en bättre tröskel — och det är ett
forskningsprojekt, inte en ändring.

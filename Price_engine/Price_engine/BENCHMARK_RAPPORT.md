# Benchmarkrapport — priscellerna inkopplade och avlästa

Körd 2026-08-16 på **34 möbler** i fyra lägen, fixerat frö `20260816`.
Resultat-CSV per läge i `bench4/`, sammanslagen i `bench4/alla_lagen.csv`.

| läge | celler | bild |
|---|---|---|
| A | av | av |
| B | av | på |
| C | på | av |
| D | på | på |

## Kort svar

**Produktionens default ska förbli läge A — celler av.** Inkopplingen är gjord,
testad och fungerar som specificerad, men avläsningen säger att cellerna som de
används i dag **halverar träffsäkerheten**: 56 % → 26 % default inom facit. Tolv
möbler gick från träff till miss, två åt andra hållet.

Orsaken är inte att grupperingen är fel — den mätningen står fast, intervallen
inom cellerna blev 13 procentenheter smalare. Orsaken är att cellen **ersätter**
textsökningen i stället för att **filtrera** den, och därmed kastar bort
modellnamnet som söksignal. Nästa åtgärd följer av det och står sist.

## Huvudtabell

Överlapp står aldrig ensamt — ett tillräckligt brett intervall träffar varje
facit utan att ha sagt något. Bredden är `(high − low) / default`.

| benchmark | läge | **default inom facit** | överlapp | intervallbredd | utan svar |
|---|---|---|---|---|---|
| De 11 första | A | **72,7 %** (8/11) | 100,0 % | 90 % | 0 |
| De 11 första | B | **72,7 %** (8/11) | 100,0 % | 90 % | 0 |
| De 11 första | C | **36,4 %** (4/11) | 81,8 % | 120 % | 0 |
| De 11 första | D | **36,4 %** (4/11) | 81,8 % | 120 % | 0 |
| Benchmark 1 | A | **40,0 %** (4/10) | 90,0 % | 131 % | 1 (no_data) |
| Benchmark 1 | B | **40,0 %** (4/10) | 90,0 % | 127 % | 1 (no_data) |
| Benchmark 1 | C | **20,0 %** (2/10) | 100,0 % | 166 % | 0 |
| Benchmark 1 | D | **30,0 %** (3/10) | 100,0 % | 161 % | 0 |
| Benchmark 2 | A | **53,8 %** (7/13) | 76,9 % | 97 % | 1 (no_data) |
| Benchmark 2 | B | **53,8 %** (7/13) | 69,2 % | 97 % | 1 (no_data) |
| Benchmark 2 | C | **23,1 %** (3/13) | 76,9 % | 113 % | 0 |
| Benchmark 2 | D | **30,8 %** (4/13) | 69,2 % | 136 % | 0 |

### Alla 34 tillsammans

| läge | **default inom facit** | överlapp | intervallbredd | utan svar |
|---|---|---|---|---|
| **A** | **55,9 %** (19/34) | 88,2 % | 122 % | 2 |
| B | 55,9 % (19/34) | 85,3 % | 119 % | 2 |
| C | 26,5 % (9/34) | 85,3 % | 120 % | 0 |
| D | 32,4 % (11/34) | 82,4 % | 128 % | 0 |

Lägg märke till att **C och D har högre överlapp men lägre träff**. Det är
precis den fälla som gör överlapp ensamt oanvändbart: cellerna gav bredare
intervall (120–166 % mot 90–131 %), och breda intervall överlappar mer. De två
möbler som saknade svar i läge A fick svar i läge C — men till fel pris.

## Bildens effekt

`A → B` ändrade priset för 9 av 34 möbler, `C → D` för 10 av 34, och
totalsiffran rörde sig inte alls i det gamla systemet (55,9 % → 55,9 %). I det
nya systemet lyfte bilden 26,5 % → 32,4 %, men från en så mycket lägre nivå att
det inte är ett argument för läge D.

Det bekräftar det tidigare mätta: **bilden ser form, inte funktion.** Den skiljer
soffa från fåtölj — vilket textsökningen redan klarar när modellnamnet finns —
men inte bäddsoffa från soffa, och inte en Söderhamn från en Norsborg.

## Brusgolvet

Mätt på **22 865 dubblettgrupper** (517 703 annonser med identisk normaliserad
rubrik). Inom en sådan grupp är produkten densamma per konstruktion, så all
kvarvarande prisspridning är marknadens eget brus, inte motorns fel.

- **spridning p75–p25: 69,4 % av medianen**
- en enskild annons ligger inom sin egen grupps p30–p60 i bara **37,0 %** av fallen

Två säljare med identisk möbel och identisk rubrik sätter alltså priser som
skiljer sig med runt 70 %. **56 % ska läsas mot det golvet, inte mot 100 %.** Ett
facit på 400–900 kr är ett 2,25-faldigt spann; att träffa innanför det är inte
gratis när marknaden själv sprider sig så brett.

## Per felklass

| felklass | fall | A | B | C | D |
|---|---|---|---|---|---|
| tunt (under 20 träffar) | 15 | 66,7 % | 66,7 % | 38,5 % | 46,2 % |
| övrigt | 11 | 63,6 % | 63,6 % | 7,7 % | 15,4 % |
| storlek | 4 | 50,0 % | 50,0 % | 50,0 % | 50,0 % |
| anonym (inget märke/modell) | 4 | 0,0 % | 0,0 % | 25,0 % | 25,0 % |

Två saker syns här som totalen döljer.

**`anonym` är den enda klass där cellerna hjälper** — 0 % → 25 %. Det är väntat:
när användaren bara skriver "matgrupp 5 stolar" finns inget modellnamn att söka
på, och då är en kategoricell bättre än fritext. "Matgrupp 5 stolar" gick från
1 000 kr till 2 200 kr mot facit 1 500–2 500.

**`övrigt` kollapsar, 63,6 % → 7,7 %.** Det är möblerna med ett tydligt
modellnamn — Söderhamn, Cordelia, Capella, Lamino — alltså precis de fall där
textsökningen är stark och cellen kastar bort signalen.

## Varför cellerna sänkte siffran

Uppdelat på om modellordet fanns i vitlistan:

| | n | A | B | C | D |
|---|---|---|---|---|---|
| modellordet i vitlistan | 15 | 66,7 % | 66,7 % | 46,7 % | 53,3 % |
| modellordet saknas | 19 | 47,4 % | 47,4 % | **10,5 %** | 15,8 % |

**Kärnfelet: 85,7 % av korpusens rader har tom modellnyckel.** Par-vitlistan
kräver att märkesordet står i SAMMA rubrik som modellordet, och det gör det bara
i 15,6 % av annonserna. `ektorp` är ett modellnamn först när "IKEA" står bredvid
— av 5 666 Ektorp-annonser hamnar 705 i `ikea|soffa|ektorp` och 1 615 i
uppsamlingscellen `|soffa|` med 49 019 rader.

När modellnyckeln är tom degenererar cellen till märke × typ, och då blir
jämförelsemängden **bredare** än textsökningen den ersatte:

| möbel | facit | A | C | cellnyckel i läge C |
|---|---|---|---|---|
| IKEA Söderhamn bäddsoffa | 2 000–2 500 | 2 500 ✓ | 1 500 ✗ | `ikea\|baddsoffa\|\|3` — alla IKEA-bäddsoffor |
| Mio Cordelia | 1 500–3 000 | 2 850 ✓ | 1 000 ✗ | `mio\|fatolj\|\|` — alla Mio-fåtöljer |
| Kinnarps Capella X | 1 300–1 600 | 1 480 ✓ | 400 ✗ | `\|kontorsstol\|\|` — alla kontorsstolar |
| Stalands happy | 3 000–6 000 | 3 658 ✓ | 450 ✗ | `\|okand\|\|` |
| Sofacompany Clara | 7 000–10 000 | 7 500 ✓ | 2 000 ✗ | `\|bunt:okand_bastyp\|\|` |

Kinnarps, Sofacompany, Sweef och Stalands finns inte i den explicita
20-märkeslistan, så deras märkesdel blir tom och modellorden `capella`, `clara`,
`valen` klarar aldrig märkeskoncentrationen. Möbeln faller till en cell som
betyder "kontorsstolar i allmänhet".

Cellerna gjorde alltså **inte** det de skulle. Madison-mätningen står fast —
inom en cell är spridningen mindre — men den mätningen svarade på frågan "är
cellen renare än den gamla nyckeln", inte "är cellen en bättre jämförelsemängd
än en textsökning på modellnamnet". Det andra är den fråga som avgör priset, och
svaret är nej så länge nyckeln saknar modellordet.

## Per möbel

Läge A är produktionsförslaget, läge D visas bredvid med sin cellnyckel.
Avvikelsen är avståndet till närmaste facitkant.

| # | möbel | facit | A: low–default–high | n | typkälla | A | D: low–default–high | n | cellnyckel (D) | D |
|---|---|---|---|---|---|---|---|---|---|---|
| 11#1 | IKEA Ektorp | 400–900 | 600–**1,000**–1,500 | 109 | type_system:text+uni | +11 % | 307–**731**–2,346 | 15 | `ikea|okand|ektorp|2` | ✓ |
| 11#2 | IKEA Söderhamn bäddsoffa | 2,000–2,500 | 100–**2,500**–4,200 | 50 | type_system:text | ✓ | 900–**1,500**–4,000 | 15 | `ikea|baddsoffa||3` | -25 % |
| 11#3 | IKEA Vimle | 1,500–3,000 | 2,000–**2,500**–4,000 | 92 | type_system:text+uni | ✓ | 213–**2,836**–4,894 | 15 | `ikea|okand|vimle` | ✓ |
| 11#4 | Mio Cordelia | 1,500–3,000 | 1,300–**2,850**–9,000 | 11 | type_system:text | ✓ | 800–**1,000**–2,000 | 76 | `mio|fatolj||` | -33 % |
| 11#5 | IKEA Jennylund | 200–700 | 150–**250**–600 | 15 | type_system:text | ✓ | 150–**400**–600 | 15 | `ikea|fatolj|jennylund|` | ✓ |
| 11#6 | IKEA Strandmon | 1,000–2,000 | 750–**900**–1,200 | 59 | type_system:text | -10 % | 300–**900**–1,200 | 24 | `ikea|fatolj|strandmon|` | -10 % |
| 11#7 | Sofacompany Clara Rak bädd | 7,000–10,000 | 6,000–**7,500**–9,000 | 2 | type_system:text | ✓ | 1,400–**2,000**–3,000 | 55 | `|bunt:okand_bastyp||` | -71 % |
| 11#8 | Sweef Valen 224 Rak soffa | 7,000–12,000 | 5,695–**8,601**–12,052 | 15 | type_system:text+uni | ✓ | 3,048–**9,207**–15,946 | 15 | `|soffa|valen|` | ✓ |
| 11#9 | Mio Santos | 700–1,000 | 209–**1,000**–2,657 | 23 | type_system:text+uni | ✓ | 1,000–**1,200**–1,800 | 172 | `mio|matbord` | +20 % |
| 11#10 | IKEA PINNTORP | 600–800 | 124–**500**–910 | 15 | type_system:text | -17 % | 124–**500**–910 | 15 | `ikea|bunt:matbord|pinntorp` | -17 % |
| 11#11 | Kinnarps Capella X / Capel | 1,300–1,600 | 1,000–**1,480**–2,240 | 3 | type_system:text+uni | ✓ | 300–**400**–700 | 511 | `|kontorsstol||` | -69 % |
| b1#1 | Mio Town | 7,000–12,000 | 950–**5,269**–8,609 | 26 | unresolved | -25 % | 3,281–**5,495**–8,521 | 15 | `mio|soffa|town|` | -22 % |
| b1#2 | Mio Saturday | 3,000–6,000 | 3,349–**5,742**–9,289 | 15 | unresolved | ✓ | 3,738–**5,382**–7,383 | 15 | `mio|soffa|saturday|` | ✓ |
| b1#3 | Mio Bridge | 3,500–7,000 | 884–**3,752**–5,260 | 21 | unresolved | ✓ | 993–**3,485**–4,852 | 15 | `mio|soffa|bridge|` | -0 % |
| b1#4 | IKEA karlstrand | 500–2,000 | — | 0 | unresolved | — | 1,200–**1,500**–2,000 | 72 | `ikea|okand||` | ✓ |
| b1#5 | Bellus soffa | 2,000–6,000 | 1,000–**4,000**–10,000 | 24 | type_system:text+uni | ✓ | 1,290–**1,850**–5,199 | 1,865 | `|soffa||` | -8 % |
| b1#6 | IKEA stocksund | 800–2,000 | 500–**750**–1,250 | 32 | type_system:prior+un | -6 % | 36–**642**–2,543 | 15 | `ikea|soffa|stocksund|` | -20 % |
| b1#7 | Stalands happy | 3,000–6,000 | 1,157–**3,658**–5,931 | 2 | unresolved | ✓ | 1,000–**1,500**–9,500 | 1,407 | `|okand||` | -50 % |
| b1#8 | Kartell Victoria Ghost | 1,000–2,000 | 456–**811**–1,483 | 15 | unresolved | -19 % | 538–**959**–2,618 | 26 | `kartell|stol` | -4 % |
| b1#9 | Matgrupp 5 stolar | 1,500–2,500 | 500–**1,000**–2,000 | 1,092 | type_system:text | -33 % | 1,800–**2,200**–3,900 | 404 | `|matgrupp||` | ✓ |
| b1#10 | Ekbord med stolar | 2,000–5,000 | 300–**900**–6,000 | 4,116 | type_system:text+uni | -55 % | 150–**800**–2,200 | 18 | `|matbord||` | -60 % |
| b2#1 | ikea norsborg | 500–1,000 | 411–**898**–4,279 | 15 | type_system:prior+un | ✓ | 411–**1,407**–2,000 | 15 | `ikea|soffa|norsborg` | +41 % |
| b2#2 | Bolia soffa med puff | 8,000–11,000 | 872–**2,599**–29,513 | 15 | type_system:text+uni | -68 % | 605–**2,599**–12,489 | 15 | `bolia|bunt:okand_bastyp||` | -68 % |
| b2#3 | Mio Harper soffa | 4,000–6,500 | 4,900–**6,500**–11,000 | 36 | type_system:text+uni | ✓ | 516–**5,495**–7,960 | 15 | `mio|soffa|harper|` | ✓ |
| b2#4 | Jysk Egedal | 1,000–2,000 | 684–**1,061**–1,736 | 15 | unresolved | ✓ | 1,000–**2,000**–3,000 | 40 | `jysk|soffa` | ✓ |
| b2#5 | Jysk Allese | 4,000–6,500 | 2,274–**3,420**–4,966 | 12 | unresolved | -14 % | 400–**500**–900 | 230 | `jysk|okand` | -88 % |
| b2#6 | Jysk fåtölj | 350–1,000 | 500–**700**–1,000 | 95 | type_system:text | ✓ | 200–**300**–1,300 | 16 | `jysk|fatolj||` | -14 % |
| b2#7 | Swedese Lamino | 8,500–12,000 | 4,000–**8,500**–11,500 | 36 | unresolved | ✓ | 6,000–**10,000**–14,000 | 15 | `swedese|okand|lamino|` | ✓ |
| b2#8 | DUX Bruno Mathsson Eva | 3,500–6,500 | 3,061–**5,638**–7,744 | 15 | unresolved | ✓ | 4,828–**6,820**–9,230 | 21 | `dux|fatolj|bruno eva mathsson|` | +5 % |
| b2#9 | Matbord trä | 3,000–7,000 | 300–**900**–6,000 | 4,116 | type_system:text+uni | -70 % | 330–**880**–2,000 | 26 | `|matbord||` | -71 % |
| b2#10 | Mio matgrupp | 3,000–5,000 | 583–**1,475**–2,500 | 210 | type_system:text | -51 % | 2,000–**2,500**–3,000 | 52 | `mio|matgrupp||` | -17 % |
| b2#11 | Matgrupp byCrea | 5,000–15,000 | 500–**1,000**–2,000 | 1,092 | type_system:text | -80 % | 158–**1,250**–2,500 | 30 | `|matgrupp||` | -75 % |
| b2#12 | DUX säng 303 | 50,000–80,000 | — | 0 | type_system:text | — | 80–**1,000**–10,000 | 15 | `dux|sang||` | -98 % |
| b2#13 | Ikea skotterud | 1,000–2,500 | 1,500–**1,900**–2,500 | 40 | type_system:prior | ✓ | 300–**1,830**–4,000 | 15 | `ikea|sang|skotterud|` | ✓ |

## Ärlighetsnoter

**PINNTORP är INTE uppdelad i den spec som kördes.** Specen extraherades ur
`List of furniture specs - EXACT.pdf`, som har PINNTORP som **en** post:
`Model: PINNTORP, Variant: Bord och 4 stolar, Category: Matgrupp,
facit 600–800 kr`. Den uppdelning i bord respektive matgrupp du beskriver finns
inte i PDF:en — skicka den uppdaterade facit-versionen så körs benchmarken om på
den. Fram till dess gäller siffran ovan för den odelade posten.

**Siffran är en övre gräns, inte en förväntan.** Alla 34 möbler har använts under
utvecklingen. De har styrt lexikon, trösklar och vitlisteregler. En ny möbel kan
inte förväntas ge 56 %. Denna körning mäter framsteg mot sig själv, inte sanning.

**Ingenting justerades utifrån utfallet.** Ingen tröskel, ingen percentil, ingen
vitlisteregel rördes under eller efter körningen.

**Ett fel rättades mitt i, före de redovisade siffrorna.** Den första
inkopplingen byggde cellnyckeln ur `name`, som anroparen medvetet kapar —
"Söderhamn bäddsoffa" skickas som `name="Söderhamn"` med typordet i
`attribute_text`. Nyckeln blev då `ikea|okand|` och slog upp en uppsamlingscell
på 1 489 rader. Det gav läge C 45,5 % på de 11 av fel skäl. Rättningen — läs
hela texten, som alla andra attribut gör — har ett regressionstest, och
resultaten i den här rapporten är körda efter den. Den buggiga körningen ligger
kvar i `bench4_buggig/` för granskning.

**Två möbler saknade svar i läge A och B** (`no_data`): benchmark 1 #9 och
benchmark 2 #11, båda anonyma matgrupper utan märke eller modellnamn.

## Fingeravtryck

| körning | spec_fingerprint | celler |
|---|---|---|
| `11_AB` / `11_CD` | `734340bd9ee1` | av / på |
| `b1_AB` / `b1_CD` | `51933082fdf2` | av / på |
| `b2_AB` / `b2_CD` | `28f56614f44a` | av / på |

## Rekommendation

**1. Produktionens default: läge A.** `PRICE_CELLS_ENABLED=0`. Flaggan är
inkopplad, testad och kan slås på när nästa punkt är åtgärdad, men den ska inte
vara på i dag.

**2. Nästa felklass att attackera: `övrigt` — modellnamn som inte når fram.**
Det är den största klassen som cellerna förstörde (63,6 % → 7,7 %) och den där
mest värde ligger. Konkret förslag, i den ordning de bör mätas:

- **Låt cellen filtrera textsökningen i stället för att ersätta den.** Behåll
  `find_listings` träffmängd och ta bort de rader vars cell är utesluten
  (tillbehör, jämförelse, sektion) eller vars celltyp skiljer sig från frågans.
  Då behålls modellnamnets precision och Madison-föroreningen försvinner ändå.
  Det är den enda ändringen som adresserar båda mätningarna samtidigt.
- **Lossa på par-kravet för ord som redan bevisat sitt märke.** Ett ord med
  märkeskoncentration ≥ 0,80 hör per mätning till ETT märke; att kräva att
  märkesordet dessutom står i rubriken kastar 85,7 % av raderna. Din
  "stand"-invändning gäller ord som inte klarar koncentrationen — de förkastas
  ändå. Detta bör mätas isolerat innan det införs.
- **Utöka märkeslistan.** Kinnarps, Sofacompany, Sweef, Stalands, Bellus och
  byCrea förekommer i benchmarken men saknas i de 20. Det är en ren
  täckningsfråga.

**3. Rör inte percentilen.** `p40` mättes redan som optimal och den här körningen
ger ingen anledning att ompröva det.

# Cellfiltret — rensning på textsökningen

Körd 2026-08-16 på **35 möbler** (34 + PINNTORP delad i två fall), fyra lägen,
fixerat frö `20260816`. Resultat i `bench5/`, sammanslaget i
`bench5/alla_lagen.csv`.

| läge | cellfilter | bild |
|---|---|---|
| A | av | av |
| B | av | på |
| C | på | av |
| D | på | på |

## Rekommendation: ja, `CELL_FILTER_ENABLED` på i produktion

Det här är den första ändringen som **både** höjer träffsäkerheten och smalnar
intervallen. Cellerna som ersättare sänkte 55,9 % → 26,5 %; samma cellflaggor
som rensning ger 57,1 % → **62,9 %**.

| läge | **default inom facit** | överlapp | intervallbredd | utan svar |
|---|---|---|---|---|
| A | 57,1 % (20/35) | 85,7 % | 126,6 % | 2 |
| B | 57,1 % (20/35) | 82,9 % | 122,3 % | 2 |
| C | 60,0 % (21/35) | 85,7 % | **111,1 %** | 2 |
| **D** | **62,9 % (22/35)** | 82,9 % | 114,4 % | 2 |

Skillnaden mot förra körningen är att sökningen är orörd. Filtret tar bara bort
rader ur det textsökningen hittade — det kan aldrig ta in en rad som sökningen
inte hittat, och det testas explicit (`test_search_itself_is_untouched`).

Reservationen: vinsten är **3 möbler upp, 2 ner** av 35. Det är en riktig
förbättring men inte en stor, och den ligger inom vad fem möbler kan flytta.
Att intervallen samtidigt blev 15 procentenheter smalare är det starkare
argumentet — smalare intervall vid bibehållen träff är entydigt bättre.

## Vad rensningen tog bort

Över de 28 möbler där något rensades: **155 908 rader → 92 350** (40,8 % bort).

| orsak | rader |
|---|---|
| bunt | 48 947 |
| tillbehör | 9 244 |
| typmotsägelse (kastad) | 2 793 |
| jämförelseannons | 1 985 |
| lös sektion | 589 |
| typmotsägelse (nedviktad, golvet höll) | 37 |

Filtergolvet utlöstes i praktiken — 37 rader viktades ned i stället för att
kastas, för Mio Santos och PINNTORP där mängden var för tunn. Skräpflaggade
rader kastades alltid, utan golvprövning: en klädsel är aldrig rätt jämförelse
för en soffa, inte ens när det är det enda som finns.

Stickprov på vad som försvann (fullständigt i `type_system/cell_filter_diff.csv`):

```
b1#9 Matgrupp 5 stolar    17 386 -> 7 664   bunt 5 677  tillbehör 3 713  jämförelse 274
   dyrast  230 000  bunt  Mio matgrupp med vitrinskåp
   dyrast   65 000  bunt  komplett heminredning soffa säng matgrupp
   dyrast   67 000  tillb FÖR KNOLL INTERNATIONAL, MATGRUPP, "TULIP" 6 DELAR
b1#1 Mio Town               224 -> 201     bunt 18  tillbehör 1  sektion 4
   dyrast   14 000  bunt  MIO TOWN 3-sits med divan & fotpall
   billigast   200  tillb Kuddar till MIO soffa Town
```

Det som lämnade mängden var genuint skräp: hela hemmiljöer under ordet
"matgrupp", kuddar under ordet "Town", soffdelar under ett soffnamn. Ingen av de
28 diffarna visade en rad som borde ha fått stanna.

## Bildens effekt

`A → B` ändrade ingenting i totalen (57,1 % → 57,1 %). `C → D` lyfte
60,0 % → 62,9 %. Bilden gör alltså mer nytta på en **renad** jämförelsemängd än
på en förorenad, vilket är rimligt: bildlikhet mot en mängd som innehåller
kuddar och hela hemmiljöer mäter inte möbeln.

Men effekten är fortfarande en enda möbel, och bilden kostar ett DINOv2-anrop
per fråga. Den motiverar inte sig själv på dessa siffror.

## Brusgolvet

Oförändrat mätt: **22 865 dubblettgrupper**, 517 703 annonser med identisk
normaliserad rubrik. Spridning p75–p25 = **69,4 % av medianen**; en enskild
annons ligger inom sin egen grupps p30–p60 i **37,0 %** av fallen.

62,9 % ska läsas mot det golvet. Två säljare med identisk möbel och identisk
rubrik skiljer sig med runt 70 % i pris — den delen av felet är marknadens, inte
motorns.

## Per felklass

| felklass | fall | A | B | C | D |
|---|---|---|---|---|---|
| tunt (under 20 träffar) | 16 | 68,8 % | 68,8 % | 66,7 % | 66,7 % |
| övrigt | 11 | 63,6 % | 63,6 % | 55,6 % | 66,7 % |
| storlek | 4 | 50,0 % | 50,0 % | **75,0 %** | **75,0 %** |
| anonym (inget märke/modell) | 4 | 0,0 % | 0,0 % | **25,0 %** | **25,0 %** |

`storlek` och `anonym` är de två klasser filtret var tänkt att hjälpa, och båda
går upp. `anonym` är matgruppsklassen — "matgrupp 5 stolar" gick från 1 000 kr
till 2 000 kr mot facit 1 500–2 500, och den möbeln allena är hela vinsten i den
klassen.

**`tunt` går ned marginellt, 68,8 % → 66,7 %.** Det är filtrets pris: det tar
bort rader, och en mängd som redan var tunn blir tunnare. En möbel bytte tecken.

## Per benchmark

| benchmark | läge | **default inom facit** | överlapp | intervallbredd | utan svar |
|---|---|---|---|---|---|
| De 12 (11 + PINNTORP-delning) | A | 75,0 % (9/12) | 91,7 % | 123,6 % | 0 |
| De 12 | B | 75,0 % (9/12) | 91,7 % | 123,6 % | 0 |
| De 12 | C | 75,0 % (9/12) | 91,7 % | **91,9 %** | 0 |
| De 12 | D | 75,0 % (9/12) | 91,7 % | **91,9 %** | 0 |
| Benchmark 1 | A | 40,0 % (4/10) | 90,0 % | 130,5 % | 1 |
| Benchmark 1 | B | 40,0 % (4/10) | 90,0 % | 126,6 % | 1 |
| Benchmark 1 | C | **60,0 % (6/10)** | 90,0 % | 130,5 % | 1 |
| Benchmark 1 | D | **60,0 % (6/10)** | 90,0 % | 130,5 % | 1 |
| Benchmark 2 | A | 53,8 % (7/13) | 76,9 % | 96,5 % | 1 |
| Benchmark 2 | B | 53,8 % (7/13) | 69,2 % | 96,5 % | 1 |
| Benchmark 2 | C | 46,2 % (6/13) | 76,9 % | 98,4 % | 1 |
| Benchmark 2 | D | 53,8 % (7/13) | 69,2 % | 148,2 % | 1 |

De 12 är det renaste resultatet: **samma nio träffar, men intervallbredden faller
från 123,6 % till 91,9 %** — 32 procentenheter smalare utan att en enda träff
gick förlorad. Det är precis det förväntade utfallet för namngivna möbler:
sökningen är oförändrad, mängden renare, spridningen mindre.

Benchmark 1 är den stora vinsten (40 % → 60 %), och den kommer från
matgruppsfallen där buntar dominerade träffmängden.

Benchmark 2 tappar en möbel i läge C (Swedese Lamino, se nedan) och tar tillbaka
den i läge D. Bredden i D är dock 148 % mot 96,5 % i A — där gör bilden mängden
smalare på ett sätt som breddar intervallet, vilket är en varning värd att följa
men inte en regression i huvudmåttet.

## Per-möbel-diff mot läge A

**20 av 35 möbler ändrade pris. Tre förbättrades, två försämrades, femton
ändrade pris utan att byta träffstatus.**

| | möbel | facit | A | C | n |
|---|---|---|---|---|---|
| ✅ | IKEA Ektorp | 400–900 | 1 000 ✗ | **900 ✓** | 109 → 90 |
| ✅ | IKEA stocksund | 800–2 000 | 750 ✗ | **948 ✓** | 32 → 27 |
| ✅ | Matgrupp 5 stolar | 1 500–2 500 | 1 000 ✗ | **2 000 ✓** | 1 092 → 503 |
| ❌ | Mio Santos | 700–1 000 | 1 000 ✓ | 1 315 ✗ | 23 → 18 |
| ❌ | Swedese Lamino | 8 500–12 000 | 8 500 ✓ | 7 644 ✗ | 36 → 24 |

### Varför de två föll — diffen svarar

**Mio Santos** (facit satt för bordet ensamt). Filtret kastade 10 buntar och
medianen **steg** från 1 038 till 1 200 kr. Det är motsatt vad man väntar av att
ta bort buntar — tills man ser vad de kostade:

```
   bunt   225 kr  Mio Santos runt matbord med 4 stolar
   bunt   625 kr  Santos matbord och 4 stolar från Mio
   bunt   667 kr  Santos Matbord med 6 Tracy stolar (MIO)
   bunt   875 kr  Mio Santos Matbord med 4 st matstolar
   bunt   917 kr  Matgrupp med 6 stolar Santos
```

Matgrupperna annonseras **billigare än bordet ensamt**. Att rensa bort dem lyfte
alltså medianen ovanför facit. Filtret gjorde rätt — buntarna är inte ett bord —
men resultatet blev en miss. Detta är samma fenomen som den uppmätta
matgruppsrabatten på ~0,52×, nu observerad i ett tredje oberoende fall.

**Swedese Lamino.** Filtret kastade 756 buntar och medianen **föll** från 6 000
till 4 800 kr, default 7 644 mot facit 8 500–12 000. De kastade buntarna var
fåtölj + fotpall-par i 20 000–26 000 kr, alltså det som höll upp den övre delen.
En ensam Lamino-fåtölj i den här korpusen ligger under facit. Om facit gäller en
fåtölj ensam är motorns 7 644 kr närmare datan än 8 500; om facit implicit räknar
med fotpallen är det facit som ska ses över. Jag har inte ändrat något åt något
håll.

## Per möbel (alla 35)

Läge A och läge D bredvid varandra. Avvikelsen är avståndet till närmaste
facitkant.

| # | möbel | facit | A: low–default–high | n | A | D: low–default–high | n | typkälla (D) | D |
|---|---|---|---|---|---|---|---|---|---|
| 11#1 | IKEA Ektorp | 400–900 | 600–**1,000**–1,500 | 109 | +11 % | 500–**900**–1,500 | 90 | type_system:text+uni | ✓ |
| 11#2 | IKEA Söderhamn bäddsoffa | 2,000–2,500 | 100–**2,500**–4,200 | 50 | ✓ | 1,500–**2,495**–3,500 | 57 | type_system:text | ✓ |
| 11#3 | IKEA Vimle | 1,500–3,000 | 2,000–**2,500**–4,000 | 92 | ✓ | 1,500–**2,500**–4,000 | 75 | type_system:text+uni | ✓ |
| 11#4 | Mio Cordelia | 1,500–3,000 | 1,300–**2,850**–9,000 | 11 | ✓ | 1,300–**1,900**–2,890 | 5 | type_system:text | ✓ |
| 11#5 | IKEA Jennylund | 200–700 | 150–**250**–600 | 15 | ✓ | 150–**250**–600 | 15 | type_system:text | ✓ |
| 11#6 | IKEA Strandmon | 1,000–2,000 | 750–**900**–1,200 | 59 | -10 % | 600–**900**–1,000 | 42 | type_system:text | -10 % |
| 11#7 | Sofacompany Clara Rak bädd | 7,000–10,000 | 6,000–**7,500**–9,000 | 2 | ✓ | 6,000–**7,500**–9,000 | 2 | type_system:text | ✓ |
| 11#8 | Sweef Valen 224 Rak soffa | 7,000–12,000 | 5,695–**8,601**–12,052 | 15 | ✓ | 5,695–**7,977**–12,052 | 15 | type_system:text+uni | ✓ |
| 11#9 | Mio Santos | 700–1,000 | 209–**1,000**–2,657 | 23 | ✓ | 224–**1,315**–3,627 | 18 | type_system:text+uni | +32 % |
| 11#10 | IKEA PINNTORP | 300–800 | 131–**500**–935 | 15 | ✓ | 131–**570**–970 | 15 | type_system:text+uni | ✓ |
| 11#11 | Kinnarps Capella X / Capel | 1,300–1,600 | 1,000–**1,480**–2,240 | 3 | ✓ | 1,000–**1,480**–2,240 | 3 | type_system:text+uni | ✓ |
| 11#12 | IKEA PINNTORP | 1,500–2,500 | 124–**500**–910 | 15 | -67 % | 124–**500**–910 | 15 | type_system:text | -67 % |
| b1#1 | Mio Town | 7,000–12,000 | 950–**5,269**–8,609 | 26 | -25 % | 666–**5,874**–9,143 | 23 | type_system:image+un | -16 % |
| b1#2 | Mio Saturday | 3,000–6,000 | 3,349–**5,742**–9,289 | 15 | ✓ | 2,983–**5,325**–7,383 | 15 | type_system:image+un | ✓ |
| b1#3 | Mio Bridge | 3,500–7,000 | 884–**3,752**–5,260 | 21 | ✓ | 892–**3,743**–5,251 | 20 | type_system:image+un | ✓ |
| b1#4 | IKEA karlstrand | 500–2,000 | — | 0 | — | — | 0 | type_system:image+un | — |
| b1#5 | Bellus soffa | 2,000–6,000 | 1,000–**4,000**–10,000 | 24 | ✓ | 600–**4,000**–10,000 | 15 | type_system:text+uni | ✓ |
| b1#6 | IKEA stocksund | 800–2,000 | 500–**750**–1,250 | 32 | -6 % | 510–**948**–1,581 | 27 | type_system:image+un | ✓ |
| b1#7 | Stalands happy | 3,000–6,000 | 1,157–**3,658**–5,931 | 2 | ✓ | 1,157–**3,658**–5,931 | 2 | type_system:image+un | ✓ |
| b1#8 | Kartell Victoria Ghost | 1,000–2,000 | 456–**811**–1,483 | 15 | -19 % | 400–**552**–1,385 | 15 | unresolved | -45 % |
| b1#9 | Matgrupp 5 stolar | 1,500–2,500 | 500–**1,000**–2,000 | 1,092 | -33 % | 1,600–**2,000**–3,500 | 503 | type_system:text | ✓ |
| b1#10 | Ekbord med stolar | 2,000–5,000 | 300–**900**–6,000 | 4,116 | -55 % | 150–**800**–2,200 | 18 | type_system:text+uni | -60 % |
| b2#1 | ikea norsborg | 500–1,000 | 411–**898**–4,279 | 15 | ✓ | 411–**898**–3,848 | 15 | type_system:image+un | ✓ |
| b2#2 | Bolia soffa med puff | 8,000–11,000 | 872–**2,599**–29,513 | 15 | -68 % | 872–**2,599**–7,612 | 15 | type_system:text+uni | -68 % |
| b2#3 | Mio Harper soffa | 4,000–6,500 | 4,900–**6,500**–11,000 | 36 | ✓ | 2,000–**5,223**–11,500 | 24 | type_system:text+uni | ✓ |
| b2#4 | Jysk Egedal | 1,000–2,000 | 684–**1,061**–1,736 | 15 | ✓ | 684–**1,061**–1,898 | 15 | unresolved | ✓ |
| b2#5 | Jysk Allese | 4,000–6,500 | 2,274–**3,420**–4,966 | 12 | -14 % | 2,274–**3,420**–4,966 | 12 | type_system:image+un | -14 % |
| b2#6 | Jysk fåtölj | 350–1,000 | 500–**700**–1,000 | 95 | ✓ | 500–**700**–1,000 | 79 | type_system:text | ✓ |
| b2#7 | Swedese Lamino | 8,500–12,000 | 4,000–**8,500**–11,500 | 36 | ✓ | 1,000–**8,750**–20,000 | 24 | type_system:image+un | ✓ |
| b2#8 | DUX Bruno Mathsson Eva | 3,500–6,500 | 3,061–**5,638**–7,744 | 15 | ✓ | 2,750–**5,500**–6,500 | 15 | type_system:image+un | ✓ |
| b2#9 | Matbord trä | 3,000–7,000 | 300–**900**–6,000 | 4,116 | -70 % | 330–**880**–2,000 | 26 | type_system:text+uni | -71 % |
| b2#10 | Mio matgrupp | 3,000–5,000 | 583–**1,475**–2,500 | 210 | -51 % | 2,000–**2,500**–3,100 | 108 | type_system:text | -17 % |
| b2#11 | Matgrupp byCrea | 5,000–15,000 | 500–**1,000**–2,000 | 1,092 | -80 % | 158–**1,250**–2,500 | 30 | type_system:text | -75 % |
| b2#12 | DUX säng 303 | 50,000–80,000 | — | 0 | — | — | 0 | type_system:text | — |
| b2#13 | Ikea skotterud | 1,000–2,500 | 1,500–**1,900**–2,500 | 40 | ✓ | 700–**1,900**–2,500 | 43 | type_system:image | ✓ |

## PINNTORP: facit uppdaterat, och matgruppsfallet är omtvistat

Specen har nu två fall i stället för ett. Ändringen ligger i
`extract_benchmark_specs.py` som `FACIT_OVERRIDES`, så den är reproducerbar och
`spec_fingerprint` rör sig när facit rör sig.

| fall | variant | facit | läge A | läge D |
|---|---|---|---|---|
| 11#10 PINNTORP bord | Matbord | 300–800 kr | 500 ✓ | 570 ✓ |
| 11#12 PINNTORP matgrupp | Bord + 4 stolar | 1 500–2 500 kr `disputed` | 500 ✗ | 500 ✗ |

I läge A gav motorn **exakt samma 500 kr** för båda fallen — den skilde inte alls
på bord och matgrupp. Filtret separerar dem (bordet 570 kr efter att två buntar
rensats, matgruppen behåller sina buntar eftersom frågan är en bunt), men
matgruppsfallet missar ändå.

**Ärlighetsnot om `disputed`.** Ditt matgruppsfacit på 1 500–2 500 kr står i
spänning med den uppmätta matgruppsrabatten. Korpusen innehåller **två**
PINNTORP-buntar, till 200 och 500 kr, median 350 kr — medan lösa PINNTORP-bord
ligger på 850–1 000 kr i toppen:

```
  1 000 kr  Klaffbord Ikea "Pinntorp"              (bord)
    950 kr  Pinntorp, klaffbord IKEA               (bord)
    850 kr  IKEA Pinntorp matbord                  (bord)
    500 kr  Bjursta och pinntorp, matbord och stolar  (bunt)
    200 kr  Matbord och stolar från IKEA PINNTORP-serien (bunt)
```

Datan säger alltså att en PINNTORP-matgrupp går för ungefär en tredjedel av
bordet ensamt — konsistent med 0,52×-mätningen och med Santos-fallet ovan, och
inkonsistent med 1 500–2 500. Två rader är dock ett för tunt underlag för att
avgöra frågan. Annonsgranskningen i kön får göra det. Tills dess gäller ditt
facit, och missen på 11#12 ska inte överdramatiseras — den ingår i siffran
62,9 % och drar ned den med 2,9 procentenheter.

Utan det omtvistade fallet är läge D 22/34 = **64,7 %**.

## Ärlighetsnoter

**Siffran är en övre gräns.** Alla 35 möbler har använts under utvecklingen och
har styrt lexikon, trösklar och ordlistor. En ny möbel kan inte förväntas ge
63 %. Körningen mäter framsteg mot sig själv.

**Ingenting justerades mot utfallet.** Ingen tröskel, ingen percentil, ingen
ordlista rördes under eller efter körningen. `FILTER_DOWNWEIGHT` och
`MIN_COMPARISON_SET` är oförändrade.

**Vinsten är liten i absoluta tal.** Tre möbler upp, två ner. Det starkaste
argumentet för filtret är intervallbredden (126,6 % → 111,1 %, och 123,6 % →
91,9 % på de 12), inte träffsäkerheten.

**Två möbler saknar svar i alla fyra lägen** (`no_data`): b1#4 IKEA karlstrand
och b2#12 DUX säng 303. Ingen av dem är ett filterfel — de saknade svar även med
filtret av. "Karlstrand" finns inte som modellnamn i korpusen (troligen felstavat
eller mycket ovanligt), och DUX-sängar är den kända dataluckan: korpusen har
nästan inga annonser i det prisläget. Det är felklassen `dataluckor` och den
åtgärdas med data, inte med kod.

**`PRICE_CELLS_ENABLED` förblir av.** Den underkända vägen är kvar i koden bakom
sin egen flagga med sina egna tester, men ska inte slås på.

## Fingeravtryck

| spec | fingerprint | ändring |
|---|---|---|
| `items_11.json` | `c866a1f204cf` | **ändrat** från `734340bd9ee1` — PINNTORP delad i två fall |
| `items_b1.json` | `51933082fdf2` | oförändrad |
| `items_b2.json` | `28f56614f44a` | oförändrad |

## Tester

388 tester passerar, varav 9 nya för rensningssteget:

- flaggan av ger exakt textsökningens träffmängd
- skräprader (klädsel, bunt, jämförelse) kastas
- filtret kan bara ta bort rader, aldrig lägga till
- okänd typ är INTE en motsägelse
- typmotsägelse kastas när golvet håller
- typmotsägelse blir nedviktning under golvet
- skräprader kastas även under golvet
- en buntfråga behåller buntarna
- nedviktningen når fram till priset

## Nästa steg

Enligt din ordning, separat och isolerat mätt: **lossa par-kravet** så att ord
med märkeskoncentration ≥ 0,80 får agera modellord även utan märkesord i
rubriken. Det adresserar de 85,7 % tomma modellnycklarna. Egen körning, egen
rapport — blandas inte med dessa siffror.

Två saker som den här körningen lade på bordet utan att jag agerat på dem:

1. **Matgruppsrabatten har nu tre oberoende observationer** (0,52×-mätningen,
   Mio Santos, PINNTORP). Den bör avgöras innan matgruppsfacit används som mått.
2. **Bilden breddar intervallet i benchmark 2** (96,5 % → 148,2 % i läge D). Värt
   en egen titt om bilden ska stanna på.

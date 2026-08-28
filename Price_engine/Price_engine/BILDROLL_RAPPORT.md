# Bilden får EN uppgift — bestämma möbeltyp

Mätdatum 2026-08-07. Motorn i det skick den har efter Del 1, städjobbet och Del 3.
Alla siffror kommer ur `evaluate_examples.py` och `measure_variant_classifier.py`
mot `master.parquet` (1 525 135 annonser) och vektorlagret (93 230 bilder).

---

## Kort svar först

Bilden kan inte identifiera en möbelmodell — det mättes förra veckan och står fast.
Frågan här var om den kan göra något smalare: avgöra **vilken sorts möbel** det är.

Svaret är ja, men med ett viktigt förbehåll: klassificeraren är bra på de typer som
ser olika ut och dålig på precis de par som kostar mest i pris. Den bör därför
köras med en avstå-tröskel, inte som ett obetingat svar.

Tre tal bär hela rapporten:

* **54,5 %** — bildens träffsäkerhet på möbeltyp när den svarar. Den avstår i dag
  i 0,6 % av fallen, alltså i praktiken aldrig.
* **87,0 %** — andelen bäddsoffor som bilden kallar "soffa". Felen pekar
  systematiskt mot den generiska, billigare typen.
* **87,2 %** — träffsäkerheten om soffa/hörnsoffa/bäddsoffa slås ihop till en
  familj, mot 32,2 % när de hålls isär. Bilden ser form, inte funktion.

---

## Del 1 — bildfiltreringen bort

`IMAGE_RERANK_ENABLED = False` och `CUE_FILTER_ENABLED = False` i
[config.py](price_engine/config.py). Båda är flaggor, inte raderad kod, så
jämförelseläget kan fortfarande köras.

**Resultatet är negativt.** Jämförelsen nedan är tagen ur *samma* körning
(`eval_slut_*`), där jämförelseläget slår på båda flaggorna igen — så skillnaden
är enbart filtreringen, inte något annat som hunnit ändras:

| benchmark | överlapp med → utan | default inom med → utan |
|---|---|---|
| 11 första | 100 % → 100 % | 81,8 % → 81,8 % |
| benchmark 1 | 100 % → 100 % | 60 % → **50 %** |
| benchmark 2 | 61,5 % → 61,5 % | 53,8 % → **46,2 %** |

Två möbler bytte sida, båda i default:

* **Mio Town** (facit 7 000–12 000): 7 000 → 6 000, ut ur facit. Filtreringen
  drog upp både default och tak (11 000 → 9 900).
* **Mio Harper** (facit 4 000–6 500): 6 000 → 7 000, ut ur facit. Här gjorde
  filtreringen dock intervallet absurt brett i botten (200 kr).

Överlappet rörde sig inte alls på någon benchmark.

Det viktiga fyndet ligger i `n`: **antalet jämförelseannonser ändrades inte** för
de flesta möbler när filtren stängdes av. Filtren skar alltså inte bort träffar —
de låg under `MIN_COMPARISON_SET`-golvet och hade automatiskt konverterats till
nedviktning. Det som försvann var en mild omviktning av medianen, inte ett filter.

Att en mild omviktning flyttar två av 34 möbler över facitgränsen är inom bruset
för den här mängden. Jag har **inte** slagit på filtren igen — de är fortfarande
av, enligt uppdraget — men slutsatsen "filtreringen gjorde ingen nytta" håller
inte. Den gjorde en liten nytta, och den nyttan är nu borta.

---

## Städjobbet

**Skärmdumpar.** Detektorn hittade **1 075** skärmdumpar i hela bildlagret, inte 38.
Siffran 38 gällde bara de bilder som råkade ingå i parstudien. Jag kontrollerade
12 slumpade träffar okulärt: samtliga var äkta skärmdumpar från trademax.se,
ikea.se och chilli.se — noll falska positiva. De maskeras vid inläsning via
`.cache/vectors/blocked.json`, bilderna ligger kvar orörda.

**Sänggavlar.** `sänggavel` är nu en egen typ i [variant.py](price_engine/variant.py),
placerad före `säng` i regelordningen så att "Hemnes sänggavel" inte längre
prissätts mot hela sängar. 7 av 7 testfall passerar.

`CACHE_VERSION` höjd till 15.

---

## Del 3 — typen från bilden styr sökningen

Kedjan i `_resolve_variants` ([pricing.py:770](price_engine/pricing.py#L770)):

1. **Explicit `variant`** om anroparen angett en — kan inte gissa fel.
2. **DINOv2-grannröstning** mot de embeddade annonsbilderna. Bara typer som
   faktiskt förekommer bland kandidaterna erbjuds, annars svarar motorn med noll
   träffar.
3. **Textens typ** som fallback när bilden avstår (`variantSource: "text_fallback"`).
4. **Ingendera** → `confidence: "low"` plus en förklarande mening i noten om att
   möbeltypen inte kunde avgöras.

Vid konflikt vinner bilden, men konflikten rapporteras:
`variantSource: "dinov2_conflict:<texttyp>"`. Skälet är att texten ofta är
användarens gissning ("soffa" om något som är en hörnsoffa) medan bilden är
mätbar — men ett tyst övertag vore fel, så texttypen följer med i svaret.

**En bieffekt jag inte blev ombedd att bygga, men byggde:** när det inte finns
någon bild alls används nu ändå textens typ som filter
([pricing.py:809](price_engine/pricing.py#L809)). Tidigare filtrerades textläget
inte alls på typ. Det är försvarbart — skriver användaren "soffa" ska sökningen
handla om soffor — men det ligger utanför uppdraget och det ändrar textlägets
siffror. Jag flaggar det här hellre än att revidera det i efterhand, eftersom en
ändring nu skulle vara en justering mot benchmarkmöblerna.

### Trelägesmätningen

| benchmark | läge | överlapp | default inom | svar |
|---|---|---:|---:|---:|
| 11 första | kärnnamn | 100,0 % | **90,9 %** | 11/11 |
| 11 första | kärnnamn + bild | 100,0 % | 81,8 % | 11/11 |
| 11 första | + gammal filtrering | 100,0 % | 81,8 % | 11/11 |
| benchmark 1 | kärnnamn | 90,0 % | 50,0 % | 10/10 |
| benchmark 1 | kärnnamn + bild | **100,0 %** | 50,0 % | 10/10 |
| benchmark 1 | + gammal filtrering | 100,0 % | **60,0 %** | 10/10 |
| benchmark 2 | kärnnamn | **69,2 %** | **53,8 %** | 11/13 |
| benchmark 2 | kärnnamn + bild | 61,5 % | 46,2 % | 11/13 |
| benchmark 2 | + gammal filtrering | 61,5 % | 53,8 % | 11/13 |

Typkällor i bildläget:

| benchmark | fördelning |
|---|---|
| 11 första | `single_candidate` 6, `dinov2` 4, `unresolved` 1 |
| benchmark 1 | `dinov2` 6, `single_candidate` 2, `text` 1, `text_fallback` 1 |
| benchmark 2 | `dinov2` 6, `single_candidate` 4, `text` 2, `text_fallback` 1 |

**Bilden vinner en benchmark och förlorar två.** Den enda tydliga vinsten är
benchmark 1:s överlapp, 90 % → 100 %, och den kommer från *en* möbel:

* **#10 "Ekbord med stolar"** (facit 2 000–5 000). Textläget ger 100/250/833 —
  helt fel. Bildläget faller tillbaka på texttypen (`text_fallback`), skär
  mängden från 35 till 15 annonser och landar 92/438/3 230, som överlappar.
  Default är fortfarande fel, men intervallet täcker facit.

Förlusterna:

* **#6 IKEA Strandmon** (11 första, facit 1 000–2 000): `dinov2` skär n 83 → 46
  och drar default 1 000 → 800, ut ur facit.
* **#3 Mio Bridge** (benchmark 1, facit 3 500–7 000): default 3 776 → 3 394, ut.
* **#3 Mio Harper** (benchmark 2, facit 4 000–6 500): default 6 000 → 7 000, ut.
* **#9, den anonyma annonsen** (benchmark 2, facit 3 000–7 000): textläget ger
  667/950/6 000 och överlappar. Bildläget använder *samma* texttyp men mängden
  faller från 4 037 till 25 annonser och intervallet krymper till 343/900/1 944 —
  överlappet försvinner. Typvalet är alltså inte boven; det är den visuella
  kohorten (steg F2b), som lever kvar oberoende av `IMAGE_RERANK_ENABLED`.

Det sista fallet är värt att notera: **en del av bildens påverkan går fortfarande
förbi flaggan.** Kohortsteget kräver en frågevektor och aktiveras bara när en bild
skickas med, men det stängs inte av av någon av de två flaggorna i Del 1.

---

## Del 2 — typklassificeraren mätt

`measure_variant_classifier.py --per-variant 300`.
**4 200 annonser, 14 typer, 300 per typ** — balanserat, så slumpnivån är 7,1 %.

**Facit** är textklassificeringens variant. Den är regelbaserad och inte felfri,
men den är oberoende av bilden, och det är den egenskap som krävs.

**Läckagespärren.** Annonsens egen embedding ligger i indexet och är sin egen
närmaste granne med likhet 1,0. Hela dubblettgruppen (samma titel + samma pris)
maskeras också, eftersom tradera har 65 % dubblettbilder och en kopia av samma
foto läcker svaret precis lika bra. Median 1 maskerad rad, som mest 97.

### Huvudsiffran

> **Träffsäkerhet när den svarar: 54,5 %. Avstår: 0,6 %.**

Den svarar alltså i praktiken alltid, och har fel nästan varannan gång.
Bättre än slump (7,1 %), men inte i närheten av att kunna styra ett prisfilter.

### Per typ

| typ | n | avstår | träffsäkerhet | medianandel |
|---|---:|---:|---:|---:|
| stol | 300 | 0 % | **81 %** | 0,75 |
| bord | 300 | 0 % | 78 % | 0,70 |
| fåtölj | 300 | 0 % | 77 % | 0,68 |
| soffa | 300 | 0 % | 75 % | 0,69 |
| hylla | 300 | 1 % | 73 % | 0,71 |
| säng | 300 | 1 % | 68 % | 0,58 |
| matgrupp | 300 | 0 % | 64 % | 0,53 |
| byrå | 300 | 1 % | 64 % | 0,70 |
| sänggavel | 300 | 0 % | 52 % | 0,55 |
| spegel | 300 | 4 % | 43 % | 0,55 |
| fotpall | 300 | 1 % | 39 % | 0,58 |
| matbord | 300 | 1 % | 26 % | 0,53 |
| hörnsoffa | 300 | 0 % | **19 %** | 0,53 |
| bäddsoffa | 300 | 0 % | **3 %** | 0,62 |

### De fyra prisviktiga förväxlingarna — med riktning

> **RÄTTAT 2026-08-07.** Priseffekterna nedan stod först som antaganden om vad
> som är dyrast. Två av dem var fel. `measure_price_relevance.py` har nu mätt
> kvoterna parvis inom modellgrupp, och riktningen kastas om för både bäddsoffa
> och matgrupp. Kolumnen "kvot" är mätt; kolumnen "priseffekt" följer ur den.

| förväxling | andel | mätt kvot | priseffekt |
|---|---:|---:|---|
| bäddsoffa → soffa | **87,0 %** | bäddsoffa = **0,80×** rak soffa | bäddsoffan är **billigare** → prissätts för **högt** |
| hörnsoffa → soffa | **71,3 %** | hörnsoffa = **1,23×** rak soffa | hörnsoffan är dyrare → prissätts för **lågt** |
| matbord → matgrupp | 27,0 % | matgrupp = **0,52×** matbord | matgruppen är **billigare** → prissätts för **lågt** |
| byrå → hylla | 15,3 % | byrå = **1,25×** hylla | hyllan är billigare → prissätts för lågt |
| matgrupp → matbord | 12,7 % | (omvänt ovan) | prissätts för högt |
| hylla → byrå | 3,7 % | (omvänt ovan) | prissätts för högt |
| soffa → hörnsoffa | 3,3 % | (omvänt ovan) | prissätts för högt |
| fåtölj → stol, stol → fåtölj | 13,3 / 7,3 % | ej mätt | okänd riktning |

**Rättelsen i klartext.** Jag skrev att en bäddsoffa är dyrare än en rak soffa
och att en matgrupp är dyrare än ett matbord. Båda är fel i datan:

* **Bäddsoffa 0,80× rak soffa** (20,0 % skillnad, 368 modellgrupper, KI [0,73, 0,84]).
* **Matgrupp 0,52× matbord** (47,9 % skillnad, 959 modellgrupper, KI [0,50, 0,56]).
  Fyndet replikerar i varje enskilt modellord: bjursta 300 mot 500, ingatorp 500
  mot 1 000, mörbylånga 1 591 mot 3 800, ekedalen 625 mot 900. Rimligast är en
  buntrabatt — sju delar till en köpare kräver lägre pris än bordet ensamt.

Felen pekar alltså **inte** entydigt mot underprissättning, som jag först skrev.
De pekar mot den *generiska* typen, och vad det kostar beror på attributet: för
hörnsoffa och byrå underprisas möbeln, för bäddsoffa och matgrupp överprisas den.
Slutsatsen att felprofilen är systematisk står; slutsatsen att den alltid drar
nedåt gör det inte.

Förklaringen är rimlig: en bäddsoffa är en soffa tills någon fäller ut den, och
en hörnsoffas hörn ligger ofta utanför bild. Funktionen syns helt enkelt inte på
fotot. DINOv2 gissar inte fel — den ser korrekt att föremålet är soffformat.

### Kollapsad typ: bilden ser form, inte funktion

Räknas en gissning som rätt när den hamnar inom rätt *familj*:

| familj | exakt (snitt) | inom familj (snitt) |
|---|---:|---:|
| soffa + hörnsoffa + bäddsoffa | 32,2 % | **87,2 %** |
| stol + fåtölj | 79,3 % | 89,6 % |
| byrå + hylla | 67,8 % | 77,4 % |
| matbord + matgrupp | 44,8 % | 64,7 % |

Soffamiljen går från 32 % till 87 %. Det är hela svaret på vad bilden kan:
**den avgör grovtyp tillförlitligt och undertyp inte alls.**

### Avstå-kurvan

| krav på röstandel | täckning | träffsäkerhet |
|---:|---:|---:|
| 0,30 | 96,8 % | 55,5 % |
| 0,40 | 88,2 % | 58,1 % |
| 0,50 | 70,0 % | 63,0 % |
| 0,55 | 59,8 % | 66,2 % |
| 0,60 | 50,5 % | 69,8 % |
| 0,65 | 41,8 % | 73,0 % |
| 0,70 | 34,8 % | 75,9 % |
| **0,75** | **27,4 %** | **80,2 %** |
| 0,80 | 20,5 % | 82,3 % |
| 0,85 | 13,3 % | 87,3 % |
| 0,90 | 7,3 % | 92,2 % |
| 0,95 | 2,8 % | 94,9 % |

Kurvan är obruten och brant: varje procentenhet träffsäkerhet kostar ungefär tre
procentenheter täckning. Det finns ingen knäckpunkt att peka på — valet är en ren
avvägning, och den är din.

### En begränsning som måste stå med

Testmängden består av annonser **där texten gav en typ** — annars finns inget
facit. Men i motorn är bildens uppgift att svara när texten *inte* räcker. Det
fallet går inte att mäta med det här facitet.

Vad mätningen därför säger är: *på de annonser där texten har en åsikt, håller
bilden med i 54,5 % av fallen.* Det är fortfarande det avgörande beskedet, för
Del 3 låter bilden **vinna** över texten vid konflikt — och det beslutet vilar på
att bilden är mer tillförlitlig än texten. Den siffran stödjer inte det.

---

## Processfel att redovisa

Uppdraget sa "en ändring i taget, mätning mellan varje". Det höll jag inte, och
följdverkningarna blev större än jag först trodde.

**Vad som hände.** Jag redigerade `pricing.py` (13:20) medan en benchmark
fortfarande körde. Den processen hade redan importerat den gamla modulen och
skrev sitt resultat sju minuter senare, till `eval_c_b2/`. Resultatet ser ut som
en giltig mätning men speglar ett kodläge som inte längre fanns.

**Följden blev en katalog med motstridiga mätningar.** `eval_c_*`, `eval_f_*` och
`eval_d1_*` visar olika siffror för samma benchmark, och katalognamnen säger
ingenting om vilket kodläge som gällde. `eval_c_b2` och `eval_f_b2` skiljer sig
med 7,7 procentenheter i textläget — ett läge som varken rör bilder eller
vektorer och alltså borde vara bitidentiskt. Skillnaden går att spåra till
`variantSource` (`none` mot `text`), men bara i efterhand.

**Så här löste jag det.** Jag slutade tolka de gamla katalogerna och körde om
allt i ett enda obrutet svep i motorns nuvarande skick, till `eval_slut_*`. Alla
siffror i den här rapporten kommer därifrån. De reproducerar `eval_f_*` exakt,
vilket bekräftar att `eval_f_*` speglade nuvarande kod — men det visste jag inte
förrän omkörningen var klar, och `eval_d1_*` motsäger fortfarande båda.

**Vad som därmed inte gick förlorat:** städjobbet och Del 3 är fortfarande inte
uppmätta var för sig. Trelägesmätningen visar bilden mot texten i nuvarande läge,
inte de två stegens enskilda bidrag. Vill du ha den isärhållningen kör jag om
stegen separat, en i taget.

**Vad jag rekommenderar att vi gör åt processen:** mätkatalogerna bör namnges
efter git-commit eller innehållshash, inte efter vad jag råkade kalla steget.
`--frozen` skriver redan specfilens hash till resultatet; samma sak borde göras
för koden. Då kan en mätning aldrig tyst tillskrivas fel kodläge.

---

## Rekommendation

Rakt, i prioritetsordning. Inget av detta är infört — det kräver ditt beslut.

### 1. Vänd konfliktregeln. Texten ska vinna, inte bilden.

Det här är den viktigaste punkten och den strider mot vad jag byggde i Del 3.

Del 3 låter bilden köra över texten vid konflikt. Motiveringen var att texten är
användarens gissning medan bilden är mätbar. Mätningen säger tvärtom: på annonser
där texten har en åsikt håller bilden med i 54,5 % av fallen, och när den inte
gör det pekar felet nästan alltid mot den generiska, billigare typen.

Skriver användaren "bäddsoffa" och bilden säger "soffa" — då har användaren rätt
i 87 % av fallen. Att låta bilden vinna där är att systematiskt prissätta fel:
hörnsoffor för lågt (0,81× av rätt pris) och bäddsoffor för högt (1,25×).

**Bilden ska tala när texten tiger. Inte annars.**

### 2. Avstå-tröskel: 0,75.

Med reservationen att kurvan är obruten och att varje val är en avvägning, är
0,75 den punkt jag skulle välja: **80,2 % träffsäkerhet vid 27,4 % täckning.**

Skälen:

* Under 0,70 hamnar träffsäkerheten i 60–75 %, och ett typfilter som är fel var
  tredje gång är sämre än inget filter alls — det skär bort rätt annonser och
  behåller fel.
* Över 0,85 svarar den på 13 % av fallen. Då är kostnaden att bygga och underhålla
  bildvägen inte betald av nyttan.
* 0,75 ger ett filter som är rätt fyra gånger av fem, och som avstår tyst i tre
  fall av fyra — där texten tar över. Det är en väg som gör lite nytta ofta och
  sällan skada.

Om du vill ha en försiktigare inställning: 0,80 kostar 7 procentenheter täckning
och ger 2 procentenheter träffsäkerhet. Marginell affär, men defensiv.

### 3. Låt aldrig bilden avgöra soffans undertyp.

Bilden ska få svara "soffa-familj", inte "hörnsoffa". Undertypen avgörs av texten
eller av storleksnivån, som redan finns i [size.py](price_engine/size.py).

Konkret: slå ihop `soffa`, `hörnsoffa` och `bäddsoffa` till en familj i
grannröstningen. Träffsäkerheten på den familjen är 87,2 % mot 32,2 % i dag. Samma
sak för `matbord`/`matgrupp` (64,7 % mot 44,8 %), där skillnaden dessutom är
prisviktig eftersom en matgrupp innehåller stolar.

### 4. Ta ställning till textfiltret utan bild.

Bieffekten jag byggde in ([pricing.py:809](price_engine/pricing.py#L809)) — att
textens typ filtrerar även när ingen bild finns — ligger utanför uppdraget och
har en mätt kostnad, se nedan. Den bör antingen bekräftas som önskad eller tas
bort. Jag rör den inte själv, eftersom ett beslut nu skulle vara en justering mot
benchmarkmöblerna.

### Vad jag inte rekommenderar

Att slå på bildfiltreringen igen. Den gav en liten mätbar nytta (Del 1), men den
nyttan kom från en omviktning under jämförelsegolvet, inte från att bilden
faktiskt kände igen något. Att behålla en mekanism som fungerar av fel skäl gör
nästa mätning svårare att tolka.

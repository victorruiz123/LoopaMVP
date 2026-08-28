# Typsystemet — egenskaper i stället för etiketter

Ombyggd 2026-08-07. Ersätter den platta klassificeraren som klassade en bild i 14
typer och träffade 54,5 %.

Alla siffror kommer ur `measure_price_relevance.py`, `build_model_prior.py` och
`measure_type_system.py` mot `master.parquet` (1 525 135 annonser) och
vektorlagret (93 230 bilder).

---

## Vad datan tvingade mig att ändra i uppdraget

Tre av premisserna i uppdraget höll inte mot mätning. De redovisas först,
eftersom allt annat vilar på dem.

### 1. `matgrupp` är BILLIGARE än `matbord`, inte 4× dyrare

Uppdraget anger `matbord -> matgrupp` som en förväxling som "kostar 4× i pris".
Mätningen säger motsatt riktning:

**matgrupp = 0,52× matbord** inom samma modell (47,9 % skillnad, 959
modellgrupper, 95 % KI [0,50, 0,56]).

Fyndet replikerar i varje enskilt modellord — bjursta 300 mot 500, ingatorp 500
mot 1 000, mörbylånga 1 591 mot 3 800, ekedalen 625 mot 900 — och över 741
modellgrupper i ett oberoende urval (median 0,51). Rimligast är en buntrabatt:
sju delar till en köpare kräver lägre pris än bordet ensamt.

Rabatten djupnar dessutom med bordets pris (rangkorrelation −0,342):

| bordets prisnivå | medianbord | mediankvot |
|---|---:|---:|
| billigast | 950 kr | 0,78 |
| låg | 1 888 kr | 0,44 |
| hög | 3 000 kr | 0,44 |
| dyrast | 5 500 kr | 0,38 |

Matgruppen är dyrare i 18,2 % av grupperna, och de fallen ligger nästan alla i
botten — melltorp och sandsberg är 200-kronorsbord där stolarna faktiskt tillför
något.

### 2. `chaise` är prisirrelevant och får inte härleda hörnsoffa

| par | kvot | skillnad | grupper | 95 % KI |
|---|---:|---:|---:|---|
| divan/schäslong ÷ rak soffa | **0,94** | 5,9 % | 510 | [0,91, **1,00**] |
| hörnsoffa ÷ rak soffa | 1,23 | 23,4 % | 438 | [1,16, 1,30] |
| hörnsoffa ÷ divan/schäslong | 1,27 | 27,5 % | 290 | [1,20, 1,34] |

Konfidensintervallet för divan mot rak soffa innehåller 1,00 — de är oskiljbara.
Att härleda `hornsoffa` ur en divan hade överprisat varje divansoffa med ~30 %.
`chaise` behålls därför för sökexpansionen men styr inte typen, och har
prispåverkan 1 av 5 så att den aldrig kostar ett betalt anrop.

### 3. Märkeskolumnen duger inte som priornyckel

Uppdraget föreslår en prior per `(märke, modell)`. **`brand_norm` är tom för
141 067 av 145 219 soffannonser** — 3 % täckning. Priorn nycklas därför på
distinktiva modellord i annonsnamnet, vilket också ligger närmare hur användaren
söker ("Kivik hörnsoffa").

---

## Attributmodellen

Typen är en härledd funktion av oberoende attribut, inte en etikett. Prispåverkan
är mätt, inte skattad:

| attribut | mätt spännvidd | påverkan |
|---|---|---:|
| `sub` | matbord/sidobord 3,00×, matbord/soffbord 2,00× | 5 |
| `base` | korsar hela familjer | 5 |
| `seats` | 4-sits/2-sits 2,00×, 3-sits/2-sits 1,33× | 4 |
| `set_items` | matgrupp/matbord 0,52× | 4 |
| `storage_kind` | hylla/skänk 0,58×, byrå/hylla 1,25× | 4 |
| `corner` | hörnsoffa/rak 1,23× | 3 |
| `convertible` | bäddsoffa/rak 0,80× | 3 |
| `chaise` | divan/rak 0,94× — irrelevant | 1 |

Prisnivåerna per typ är **försonade med minsta kvadrat i logrummet**, eftersom de
parvisa kvoterna inte är transitiva: `hylla/vitrin` ger vitrin 1,70 medan
`byra/vitrin` ger 1,95. Att välja en av dem hade varit ett godtyckligt val mellan
två mätningar. Största kvarvarande residual: 0,065 i log för förvaring, 0,061 för
soffor, 0,036 för bord.

**Ett okänt attribut förblir okänt.** Den platta klassificeraren tvingades välja
en av 14 etiketter även när den inte visste, och valde då systematiskt den
generiska billigare. Här ger okänt en union av möjliga typer och ett bredare pris.

---

## Lagren

### L0 — text

Deterministisk, gratis, högst precision. Korpusen är **ASCII-vikt**
(`_normalize_series` kör NFKD), så lexikonet är skrivet i vikt form: `byra`,
`baddsoffa`, `schaslong`, `hornsoffa`. Ett lexikon med å/ä/ö hade matchat noll
rader.

Alla former är hämtade ur en frekvensräkning över korpusen, inte påhittade:

| begrepp | dominerande form | n | varianter som förekommer |
|---|---|---:|---|
| bäddsoffa | `baddsoffa` | 44 402 | `baddsofa`, `u-baddsoffa`, `hornbaddsoffa` |
| matgrupp | `matgrupp` | 51 271 | `matsalsgrupp`, `matbordsgrupp` |
| schäslong | `schaslong` | 24 336 | `schaslang`, `shaslong`, `schaslongdel` |
| divan | `divan` | 20 454 | `divansoffa`, `divan-soffa`, `dubbeldivan` |
| hörnsoffa | `hornsoffa` | 19 966 | `vinkelsoffa`, `l-soffa`, `hornsektion` |
| byrå | `byra` | 194 679 | `kommod`, `dragkista`, `klaffbyra` |

**Fyra falska vänner, alla mätta:**

* `skankes` (524) och `bortskankes` (586) betyder "ges bort" — aldrig möbeln skänk
* `dagbadd` (10 300) är en dagbädd, inte en bäddsoffa
* `baddmadrass` (8 596) är en madrass
* `hornskap` (15 898), `hornbord`, `hornhylla`, `hornstol` — **`horn` implicerar
  inte soffa**, så hörnattributet tolkas i sin bastyps sammanhang

**Positionsregeln:** första möbelordet avgör bastypen. "Soffbord till hörnsoffa"
är ett bord, och hörnattributet får inte läcka in på det.

### L1 — modellnamnsprior

12 697 modellord ur databasen, 5 179 med stark bas-prior. Median 34 annonser per
ord. Omkörbar via `build_model_prior.py`.

Priorn tystar sig själv där den ska: `Malm` (entropi 0,52) och `Hemnes` (0,66) får
ingen bas alls, eftersom de är säng *och* byrå *och* skrivbord. `Mio` (0,76)
likaså. Starka: `billy` → förvaring 100 %, `pax` → förvaring 96 %, `poang` →
stol 94 %, `bjursta` → bord 91 %.

Priorn fungerar också som **bildspärr** — den enda mekanismen i kedjan som kan
avvisa ett bildsvar på annan grund än bildens egen konfidens. Säger bilden "bord"
och modellordet är Lamino är bilden fel.

**Bara kategoriska attribut får prior** (`base`, `sub`, `storage_kind`, `seats`).
Texten ger `corner`/`chaise`/`convertible` enbart som `True`, och att ordet saknas
är inget bevis för att egenskapen saknas. En prior byggd på dem hade lutat
systematiskt mot False och återskapat exakt det nedgraderingsfel omdesignen finns
för att bli av med. Det är ett designval jag gjorde själv.

### L2 — bilden, grovt

Bara `base`, aldrig undertyp och aldrig funktion. Grunden är den tidigare
mätningen: platt över 14 typer 54,5 %, kollapsad till soffamiljen 87,2 %. Bilden
ser form tillförlitligt och funktion inte alls.

Tar en **lista** bilder och summerar rösterna över dem. Ett hörn syns inte från
alla vinklar men syns från någon. Vips skickvideo blir därmed en konfigändring
senare, inte en ombyggnad.

### L3 — vision-LLM, riktat

Ställer konkreta, verifierbara frågor per attribut i stället för "vilken typ är
detta", med strukturerat svar (`value` + `confidence` + `evidence`).

Tre regler som inte är förhandlingsbara:

1. **`convertible` frågas aldrig ur en bild.** En ihopfälld bäddsoffa ser ut som
   en soffa — det är själva orsaken till att 87 % av bäddsofforna kallades soffa.
   Attributet går till L4.
2. **Bara okända attribut med hög prispåverkan**, och bara efter att
   value-of-information visat att svaret flyttar priset ≥ 10 %.
3. **Fallback är obligatorisk.** Alla undantag fångas; ett dött API sänker L3,
   aldrig prissvaret. Det har hänt förut att krediterna tog slut mitt i en
   utvärdering och hela bildvägen föll bort.

### L4 — användarfrågan

Returnerar `clarifyingQuestions[]` med attribut, frågetext, uppskattad
prispåverkan i kronor och en motivering appen kan visa. Samma VoI-spärr som L3 —
att fråga är billigast av allt men bara värt något om svaret flyttar priset.

### L5 — osäkerheten går till priset, inte till ett gissat typval

Förblir ett prisviktigt attribut okänt returneras unionen av möjliga typer,
medianerna per typ och ett förslag på hur mycket intervallet bör breddas.
`typeConfidence` sätts till låg.

---

## Beslutsreglerna

1. **Källhierarkin** (`user > text > prior > image > vision > default`) upprätthålls
   strukturellt i `Attributes.set`, inte utspritt i anropen.
2. **Priorn som spärr** mot bilden.
3. **Value of information** före varje betalt anrop och varje användarfråga.
4. **Asymmetri mot nedgradering** — och den var lätt att bygga fel.

Regel 4 förtjänar en förklaring. Den naiva varianten är "kräv starkare evidens
för `False` än för `True`". Den är fel: `corner=True` gör möbeln **dyrare**
(1,205×) medan `convertible=True` gör den **billigare** (0,823×). Riktningen
sitter i priset, inte i booleanen. Asymmetrin räknas därför på den härledda typens
mätta prisnivå: 0,75 konfidens krävs för att göra möbeln billigare, 0,50 för
motsatt riktning.

---

## Buggar som mätningarna avslöjade

**Negationsspärren matchade delsträngar.** `ej` ligger inne i *v-ej-lby*,
*r-ej-al*, *sk-ej-by*, *l-ej-ontassar*; `inte` inne i *inte-rlubke*. Det
blockerade **134 giltiga attributträffar** i korpusen — "Vejlby bäddsoffa" och
"Rejal skänk" fick inget attribut. Efter rättning till hel-token-matchning: 10
blockerade, samtliga äkta ("utan schaslong", "ej baddbar", "klädsel till en
bäddsoffa"). Negationsfrekvens efter rättning: 0,008–0,025 % per attribut.

**Priorn förorenades av andra möbler i samma annons.** `Lamino` fick
`sub=sidobord` i 89 % av fallen — från Lamino*bordet* som säljs tillsammans med
stolen. `Kivik` fick `storage_kind=hylla` i 99 % — från hyllan i samma annons.
Båda är osanna om själva möbeln. Fördelningarna är nu betingade på bastypen.

**`type_confidence` räknade irrelevanta attribut.** En soffa bedömdes som osäker
för att `storage_kind` var okänt. Samma buggklass som prior-föroreningen: attribut
måste tolkas i sin bastyps sammanhang. Löst med en `RELEVANT`-karta.

**`normalize_text` byggde en pandas Series per anrop.** Över 1,5 miljoner rader
gånger tre studier blev det 4,5 miljoner onödiga Series-konstruktioner. Löst med
`prenormalized=True` för korpuskolumner, som redan är vikta.

---

## Metodanmärkning: prislikhet räcker inte för sammanslagning

Mätningen gav `matgrupp ÷ soffbord` = 1,03, alltså 2,8 % skillnad. Att slå ihop
dem vore absurt — de är lika dyra av en tillfällighet, inte av släktskap.
Sammanslagning prövas därför bara mellan ord som redan är synonymkandidater.

`skänk ÷ vitrin` ligger på 0,91 (9,4 %), under uppdragets 10 %-tröskel. Men
konfidensintervallet [0,87, 0,95] utesluter 1,00, så skillnaden är verklig om
liten. Jag behöll dem som skilda attributvärden och expanderar sökningen över båda
i stället — vilket är det alternativ uppdraget anger för den andra grenen. Ett
beslut jag tog själv, och som datan stöder åt båda hållen.

---

## Huvudmåttet: prisfel orsakat av typfel

3 200 annonser, 400 per bastyp, läckagespärr på annonsens egen vektor och hela
dubblettgruppen. Frågetexten **blindad** — typorden strukna, modellorden kvar —
eftersom facit kommer ur texten och en omätt L0 annars får 100 % per definition.

| konfiguration | täckning | bas rätt | typ rätt | kr när fel | p90 när fel | väntevärde | mätbara |
|---|---:|---:|---:|---:|---:|---:|---:|
| blind text (L0) | 0,1 % | — | — | — | — | 0 | 4 |
| text+prior (L0+L1) | 23,3 % | 63,9 % | 49,9 % | 700 | 3 210 | 606 | 672 |
| **bild, familj (L2)** | 86,8 % | **79,4 %** | 61,9 % | 550 | 2 500 | **360** | 2 490 |
| text+prior+bild | 89,6 % | 75,6 % | 58,8 % | 600 | 2 800 | 438 | 2 559 |
| gammal platt klassificerare | 98,9 % | 78,2 % | 35,3 % | 500 | 2 460 | 348 | 1 645 |

**Måttet fick byggas om efter en första körning som var oläsbar.** Två fel:
medianen togs över alla fall och blev därför 0 för samtliga konfigurationer
(majoriteten är rätt), och konfigurationerna mättes på olika delmängder — den
gamla klassificeraren såg bäst ut enbart för att dess mätbara delmängd var
mindre. Nu villkoras felet på *att* det blev fel, och jämförelsen görs också på
snittet av det som är mätbart i alla konfigurationer (n = 287).

### Baslinjerna, som uppdraget krävde

* **(a) endast text:** 0,1 % täckning blindad. Texten kan inte återfinna en typ
  den inte fått. Det är inte ett underkännande av L0 — texten är bäst av alla när
  den *har* orden — utan en mätning av hur ofta den inte har dem.
* **(b) dagens platta DINOv2-röst:** 78,2 % på bas, 35,3 % på typ, 348 kr.
* **(c) text+prior utan bild:** 63,9 % på bas, 606 kr. **Klart sämst.**

Svaret på uppdragets fråga "om (c) är nästan lika bra som fulla kedjan — säg det,
då är bilden inte värd komplexiteten": (c) är **inte** nästan lika bra. Bilden är
värd sin komplexitet, priorn är det knappt.

### Ett obekvämt resultat: den gamla klassificeraren har lägst kronofel

348 kr mot bildens 360 kr, och 279 mot 341 på den gemensamma delmängden.
Förklaringen finns i uppdelningen:

* bilden har rätt bas och typen har **ingen** undertyp: 1 720 fall, **0 kr fel**
* bilden har rätt bas men sanningen är en **undertyp**: 380 fall, **805 kr fel**

Ett lager som avstår från undertypen äter alltså ett garanterat fel på
undertypade familjer, medan den gamla klassificeraren åtminstone försöker och
ibland lyckas. **Men punktmåttet mäter inte vad L5 gör.**

### Unionsmåttet — vad den nya designen faktiskt påstår

L5:s svar på okänd undertyp är att söka över unionen och bredda, inte att välja en
punkt. Mätt separat (`measure_union_benefit.py`, n = 2 458):

| skattning | väntevärde | median | p90 |
|---|---:|---:|---:|
| punkt (basen som typ) | 371 kr | 0 | 1 050 |
| **union (L5)** | **302 kr** | 0 | 900 |
| gammal platt klassificerare | 344 kr | 0 | 1 000 |

Unionen slår båda. Täckningen av den rätta typens median, **bara på de
icke-triviala unionerna** (≥ 2 celler, n = 1 011 — 58,9 % av fallen har bara en
cell och där är måttet degenererat):

* alla fall: **90,6 %**
* bara undertypade fall: **98,6 %**
* pris: median spridningskvot **2,43×**

Det är designens starkaste resultat och samtidigt dess tydligaste begränsning.
2,43× är för brett att skicka som prisförslag rakt av. Unionen bör användas för
att bredda **måttfullt** och för att trigga L4-frågan — inte för att söka över
allt.

---

## Priorn mot bilden — uppdragets regel 2 höll inte

Uppdraget: *"Priorn vinner över bild när dess entropi är låg."* Jag byggde det så.
Mätningen säger motsatt. På de 658 fall där båda svarar:

| | bas rätt |
|---|---:|
| priorn (L1) | 67,5 % |
| bilden (L2) | **78,3 %** |

Oense i 149 fall. Där har **bilden rätt i 66,4 % och priorn i 18,8 %** — och
bilden vinner i varje enskild bastyp (soffa 78/22, stol 70/30, säng 69/31,
förvaring 65/35, fotpall 61/0, bord 54/46, spegel 54/38).

Konsekvensen i koden var konkret: `text+prior+bild` gav **identiska** siffror som
`text+prior`, eftersom källhierarkin lät priorn fylla `base` först och bilden
aldrig kom till tals.

Jag prövade först att bara strama åt entropigränsen i stället för att byta
ordning. Det fungerade inte — varje uppmjukning gjorde det **monotont sämre**:

| priorns entropigräns | täckning | bas rätt | väntevärde |
|---:|---:|---:|---:|
| 0,00 (tystad) | 86,9 % | 79,4 % | 360 kr |
| 0,20 | 87,7 % | 78,9 % | 375 kr |
| 0,50 (som byggt) | 89,0 % | 76,6 % | 426 kr |

**Åtgärd:** ordningen är omvänd för `base` — bilden först, priorn som fallback när
bilden avstår. Priorn behåller förtur för `sub`, `storage_kind` och `seats`, som
bilden aldrig sätter och där jämförelsen alltså inte finns.

| | bas rätt | väntevärde | täckning |
|---|---:|---:|---:|
| priorn först (som byggt), tröskel 0,55 | 75,6 % | 438 kr | 89,6 % |
| **bilden först, tröskel 0,70** | **81,7 %** | **342 kr** | 80,8 % |

−96 kr (−22 %) och +6,1 procentenheter, mot 8,8 procentenheter lägre täckning.

**Viktig avgränsning:** i testmängden har varje rad en bild. Utan bild är priorn
det enda som kan fylla `base`, och 63,9 % slår ingenting. Därför fallback, inte
borttagning.

---

## Avstå-kurvan och tröskeln

Vald på **huvudmåttet**, inte på träffsäkerhet:

| tröskel | täckning | bas rätt | väntevärde |
|---:|---:|---:|---:|
| 0,55 | 89,6 % | 78,1 % | 375 kr |
| 0,65 | 83,6 % | 80,5 % | 346 kr |
| **0,70** | **80,8 %** | **81,7 %** | **342 kr** |
| 0,75 | 77,6 % | 81,8 % | 353 kr |
| 0,90 | 62,3 % | 83,3 % | 390 kr |

Valet ligger på en platå (346 / 342 / 353), inte på en spik. Träffsäkerheten
fortsätter stiga till 83,3 % vid 0,90, men täckningen faller snabbare än nyttan.

Bildens familjeröst, rå avstå-kurva: 70,0 % bas rätt vid 98,5 % täckning (krav
0,30) upp till 93,3 % vid 38,4 % täckning (krav 0,95).

### Per bastyp

| bastyp | bild (bas rätt) | gammal platt |
|---|---:|---:|
| stol | 92 % | 58 % |
| soffa | 90 % | 84 % |
| förvaring | 84 % | 55 % |
| säng | 81 % | **0 %** |
| bord | 79 % | 73 % |
| fotpall | 48 % | 54 % |
| sänggavel | 45 % | **0 %** |
| spegel | 32 % | 41 % |

`spegel` är systemets svagaste punkt — speglar är visuellt för olika för
grannröstning. `fotpall` och `spegel` är de enda klasser där den gamla
klassificeraren är bättre.

---

## CUE_FILTER_ENABLED — mätt separat, och benchmarken kan inte avgöra

Uppdraget hade rätt i att ledorden är textsignaler och inte omfattas av
bildparmätningens slutsats. Men 34 frysta möbler räcker inte för att svara.

Med flaggan på rörde sig **7 av 34 möbler**, samtliga i bildläget (filtret kräver
en frågevektor, så textläget är opåverkat per konstruktion). Hit/miss blev
**identiskt** på alla tre benchmarkar — inget item korsade facitgränsen. Med
avvikelse från facitmitt i log:

| benchmark | rörde sig | av | på | bättre | sämre |
|---|---:|---:|---:|---:|---:|
| 11 första | 1 | 0,226 | 0,218 | 1 | 0 |
| benchmark 1 | 2 | 0,582 | 0,573 | 2 | 0 |
| benchmark 2 | 4 | 0,454 | 0,512 | 2 | 2 |
| **totalt** | **7** | **0,423** | **0,430** | 5 | 2 |

Fem förbättringar, två försämringar, netto marginellt negativt eftersom skadorna
är större: Lamino 9 500 → 8 500 och den anonyma Mio-annonsen 1 500 → 800 med `n`
halverat 234 → 123. Det senare upprepar mönstret att ledordsfiltret svälter
anonyma förfrågningar — men **jag lade inte in en anonymitetsspärr på det
underlaget**, eftersom det vore trimning mot de frysta benchmarkmöblerna.

**Rekommendation: låt flaggan vara av tills den mätts på korpusskala** med
kronofelet, precis som typsystemet mättes.

---

## Blindläget — och ett måttfel som påverkar tidigare rapporter

`evaluate_examples.py --blind-type` stryker typorden ur både modellnamn och
typfält.

| benchmark | läge | typ angiven | typ blindad | delta |
|---|---|---|---|---:|
| 11 första | kärnnamn | 100,0 % / 90,9 % | 100,0 % / 90,9 % | ±0 |
| 11 första | bild | 100,0 % / 81,8 % | 100,0 % / 81,8 % | ±0 |
| benchmark 1 | kärnnamn | 90,0 % / 50,0 % | 100,0 % / 50,0 % | +10,0p |
| benchmark 2 | kärnnamn | 69,2 % / 53,8 % | **92,3 %** / 53,8 % | **+23,1p** |
| benchmark 2 | bild | 61,5 % / 46,2 % | 76,9 % / 46,2 % | +15,4p |

Att ta bort information förbättrar överlappet med 23 procentenheter. Det är inte
ett resultat — det är ett **måttfel**. Överlappet belönar bredd:

| möbel | typ angiven | typ blindad | bredd |
|---|---|---|---|
| Bolia | 1 000–7 000 (n=89) | 1 995–**20 450** (n=330) | 7,0× → 10,3× |
| Mio (anonym) | 583–2 500 (n=234) | 200–**8 500** (n=6 346) | 4,3× → **42,5×** |
| byCrea | inget svar (n=0) | 1 000–**30 000** (n=8) | → 30,0× |

`default inom facit` är **oförändrat i varje rad**, och de tre möbler som "vann"
överlapp har `träff_default = False` både före och efter.

**Detta påverkar hur tidigare resultat ska läsas.** `accuracy_intervall_överlapp`
kan inte användas för att jämföra konfigurationer som skiljer sig i
träffmängdens bredd — och det gör de flesta konfigurationer i BILDROLL_RAPPORT.md
och ATGARDSRAPPORT-serien. Måttet bör ersättas med, eller kompletteras av, ett
breddstraffat mått. Jag har inte ändrat det, eftersom det skulle skriva om
tidigare siffror mitt i en pågående utvärdering.

---

## L4 kopplad till unionen — en fråga i stället för dubbel bredd

Tillagt 2026-08-08. Tidigare gjorde L5 bara en sak: konstaterade att flera typer
var möjliga och föreslog ett bredare intervall. Unionsmätningen visade att
breddningen blir 2,43× på de icke-triviala unionerna — för brett att skicka som
prisförslag.

`decide.resolve_or_widen` väljer nu mellan tre utfall:

| åtgärd | när | vad som händer |
|---|---|---|
| `prissatt` | spridning ≤ 1,15× | unionen är smal nog, prissätt rakt av |
| `fraga` | en fråga smalnar av märkbart | föreslå den frågan, bredda bara om obesvarad |
| `bredda` | ingen fråga hjälper | fall tillbaka på L5:s breddning |

Frågan väljs genom att **simulera varje tänkbart svar** och räkna vad unionen
blir. Utfallen viktas med hur många kandidatannonser som faller inom varje
resulterande typuppsättning — är 90 % av kandidaterna raka soffor är svaret "nej"
mycket troligare och ska väga tyngre.

### Sammansatta frågor — därför att en binär inte räcker

Både soffor och bord har **två** oberoende prisviktiga attribut. En fråga om bara
det ena lämnar det andra öppet:

| familj | enkel fråga | sammansatt fråga |
|---|---|---|
| soffa | `corner`: 2,25× → 1,75× | `soffa_form`: 2,25× → **1,00×** |
| bord | `set_items`: 2,67× → 2,22× | `bord_form`: 2,67× → **1,00×** |

Därför en fyrvägsfråga för soffor ("Rak / Hörnsoffa / Bäddsoffa / Hörn+bädd") och
en femvägsfråga för bord ("Matbord utan stolar / Matbord med stolar / Soffbord /
Sidobord / Skrivbord"). Ett val i stället för två ja/nej-frågor, vilket i en app
är skillnaden mellan att få svar och att inte få det.

Den sammansatta frågan erbjuds bara när minst två attribut är öppna. Vet vi redan
att det är en bäddsoffa räcker en enkel fråga.

### En bugg som mätningen av frågan avslöjade

`candidate_types` var handskriven och kunde hamna i otakt med `derive_type`: med
både `corner` och `convertible` kända som `True` gav den två möjliga typer, trots
att `derive_type` är entydig (bäddfunktionen vinner). Följden var att en
sammansatt fråga **såg ut att lämna kvar osäkerhet den faktiskt hade löst** —
1,5× i stället för 1,0×.

Unionen räknas nu genom att räkna upp kompletteringarna av de okända attributen
och köra `derive_type` på var och en. Som mest tolv kombinationer, och den kan
per konstruktion inte avvika från `derive_type`. Bieffekten är att bordunionen
blev bredare och ärligare: ett `bord` utan mer information kan verkligen vara ett
sidobord.

### I API:t

```
"Ekbord" (n=88) -> derivedType: bord, typeUncertaintyAction.action: "fraga"
   FRÅGA (sammansatt): "Vad för slags bord är det?"
      Matbord, utan stolar          -> matbord
      Matbord med stolar (matgrupp) -> matgrupp
      Soffbord                      -> soffbord
      Sido- eller avlastningsbord   -> sidobord
      Skrivbord                     -> skrivbord
   spridning 1,875x -> 1,0x   (bredda med 0,438 om obesvarad)
```

---

## L3-mätningen — genomförd 2026-08-09

Körd mot **`google/gemini-2.5-flash`** via Lovable AI Gateway, genom en egen
edge function (`type_system/edge/attribute-vision`) som håller
`LOVABLE_API_KEY` på servern. 137 anrop, 0 misslyckade, ~1 984 tokens per anrop.

### Huvudresultatet: bilden kan inte avgöra vad som INGÅR

`set_items` mättes med **matchad design** — lika många bord där stolarna ingår
som där de uttryckligen inte gör det:

| facit | n | rätt |
|---|---:|---:|
| stolarna **ingår** | 10 | **100 %** |
| stolarna **ingår inte** | 7 | **0 %** |

Sju av sju fel. Vore den sanna träffsäkerheten 50 % är 0 av 7 en händelse med
sannolikhet 0,008 — det är inte brus.

Modellen gör inget fel. Den svarar korrekt på frågan den fick:

> *"Matbord utan stolar"* → **"Fyra stolar med svarta säten och kromade ben"**
> *"1960s-tal teak matbord (stolar ingår inte)"* → **"sex stolar tydligt placerade runt"**

Frågan var fel ställd. Jag frågade vad som **syns**; attributet handlar om vad
som **ingår**. Ett matbord fotograferas i en matsal med stolarna runt sig — de
säljs bara inte med. Alla sju hade härlett `matgrupp` och prissatts till
**0,52×**, alltså halva värdet, på den dyraste förväxlingen i hela systemet.

**`set_items` är borttaget ur L3** och ligger kvar i L4, där frågan "Ingår
stolarna i priset?" har ett svar bilden aldrig kan ge.

Facit för negativen gick inte att läsa ur `set_items`: L0 sätter aldrig värdet 0,
eftersom negationsspärren blockerar "stolar" i "matbord utan stolar". Det lästes
därför ur uttryckliga säljarfraser. Bara **8 sådana annonser med bild finns i
hela korpusen** mot 2 276 positiva — och en av dem var en falsk vän ("matbord +
5 **exkl** stolar" betyder *exklusiva* stolar).

### De tre attribut bilden faktiskt klarar

| attribut | n | avstår | rätt när den svarar | prisfel när fel | väntevärde |
|---|---:|---:|---:|---:|---:|
| `corner` | 40 | 2 % | 81,6 % | 20,5 % | 3,5 % |
| `seats` | 39 | 3 % | 81,6 % | 41,4 % | 5,8 % |
| `storage_kind` | 40 | 2 % | 82,1 % | 41,5 % | 5,7 % |

Alla tre landar på ~82 %. Förväxlingarna är systematiska:

* `corner`: **True → False 6 gånger**, False → True 1. Den missar hörn oftare än
  den hittar på dem.
* `storage_kind`: **skänk → byrå 6 gånger**. Skänken läses som byrå, vilket
  underprisar med ~29 % (1,691 mot 1,195).
* `seats`: nästan bara fel på ett steg (4→3, 2→3, 3→2, 4→5).

**Riktningen är densamma som överallt annars i det här systemet: 16 av 20 fel
underprissätter.** Samma dragning mot den generiska, billigare typen som den
platta klassificeraren hade.

### Asymmetriregeln fungerar inte mot L3

`decide.accept` kräver 0,75 konfidens för att godta en nedgradering. Regeln
gallrade **noll** av de 16 felaktiga nedgraderingarna.

Orsaken: modellen svarade `hog` (0,85) på **114 av 115 anrop** — 93 rätta och 21
fel. Konfidensen bär ingen information, så varje regel som grundas på den gör
ingenting.

| konfidens | rätt | fel |
|---|---:|---:|
| hog | 93 | 21 |
| medel | 1 | 0 |

Det är ett viktigt negativt fynd: asymmetrin skyddar mot **L2**, vars konfidens
är en verklig röstandel, men inte mot L3. Skyddet mot L3 måste vara
**strukturellt** — vilka frågor som alls ställs — inte statistiskt. Det är
precis vad borttagandet av `set_items` och `convertible` är.

### Kostnad

137 anrop, 236 055 tokens totalt, **~1 984 tokens per anrop**. Lovables gateway
svarade 429 flera gånger ("a lot of free users are using the API"); återförsöken
fångade samtliga, 0 anrop förlorades.

I drift kostar L3 alltså ~2 000 tokens per prisförfrågan där den anropas — och
den anropas bara när attributet är okänt, hör till bastypen, och
value-of-information säger att svaret flyttar priset.

---

## Vad som gick fel under L3-mätningen — fyra fel, alla mina

Redovisas för att de kostade betalda anrop och för att felmönstret är lärorikt.

1. **`measure_vision_layer.py` byggde sin egen `OpenAI()`-klient** utan
   `base_url`. Mätningen såg ut att köra mot Gemini men talade med OpenAI, som
   svarade 404 på ett modellnamn den aldrig hört talas om. Rökprovet gick inte
   via den kodvägen och avslöjade inget.
2. **Fallbacken provade alla tre svarslägen på ett 404.** Tre anrop per fråga i
   stället för ett, på ett fel inget svarsformat kan lösa. Nu kastas
   404/401/403/429 vidare direkt.
3. **`--rpm` bevakade fel gräns.** Googles gratisnivå är 20 anrop per **dygn** och
   modell, inte per minut. `gemini-2.0-flash` visade sig dessutom ha `limit: 0`.
4. **Edge-funktionens promptmall använde `{"<id>": ...}`** med bokstavliga
   vinkelparenteser. Modellen fick gissa vad platshållaren skulle bli och
   utelämnade nyckeln i 15 av 18 anrop — tyst, eftersom funktionen kastade bort
   det den underkände utan att säga vad det var. Rättat med ett konkret exempel
   plus ett `dropped[]`-fält och rå-eko.

Fel 4 är det värsta av dem: jag gissade orsaken (typtvingning) i stället för att
göra felet observerbart först, och gissade fel. Det kostade en omdeploy och ~15
anrop. Rå-ekot finns nu just för att nästa fel ska gå att läsa av i stället för
att resoneras fram.

Två skydd tillkom under vägen: **tomma svar cachas aldrig** (annars hade
omkörningen efter rättningen återanvänt felet och fått det att se permanent ut),
och **en explicit angiven klient vinner över edge-konfigurationen**, så en satt
`VISION_EDGE_URL` inte tyst styr om en anropare som valt leverantör medvetet.

---

## Tidigare: L3-mätningen blockerad av slut på krediter

`measure_vision_layer.py` är byggd och körd. Pilotkörningen fick:

```
429 - You have no credits remaining. Add credits to continue using the API.
```

**Mätningen kan inte genomföras** förrän krediter finns. Skriptet ligger klart:
`python measure_vision_layer.py --pilot` för 20 anrop, `--per-group 100` för den
skarpa körningen (~400 anrop, uppskattningsvis under en dollar på gpt-4o-mini).

Pilotkörningen bekräftade däremot en sak som var värd att veta: **fallbacken
fungerar.** Kedjan fortsatte, ingenting kraschade, inga attribut skrevs, 16 rader
loggades till noll kostnad. Det var precis den här felmoden som tidigare fällde
hela bildvägen mitt i en utvärdering.

### Två av fyra prisviktiga förväxlingar kan L3 aldrig mäta

* **`convertible`** (bäddsoffa → soffa, 87 % — den största av alla) frågas aldrig
  ur en bild. En ihopfälld bäddsoffa *är* en soffa visuellt. Attributet går till
  L4, där det nu ingår i den sammansatta soffrågan.
* **`stol ↔ fåtölj`** finns inte som attribut i den nya modellen. Båda är
  `base=stol` utan undertyp, eftersom prisrelevansmätningen aldrig prövade dem.
  Det är en lucka: förväxlingen var 13,3 % i den gamla klassificeraren och dess
  prisriktning är fortfarande omätt.

Kvar för L3 att mätas på: `corner`, `set_items`, `storage_kind`, `seats`.

---

## Rekommendation

I prioritetsordning. Punkt 1, 2 och 3 är införda, resten kräver ditt beslut.

### Infört

1. **Bilden före priorn för `base`**, priorn som fallback. Mätt: −96 kr i
   väntevärde, +6,1 procentenheter bas rätt.
2. **Avstå-tröskel 0,70**, vald på kronofelet och liggande på en platå.

3. **Sammansatta L4-frågor** för soffa och bord. Mätt: 2,25x -> 1,00x respektive
   2,67x -> 1,00x, mot 1,75x / 2,22x för en enkel fråga.

### Kräver beslut

4. **Ersätt överlappsmåttet.** Det belönar bredd, och blindläget visar hur
   illa: 42× breda intervall räknas som träff. Alla jämförelser mellan
   konfigurationer med olika träffmängdsbredd är opålitliga tills detta är löst.
   Det här är den enskilt viktigaste punkten i rapporten, för den påverkar hur
   varje tidigare mätning ska tolkas.
5. **Koppla in kedjan i prissättningen.** Fälten är i dag redovisande. Att låta
   `derivedType` och unionen styra sökningen är en beteendeändring som förtjänar
   sin egen mätning — och unionens 2,43× bredd måste dämpas innan den släpps på.
6. **Låt CUE_FILTER_ENABLED vara av** tills den mätts på korpusskala.
7. **Bestäm om L3 ska vara på i produktion.** Mätningen är gjord (se ovan):
   ~82 % på `corner`, `seats` och `storage_kind`, väntevärde 3,5–5,8 % prisfel,
   ~2 000 tokens per anrop. Att jämföra med alternativet att lämna attributet
   okänt, vilket ger en union med 2,43x spridning. L3 är alltså klart bättre än
   att inte veta — men sämre än att fråga användaren, och den frågan är gratis.
   Min rekommendation: **L4 före L3.** Ställ frågan när användaren är kvar i
   flödet; använd L3 bara när ingen kan svara.

### Vad jag inte rekommenderar

Att bygga en tvåvillkorsregel för priorn mot bilden (entropi × röstenighet).
Korsningstabellen antyder att priorn borde vinna när dess entropi är låg *och*
bilden är osäker, men cellerna har 4–23 observationer. Att trimma en regel mot
dem vore överanpassning. Den enkla ordningen är mätt över 658 fall.

---

## Vad som inte är gjort

* **`stol <-> fåtölj`** — den fjärde prisviktiga förväxlingen finns fortfarande
  inte som attribut, och dess prisriktning är omätt.
* **`set_items` negativa fall bortom 8** — korpusen innehåller inte fler
  annonser med uttrycklig text om att stolarna inte ingår.
* **Ledorden på korpusskala** — se punkt 5.
* **Kedjan kopplad till priset** — se punkt 4.

341 tester passerar. Inga trösklar är satta mot benchmarkmöblerna; avstå-tröskeln
och entropigränsen är kalibrerade mot korpusfacit med läckagespärr.

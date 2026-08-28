# Sökningens ordproblem — Del A, B och C

Genomfört 2026-08-18 på det frysta instrumentet (harness v6). 461 tester
passerar. **Del D (corner_count) och Del E (dedup-skärpning) är inte byggda** —
se sista avsnittet.

---

## Del A — Stoppord i söknyckeln · **BEHÅLL**

### Vad som ändrades

`SEARCH_STOPWORDS` i `price_engine/config.py` — en **egen** lista, skild från
`GENERIC_TOKENS`. De två har olika jobb: anonymitetslistan innehåller möbelord
(`soffa`, `divan`, `ek`) eftersom den avgör om en fråga identifierar någon
produkt, och att stryka dem ur sökningen vore att kasta bort frågan. Ett test
vaktar att de inte glider ihop.

Innehåll: rena funktionsord — `med och till fran for i pa av den det en ett som
ar var samt plus inkl inklusive vid under over utan om`. **Status: teoretiskt.**
Urvalet är grammatiskt, inte svept, men att orden saknar produktinformation går
att läsa direkt ur listan.

Spärren finns: stryks allt återlämnas texten orörd. En tom söknyckel matchar
hela korpusen och är mycket värre än en dålig nyckel.

### Mätning — formuleringarna konvergerar

| fråga | före | efter | struket |
|---|---|---|---|
| Mio Madison **med** divan | 2 692–**4 275**–7 089 | 2 692–**3 794**–7 089 | `med` |
| Mio Madison +divan | 2 692–3 794–7 089 | 2 692–3 794–7 089 | — |
| Mio Madison divan | 2 692–3 794–7 089 | 2 692–3 794–7 089 | — |

De tre formuleringarna ger nu **identiskt svar**. `divansoffa` avviker
fortfarande (2 968) och ska göra det — det är ett annat ord, inte en annan
formulering av samma.

Strukna ord redovisas i `ignoredTerms`.

### Benchmarkpåverkan

**En av 35 möbler** berörs: b2#2 `soffa med puff` → `soffa puff`. De övriga 34
söknycklarna innehåller inga funktionsord. Effekten på totalsiffran är därmed
strukturellt begränsad till en möbel.

Benchmarkkörningen startades men hann inte slutföras inom detta pass — se
"Vad som återstår".

---

## Del B — Termuppmjukning · **BEHÅLL, med ett förbehåll**

### Vad som ändrades

`TERM_RELAX_MIN = 15` (**status: teoretiskt** — ärvt från `RECENCY_MIN_LISTINGS`
och `VARIANT_STRICT_MIN`, inte svept).

Ger söknyckeln färre än 15 träffar släpps ord ett i taget. Attributen läses ur
den ursprungliga texten **innan** något släpps, så ett släppt typord styr
fortfarande typfiltret — samma princip som `core_name`-fixen.

### Rangordningen var fel i första försöket

Jag byggde först prioritetsordningen som specen skrev den: beskrivande ord (1),
okända ord (2), modellnamn (3). Utfallet blev:

```
Matgrupp byCrea  ->  släppte 'matgrupp'  ->  1 095 kr
```

Den släppte kategorin och behöll `bycrea` — alltså priset på vad som råkar heta
bycrea, inte på en matgrupp. Orsaken: `bycrea` finns 8 gånger i korpusen, inte
noll, så "okänt ord"-regeln träffade inte.

**Rättad ordning:** ett ord som ENSAMT har färre träffar än golvet släpps först,
oavsett vad det är. Ett sådant ord kan aldrig bära en konjunktiv fråga, hur
identifierande det än verkar. Sedan beskrivande ord, sist modellnamn och märke.

```
Matgrupp byCrea  ->  släppte 'bycrea'  ->  n=503  1 600-2 000-3 500  typ=matgrupp
```

### Mätning på riktig data

| fråga | före | efter | släppt |
|---|---|---|---|
| Matgrupp byCrea | **inget svar** | 1 600–2 000–3 500 (n=503) | `bycrea` |
| DUX säng 303 | **inget svar** | 300–**1 000**–4 500 (n=30) | `303` |
| IKEA karlstrand | inget svar | inget svar | — (en enda term) |
| Ektorp / Madison / … | oförändrat | oförändrat | — |

Enterms-frågor mjukas aldrig upp — att släppa den enda termen ger tom sökning.
Därför svarar `karlstrand` fortfarande inte, vilket är rätt.

### Förbehållet: tystnad blir katastrofmiss

**`DUX säng 303` går från inget svar till 1 000 kr mot facit 50 000–80 000.**
Det är −98 %, alltså en katastrofmiss där det tidigare var tystnad.

Specen sa "ett svar med bred osäkerhet ska ersätta tystnad". Mätningen visar att
det inte alltid är en förbättring: för en möbel vars prisklass helt saknas i
korpusen blir det breda svaret inte osäkert utan **fel med råge**. Ditt eget
tidigare direktiv säger att en katastrofmiss skadar förtroendet mer än tio små
missar.

Svaret markeras `confidence: low` med förbehållet utskrivet, och `relaxedTerms`
visar vad som släpptes med träffar före/efter. Men konfidensmarkeringen räddar
inte en användare som ser 1 000 kr för en säng värd 50 000.

**Jag har inte byggt någon spärr mot det** — det vore en designändring specen
inte bad om. Förslag att besluta: mjuka inte upp när det släppta ordet är det
enda som skiljer frågan från en ren kategorifråga, eller kräv att den uppmjukade
mängden ligger inom en rimlig prisordning från den ursprungliga.

---

## Del C — Var försvinner 7 990 → 3 545? · **MÄTNING, ingen kodändring**

Spårning av `Mio Madison divan` steg för steg, reproducerad två gånger med
identiskt resultat:

| steg | operation | n | median |
|---|---|---|---|
| A | textsökning | 111 | 7 500 |
| A2 | cellfilter (22 buntar bort) | 89 | 7 990 |
| B | prisbas `asking` | 89 | 7 990 |
| C1 | variantfilter `filtered` | 89 | 7 990 |
| **C2** | **färskhet `extended`** | **15** | **5 500** |
| F | percentiler | | 4 000–**5 000**–10 000 |
| G | shrinkage | | 2 692–**3 545**–7 089 |

### Svaret: felet sitter i C2, och shrinkagen förvärrar det

**Färskhetsfiltret tar bort 74 av 89 rader — och de bortkastade har median
8 700 kr, alltså HÖGRE än de som behålls.**

Granskning av de 20 ytterlighetsraderna: **samtliga är äkta divan-Madison.**

```
19 500  2025-11-14  Soffa Mio Madison 3-sits Divan höger
19 000  2025-11-14  NY Mio Soffa Madison 3-sits med Divan
18 000  2025-07-12  Madison Lux divansoffa MIO
16 900  2024-07-12  Mio Madison Lux 3-sits med divan höger
   200  2025-09-16  3-sits soffa med divan, "Madison" från Mio
 1 000  2025-07-13  Mio Madison 3 sits med divan höger
 2 600  2025-07-12  Mio Madison Lux högkvalitativ divansoffa
```

Ingen av dem är fel jämförelse. **Filtret kastar rätt rader**, och det gör det
för att de är daterade 2025-07 till 2025-11 — alltså 9–13 månader gamla, precis
utanför åttamånadersfönstret.

Detta är korpusåldrandet från förra paketet, nu med en konkret prislapp. Archive
ligger helt utanför fönstret, så för Madison återstår bara de sparsamma
2026-raderna, och de är systematiskt annorlunda.

### Shrinkagens bidrag

| mängd | n | svar |
|---|---|---|
| smal (de 15 färska) | 15 | 4 000–**5 000**–10 000 |
| bred (Mio + sofftyp, utan modellnamn) | 7 214 | 1 000–**1 500**–3 000 |
| blandat, w = 15/21 = 0,71 | | 2 692–**3 545**–7 089 |

Shrinkagen drar svaret ytterligare **−29 %** genom att blanda in alla Mio-soffor,
vars median är 1 500 kr. Den är korrekt enligt sin egen design — n=15 ligger
under golvet 30 — men den blandar in en mängd som är fyra gånger billigare.

### Slutsats

**Rätt svar för divan-Madison är cirka 6 500 kr.** Alla 89 äkta rader ger
5 900–**6 500**–9 999. Motorn svarar 3 545, alltså **−45 %**.

Felet sitter i **steg C2**, med shrinkagen som förstärkare. Ingen av dem är en
bugg — båda gör vad de är byggda för. Problemet är att åttamånadersfönstret på
en korpus vars huvudkälla slutade 2025-12 lämnar för lite kvar, och att
shrinkagen då kompenserar med en alldeles för bred mängd.

**Åtgärdsförslag, inget beslutat:**

1. **Din Blocket-skrapning löser detta direkt** — den är den enda åtgärd som
   angriper orsaken i stället för symtomet.
2. Låt shrinkagens breda mängd behålla möbeltypens *undertyp* (divan/hörn) i
   stället för bara märke + bastyp. Att jämföra en divansoffa med alla Mio-soffor
   är för brett; kvoten hörnsoffa/soffa är mätt till 1,205×.
3. Överväg om `RECENCY_MONTHS = 8` ska vara adaptiv: utöka fönstret tills 30
   rader nås i stället för 15, så att shrinkagen inte behöver lösa ut alls.
   **Ovaliderad konstant sedan tidigare** — den bör svepas oavsett.

---

## Vad som återstår

**Del D (corner_count) och Del E (dedup-skärpning) är inte byggda.** Jag hann
inte igenom dem inom detta pass med den mätning mellan varje steg som reglerna
kräver, och en halvbyggd taxonomiändring utan mätning är sämre än ingen.

Underlaget för båda finns dock redan mätt i föregående svar och står kvar:

**Del D:** `u-soffa` förekommer 1 536 gånger i korpusen, `dubbeldivan` 108,
`hörnsoffa` 10 064. Premien U mot enkelhörn är indikativt **1,43×** (5 000 mot
3 500 kr i färsk asking-data) — men **noll modellgrupper har ≥3 av varje sort**,
så nivån vilar på jämförelse mellan olika modeller och är inte en fastställd
kvot. Den ärlighetsnoten ska stå i rapporten när delen byggs.

**Del E:** Friday-klustret är sju rader, samma dag, exakt 4 000 kr, ordföljden
omkastad. Utan det flyttar U-Friday-medianen från 4 000 till 5 900 kr (+48 %).
Effekten på brusgolvet σ är också omätt.

**Benchmarkkörningen för Del A** startades men slutfördes inte. Del A:s
totaleffekt på accuracy är därmed inte redovisad — bara att exakt en av 35
söknycklar berörs.

## Beslut jag fattade själv

| beslut | motivering |
|---|---|
| Egen `SEARCH_STOPWORDS` i stället för att återanvända `GENERIC_TOKENS` | Anonymitetslistan innehåller möbelord; att stryka `soffa` och `divan` ur sökningen hade kastat bort frågan. Ett test vaktar gränsen. |
| Rangordningen i Del B ändrad mot specen | Specens ordning gav mätbart fel utfall — `matgrupp` släpptes före `bycrea`. Ordet som inte kan bära en fråga ens ensamt släpps först. |
| Enterms-frågor mjukas aldrig upp | Att släppa den enda termen ger tom sökning, vilket matchar hela korpusen. |
| Ingen spärr byggd mot katastrofuppmjukning | Det vore en designändring specen inte bad om. Förbehållet är i stället mätt och rapporterat för ditt beslut. |

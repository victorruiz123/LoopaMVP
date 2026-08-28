# Åtgärdsrapport — tre fixar efter bildtyps-rapporten

Testmängderna var **frysta** genom hela arbetet: inga trösklar, ingen taxonomi
och inget `k` justerades mot dem. Varje åtgärd mättes separat innan nästa
påbörjades. 235 tester passerar (217 före + 18 nya).

## Sammanfattning

| mätning | före paketet | efter åtgärd 1 | efter åtgärd 2 |
|---|---|---|---|
| de 11 första, text — överlapp / default inom | 100 % / 90,9 % | 100 % / 90,9 % | 100 % / 90,9 % |
| de 11 första, **bild** — överlapp / default inom | 100 % / 72,7 % | 100 % / 72,7 % | 100 % / **81,8 %** |
| benchmarken, text — överlapp / default inom | 90 % / 50 % | 90 % / 50 % | 90 % / 50 % |
| benchmarken, **bild** — överlapp / default inom | 90 % / 50 % | 90 % / 50 % | 90 % / **60 %** |

Åtgärd 2 bar hela förbättringen. Åtgärd 1 rättade en verklig designbrist men
löste inte det fall den valdes för — och skälet är att min egen diagnos av det
fallet var fel. Det står under åtgärd 1.

---

# Åtgärd 1 — utropsbas när identiteten är okänd

## Vad som ändrades

`identity_is_anonymous(name, brand)` avgör om förfrågan identifierar någon
produkt. Ett märke räcker; utan märke krävs minst ett ord som inte bara
beskriver möbeln. Är förfrågan anonym utesluts auktionsdata helt, och
`priceBasis` blir `asking_forced_unknown_identity`.

Regeln är explicit och testbar, inte en bieffekt av vilken datamängd som råkar
vara störst — det var precis den bieffekten som orsakade felet.

**Svenskan tvingade fram en generell regel.** En ordlista räcker inte: `ekbord`
är `ek` + `bord`, `sammetssoffa` är `sammet` + foge-s + `soffa`. Ett ord räknas
därför som generiskt om det står i listan, eller om det slutar på ett listat
typord och resten också är generisk. Suffixet måste vara minst fyra tecken —
annars faller modellnamn: *Landskrona* slutar på "ona", *Strandmon* på "mon".

## Före/efter

| möbel | bas före | bas efter | default före | default efter | facit |
|---|---|---|---|---|---|
| Matgrupp 5 stolar | `realized` | `asking_forced_unknown_identity` | 586 | 514 | 1500–2500 |
| Ekbord med stolar | `asking` | `asking` (oförändrad) | 300 | 300 | 2000–5000 |

## Regressionskontroll

**Ingen möbel med känt namn ändrades.** Samtliga 11 i första uppsättningen och
8 av 10 i benchmarken har identiska värden före och efter. Bara de två anonyma
flödena påverkades, vilket är exakt regelns avsedda räckvidd. Ett eget test
(`test_kant_produkt_pavarkas_inte_av_regeln`) låser fast det.

## Vad som INTE löstes, och varför

**Min diagnos av "Ekbord med stolar" var fel.** Jag skrev i förra rapporten att
felet berodde på auktionsbasen. Det gjorde det inte: 225 av 226 kandidater var
redan `asking`, från blocket och archive. Åtgärden kunde därför inte hjälpa där.

Den verkliga orsaken är att Blocket-utropen för "ekbord med stolar" faktiskt
ligger på 50–250 kr:

```
 50 kr   Massivt Ekbord med 4 stolar i trä, vitt underrede   (blocket)
 83 kr   Rejält ekbord med 6 stolar                          (blocket)
100 kr   Massivt ekbord med 8 stolar                         (blocket)
```

Bilden visar en tjock, massiv ekbordsskiva där facit 2 000–5 000 är rimligt —
men motorn får orden "Ekbord med stolar", och för dem är marknaden 50–250 kr.
Gapet är inte ett räknefel utan en **kvalitetsskillnad som orden inte bär**.
Ledordet `massiv` som bildsteget hittar är rätt signal, och åtgärd 2 gjorde det
möjligt för den att verka — men den räckte inte hela vägen.

Matgrupp 5 stolar bytte bas korrekt men rörde sig nedåt (586 → 514), eftersom
utropspopulationen för anonyma matgrupper också är billig (240–1 000 kr).
Åtgärden gjorde rätt; underlaget pekar bara inte dit facit ligger.

---

# Åtgärd 2 — filtergolvet

## Vad som ändrades

`MIN_COMPARISON_SET = 30`. Ingen filterkedja får ta jämförelsemängden under
golvet. Det filter som skulle bryta det konverteras automatiskt från
**filtrering** till **viktning**: annonserna behålls, men de som filtret velat
kasta väger `FILTER_DOWNWEIGHT = 0.25`.

Regeln gäller alla filter i prioritetsordning — variant, bild, ledord — och
kommer att gälla framtida filter utan ändring. Det är golvet som är
arkitekturen, inte bildundantaget.

Tre detaljer som visade sig nödvändiga:

**Golvet mäts efter färskhetsfiltret**, inte före. Ett variantfilter som lämnar
200 annonser hjälper inte om färskheten sedan skär till 20. Färskheten beräknas
därför på båda alternativen och valet görs på det filtrerade utfallet.

**Viktade kvantiler** (`compute_weighted_range`). Med enhetsvikter ger den
samma `low` och `high` som positionslogiken; `default` kan skilja en position,
eftersom den oviktade vägen avrundar positioner medan kvantilen räknar exakt.
Skillnaden är försumbar mot vad viktningen själv gör.

**30 är valt teoretiskt.** Det är samma tal som `MIN_ASKING_PER_MATCH` i
percentilstudien, av samma skäl: under ~30 observationer vilar p30 och p60 på
tre annonser vardera. Talet justerades inte mot testmängderna — det vore
`k = 6`-fällan igen.

## n-kolumnen före/efter — beviset att svälten är botad

De 11 första, bildläge:

| möbel | n före | n efter | effektiv n | konverterat | default före → efter |
|---|---|---|---|---|---|
| IKEA Ektorp | 20 | **166** | 56,5 | bild | 756 → 750 |
| IKEA Vimle | 26 | **40** | 29,5 | ledord | 1 788 → 2 000 |
| Mio Cordelia | 5 | **11** | 6,5 | bild | 1 103 → 1 542 |
| Sweef Valen 224 | 7 | **15** | 9,0 | bild | 7 684 → 8 331 |
| Mio Santos | 7 | **24** | 9,6 | variant, bild | 1 000 → 1 000 |
| Söderhamn, Jennylund, Strandmon, Clara, PINNTORP, Kinnarps | oförändrade | | | — | oförändrade |

Benchmarken, bildläge:

| möbel | n före | n efter | konverterat | default före → efter | facit |
|---|---|---|---|---|---|
| Mio Town | 22 | **34** | variant, bild, ledord | 6 163 → **7 000** ✓ | 7000–12000 |
| IKEA Karlstad | 14 | **44** | variant, bild, ledord | 1 169 → 950 ✓ | 500–2000 |
| IKEA Stocksund | 23 | **38** | variant, bild, ledord | 938 → 900 ✓ | 800–2000 |
| Bellus soffa | 13 | **29** | variant, bild, ledord | 4 000 → 3 500 ✓ | 2000–6000 |
| Mio Bridge | 13 | **24** | variant, bild | 3 334 → 3 394 | 3500–7000 |
| Ekbord med stolar | 22 | **35** | bild | 371 → 317 | 2000–5000 |

## Nådde det målet?

**Nej, inte fullt ut.** Målet var att de 11 förstas default-träff skulle
återhämta sig mot 90,9 %. Den gick från 72,7 % till **81,8 %** — nio av elva.

Benchmarkens vinster behölls och utökades: Stocksund och Karlstad ligger kvar
inom facit, och **Mio Town gick från −12 % till inom facit** utan att någon
möbel tappades. Default-träffen där gick 40 % → 60 %.

Kvar utanför på de 11 första är PINNTORP (452 mot 600–800) och Strandmon
(800 mot 1000–2000). Bägge överlappar men ligger under. Ingen av dem är ett
filterproblem: PINNTORP blandar hela matgrupper med lösa delar, och Strandmon
har 41 träffar med oförändrat filter.

Mio Bridge gick från inom facit till 3 394 mot 3 500 — **en regression på
−3 %**, orsakad av att bildviktningen drog ned p40 marginellt. Den redovisas
här snarare än att golvvärdet ändras för att gömma den.

---

# Åtgärd 3 — storlek inom variant: MÄTNING

Ingen lösning byggd, enligt uppdraget. Underlaget: utropsannonser med igenkänt
modellnamn ur bryggmätningens lista, grupperade på storleksord i titeln
(2–9-sits, u-soffa, divan, längd i cm, antal stolar).

## Hur stort är problemet?

```
andel annonser med storleksord i titeln            14,3 %
(modell x variant)-celler med minst 2 storleksgrupper   40

spridning > 25 %      32 av 40   (80 %)
spridning > 50 %      25 av 40
spridning > 100 %     16 av 40
medianspridning       78 %
```

**Detta är inget hörnfall.** Fyra av fem mätbara celler överstiger 25 %, och
medianen ligger på 78 %. De grövsta:

| modell | variant | n | storleksandel | spridning | gruppmedianer |
|---|---|---|---|---|---|
| kivik | hörnsoffa | 1 032 | 90 % | **3,9×** | 2-sits 1 250 · 3-sits 2 000 · 4-sits 3 000 · 5-sits 4 900 · divan 1 000 |
| stockholm | soffa | 243 | 37 % | 3,8× | 3-sits 5 900 · 5-sits 1 975 · u-soffa 9 500 |
| ektorp | hörnsoffa | 776 | 51 % | 3,4× | 3-sits 2 000 · 4-sits 4 000 · divan 900 |
| madison | soffa | 547 | 38 % | 3,2× | 2-sits 7 250 · 3-sits 4 900 · 4-sits 10 997 |
| karlstad | soffa | 214 | 50 % | 2,8× | 2-sits 600 · 3-sits 2 250 |
| söderhamn | hörnsoffa | 1 227 | **91 %** | 2,3× | 2-sits 3 000 · 4-sits 4 800 · 6-sits 6 000 · divan 1 800 |

## Det avgörande för beslutet

**Täckningen är hög precis där problemet är värst.** Hörnsofforna — som är
Mio Town-fallet — har storleksord i 87–91 % av annonserna (Kivik 90 %,
Söderhamn 91 %, Vimle 87 %). Signalen finns alltså i texten och behöver inte
gissas. Genomsnittet på 14,3 % dras ned av kategorier där storlek inte nämns
och sällan spelar roll.

Spridningen inom variant (median 78 %) är dessutom **större än
variantspridningen den ligger under** — och variantfiltret var värt att bygga.

## Vad som skulle byggas

En nivå under variant i taxonomin: storleksklass ur titeln, med samma
uppmjukningsordning och samma filtergolv som variant nu har. Kombinerat med
ledorden — som redan hittar `divan` och `schäslong` ur bilden — skulle en
U-soffa kunna skiljas från en tvåsits utan modellanrop.

**Om OpenAI-krediter fylls på** vore lagret ovanpå detta att låta en
visionmodell läsa av storlek direkt ur bilden (antal sittplatser, L- eller
U-form, längd i förhållande till omgivningen). DINOv2-grannarna ger redan
ledorden, men de säger vad *liknande* möbler är, inte vad *denna* är. Där är en
promptad modell fortfarande bättre.

## Falsk signal värd att känna till

Min storleksextraktor gav `hemnes byrå: 2 stolar 275 kr` — en byrå som råkat
matcha "2 st.". Cirka en av fyrtio celler bär den sortens brus, och en
skarp implementation behöver kräva att storleksordet är förenligt med
möbeltypen.

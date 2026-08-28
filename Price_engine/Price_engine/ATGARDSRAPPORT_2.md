# Åtgärdsrapport 2 — storleksnivån, ekbordsklassen, färska tester

En ändring i taget, egen mätning per del. **268 tester passerar** (242 före +
26 nya). De gamla mängderna användes bara för regressionskontroll.

## Sammanfattning

| mätning | före paketet | efter Del 1 | efter Del 2 |
|---|---|---|---|
| de 11 första, text | 100 % / 90,9 % | 100 % / 90,9 % | 100 % / 90,9 % |
| de 11 första, bild | 100 % / 81,8 % | 100 % / 81,8 % | 100 % / 81,8 % |
| benchmarken, text | 90 % / 50 % | 90 % / 50 % | 90 % / 50 % |
| benchmarken, bild | 90 % / 60 % | 90 % / 60 % | **100 %** / 60 % |

*(överlapp med facit / default inom facit)*

Del 2 löste ekbordsfallet. Del 1 är byggd, aktiv och korrekt men **flyttade
inga siffror på dessa mängder** — skälet står nedan och det är inte att nivån
saknar värde.

---

# Del 1 — storleksnivån

## Vad som ändrades

Ny nivå i trappan: modell → variant → **storlek**. `price_engine/size.py`
extraherar sitsantal, form (U-soffa, divan, schäslong), längd i cm och antal
stolar. Storleken lagras som kolumn vid inläsning och filtret går in efter
varianten, **under samma filtergolv som alla andra filter** — ingen egen
specialmekanik.

**Kompatibilitetsspärren** är tabellen `COMPATIBILITY`: sitsar hör till soffor
och fåtöljer, antal stolar till matgrupper, centimeterlängd till bord och
liggmöbler. Utan den gav min egen mätning `hemnes byrå: 2 stolar 275 kr` — en
byrå som råkat matcha "2 st." i titeln. Spärren har egna tester för just de
falskträffarna.

**`sizeWarning`** när frågan saknar storlek men mängden spretar: intervallet
breddas till att omfatta storleksgruppernas medianer, `confidence` sätts till
`low`, och grupperna följer med i svaret. Det är information användaren behöver,
inte bara en varning.

## Täckning per möbeltyp

```
hörnsoffa      73,4 %      säng            17,5 %
matgrupp       36,7 %      bäddsoffa       16,1 %
soffa          26,8 %      matbord          6,5 %
                           bord/hylla/byrå  <2 %
totalt          7,5 %  (78 776 annonser)
```

Täckningen är högst precis där problemet är värst. Genomsnittet på 7,5 % dras
ned av kategorier där storlek sällan nämns och sällan spelar roll.

## Vad som hände på de frysta mängderna

| möbel | sizeMethod | n före → efter | default före → efter |
|---|---|---|---|
| IKEA Söderhamn | `filtered` | 134 → **39** | 2 500 → 2 500 |
| IKEA Ektorp | `weighted` | 166 → 166 | 750 → 750 |
| IKEA Vimle | `weighted` | 40 → 40 | 2 000 → 2 000 |
| IKEA PINNTORP | `no_match` | 15 → 15 | 452 → 452 |
| Matgrupp 5 stolar | `weighted` | 15 → 15 | 514 → **438** |

`sizeWarning` löste ut på fyra möbler och pekade rätt varje gång: Söderhamn
(3-sits/4-sits), Mio Town (divan/3-sits/u-soffa), Karlstad (2-sits/3-sits),
Stocksund (divan/3-sits).

## Varför siffrorna inte rörde sig — och varför det inte är ett underkännande

Två skäl, båda värda att veta:

**Storleken fanns inte i frågan till att börja med.** Testharnessen skickar
`core_name`, som kapar just storleksorden — "Söderhamn bäddsoffa 3-sits" blir
"Söderhamn". Jag ändrade harnessen till att läsa storleken ur specens
`Variant`-fält, och först då aktiverades nivån alls. Det är ett fynd om
harnessen, inte om motorn.

**De berörda möblerna låg redan inom facit.** Söderhamn, Ektorp och Vimle
träffade rätt före ändringen, så en bättre jämförelsemängd kan inte förbättra
utfallet — bara göra det mindre slumpmässigt rätt. Söderhamn prissätts nu på
39 rena 3-sits i stället för 134 blandade, med samma svar. Det är en riktig
förbättring som måttet inte kan se.

Det uppmätta värdet av nivån etablerades i förra rapporten: **medianspridning
78 % inom variant**, 80 % av cellerna över 25 %. De 22 möblerna innehåller
inget fall där storlek är det avgörande felet. Det är precis därför Del 3
kräver minst fem storleksvariantfall.

**En regression:** Matgrupp 5 stolar gick 514 → 438 (facit 1 500–2 500, alltså
längre under). Storleksfiltret på "5 stolar" viktade om mängden och drog ned
p40. Redovisas hellre än gömmes.

---

# Del 2 — ekbordsklassen: visuell kohort

## Vad som ändrades

`price_engine/cohort.py`. Aktiveras bara när **alla tre** villkoren gäller:
förfrågan identifierar ingen produkt, det finns en bild, och ordkohortens
prisspridning (p90/p10 i logdomän) överstiger 6,0.

Kohorten byggs av bildens grannar i vektorlagret, filtrerade på möbeltyp via
DINOv2-typrösten, dubblettgrupper borttagna, avskurna med **klippdetektering**
— det största fallet i likhetskurvan mellan golvet (15) och taket (200).
Priset räknas likhetsviktat med samma viktade kvantiler som filtergolvet
införde.

## Ekbordsfallet före/efter

```
utan bild   asking_forced_unknown_identity   n=35   212 – 300 – 833     facit 2000-5000   nej
med bild    visual_cohort                    n=24   143 – 672 – 3000    facit 2000-5000   JA
```

Kohortdiagnostiken:

```json
{"cohort_size": 24, "similarity_range": [0.79, 0.853],
 "effective_n": 19.5, "cut_at": 24, "word_dispersion": 25.0}
{"dispersion": 17.3, "clusters": [{"median": 625, "n": 19},
                                  {"median": 3000, "n": 5}]}
```

**Kohorten hittade rätt grannar och avslöjade två prislägen** — 625 kr (n=19)
och 3 000 kr (n=5), där det senare är rätt för just det här bordet. Den tunga
klungan drar fortfarande ned p40 till 672 kr, men spridningsvarningen
redovisar båda, och intervallet breddas till att omfatta dem. Överlappet nås.

Benchmarkens överlapp gick därmed **90 % → 100 %**.

## Beslut jag fattade själv

**Intervallet breddas vid `dispersionWarning`.** Specen bad om varning och
`confidence: low` men sa inte uttryckligen "bredda". Ditt eget exempel —
"hellre osäkert 800–3 500 än gissa fel snävt" — är dock ett breddat intervall,
så jag tolkade det så. Utan breddningen hade svaret varit 143–1 543 och missat
facit helt trots att kohorten innehöll rätt annonser.

**Klungdelningen kräver ett verkligt glapp.** Ett `argmax` över diffar delar
även en helt jämn fördelning. `COHORT_GAP_FACTOR = 3.0` kräver att det största
glappet är tre gånger det typiska steget, annars rapporteras inga klungor. Ett
test låser fast att en jämn fördelning ger `[]`.

**Bimodalitet fick inget eget test.** Två prislägen med glapp emellan ger per
definition hög p90/p10, så spridningsmåttet fångar båda fallen med en tröskel.

## Vad som INTE ändrades

**Textflödet för anonyma frågor utan bild är oförändrat** — verifierat: 0 av 11
i första mängden ändrades, och 9 av 10 i benchmarken. Bara Ekbord rörde sig.

**Matgrupp 5 stolar aktiverade inte kohorten.** Bara 6 grannar över
likhetsgolvet, mot kravet 15 — köksfotot har inga nära visuella grannar bland
de 94 305 embeddade bilderna. Rapporteras som `too_few_neighbours` i stället
för att sänka golvet, vilket hade varit att trimma mot testfallet.

---

# Del 3 — färska tester

## Vad som är byggt

**[TESTFALL_MALL.md](TESTFALL_MALL.md)** — mall, fältkrav, exempel-CSV,
sammansättningskrav med skälet till varje krav, och frysreglerna.

**`evaluate_examples.py --check-composition`** räknar av din lista mot kraven
innan mätningen körs, och säger vilka som fattas. Testad mot benchmarken:

```
krav                                antal  krävs   status
fall totalt (20-30)                    10     20   SAKNAS
storleksvarianter (>= 5)                0      5   SAKNAS
anonyma utan modellnamn (>= 5)          0      5   SAKNAS
med bild                               10     10   OK
```

**Rapportering per felklass** — `storlek`, `anonym`, `tunt`, `övrigt` — i
stället för en totalsiffra, eftersom de fyra kräver olika åtgärder.

**`--frozen`** skriver en hash av specfilen till resultatet, så att en ändrad
testmängd inte tyst kan förväxlas med den ursprungliga.

## Två saker du behöver veta innan du skickar listan

**`brand` och `model` ska vara TOMMA när de inte finns.** Benchmarken skrev
beskrivningen i `model` ("Matgrupp 5 stolar"), och därför räknas den som
`övrigt` i stället för `anonym` — kompositionskontrollen rapporterar 0 anonyma
fall trots att två är just det. En tom `model` är hur du säger "detta är
ekbordsklassen".

**Modellnamnet ska vara namnet, inte rubriken.** "Söderhamn", inte "Söderhamn
bäddsoffa 3-sits". Skillnaden är 2 853 träffar mot 2. Storleken hör i
`variant`-fältet, där harnessen nu läser den.

## Slutmätningen är inte gjord

Den kräver dina 20–30 fall. När de kommer kör jag hela mängden i båda lägena
och rapporterar per felklass — det är slutmätningen för hela paketet, och den
första siffra i projektet som inte är mätt på material som trimmats mot.

Fram till dess är **100 % / 81,8 %** och **100 % / 60 %** tak snarare än
skattningar. Allt utom filtergolvet på 30 har sett testmängderna.

# Skadestudien — Fas 0: inventering

Stoppar här enligt instruktionen. **503 tester passerar.**

---

## Kort svar: studien kan inte köras som specificerad

**Fas 1 kräver "endast asking". Det finns noll flaggade asking-rader.**

Skadeflaggorna lever uteslutande i auktionsdatan, eftersom `condition_text` var
ett auctionet-fält. Blocket- och archive-säljare skrev fritext i `description`,
som var ifylld på 4,9 % och kapad vid 160 tecken.

| prissort | rader | flaggade | andel |
|---|---|---|---|
| **asking** | 1 055 740 | **0** | **0,0 %** |
| realized | 469 395 | 443 530 | 94,5 % |

| källa | rader | flaggade | andel |
|---|---|---|---|
| archive | 973 009 | **0** | 0,0 % |
| blocket | 82 731 | **0** | 0,0 % |
| auctionet | 461 564 | 443 483 | 96,1 % |
| tradera | 7 831 | 47 | 0,6 % |

Med kravet "märke + modellord ur vitlistan + möbeltyp, minst 8 flaggade och 8
oflaggade" kvalificerar **0 grupper** i asking-data.

**Graderingen överlevde inte heller.** Bara booleaner och en räknare. Gradorden
("liten fläck", "kraftigt slitage") fanns i `condition_text` och är borta med
den — oåterkalleligt för de 470 278 rader som redan fanns. Det var mitt
extraktionsbeslut i saneringen, och det var för snålt.

---

## Fråga 1 — Vad finns per rad?

Sju kolumner, alla härledda:

| kolumn | typ | värden |
|---|---|---|
| `damage_wear` … `damage_defect` | bool | True/False |
| `damage_count` | int | 0–6 |

**Ingen gradering. Ingen kontext. Inga evidenssträngar.** Ett rad som säger
`damage_stain=True` kan lika gärna komma från "knappt synlig fläck" som från
"stora fläckar över hela sitsen".

---

## Fråga 2 — Bär rubrikerna gradering? Nej.

Rubrikerna behölls i saneringen, så de var den enda möjliga kvarvarande källan.
De duger inte:

| skadekategori | rader i rubriken | mot skicktexten |
|---|---|---|
| wear | 518 | 390 054 |
| damage | 455 | 202 399 |
| defect | 180 | 51 636 |
| scratch | 81 | 112 592 |
| crack | 46 | 42 730 |
| stain | 45 | 107 804 |
| **någon skada** | **1 310 (0,09 %)** | 443 530 |

Gradadjektiv i dessa 1 310 rubriker: `liten/små` 30, `stor` 11, `mindre` 11,
`kraftig` 2, `knappt` **0**. Alltså under 4 % av en redan försumbar mängd.

### Och de 1 310 är till stor del falska

Granskning av vilka ord som utlöste:

```
söksträng 'nott'  träffade  'zanotta'  77    <- märkesnamn
söksträng 'nott'  träffade  'minotti'  28    <- märkesnamn
söksträng 'nott'  träffade  'nottingham' 16  <- ortnamn
söksträng 'skad'  träffade  '"kaskad"' 28    <- modellnamn
söksträng 'repa'  träffade  'reparationsobjekt' 17
```

**Det är en riktig bugg i ordlistan** — samma delsträngsklass som `lsoffa` inuti
*hallsoffa* och `marke` inuti *varumärke*, båda dokumenterade tidigare. Jag
byggde den och missade den igen.

### Men den skadade inte de levererade flaggorna

Reviderat mot den skicktext som överlevde saneringen (se nedan), 120 000 rader:

| fälla | utlöste |
|---|---|
| `nott` inuti Zanotta/Minotti/Nottingham | **0** |
| `nott` inuti `knott` | 3 |
| `repa` inuti `reparation` | 51 |
| `saknas` i "etikett saknas" | 2 |

Märkesnamn står i rubriker, inte i skickrapporter. `damage_wear` är alltså i
praktiken oförorenat. Buggen hade slagit hårt om ordlistan någonsin körts mot
rubriker — vilket den inte gör.

---

## Fråga 3 — Samförekomst

| flaggor | rader | andel av flaggade |
|---|---|---|
| 1 | 168 578 | 38,0 % |
| 2 | 135 894 | 30,6 % |
| 3 | 97 617 | 22,0 % |
| 4 | 33 902 | 7,6 % |
| 5 | 6 844 | 1,5 % |
| 6 | 695 | 0,2 % |

Underlaget för Fas 2:3 (kombinationseffekten) finns alltså — men bara i
auktionsdata.

---

## Fråga 4 — Täckning

Per källa och prissort: se tabellerna överst. Per möbeltyp, topp sex:

| typ | rader | flaggade | andel |
|---|---|---|---|
| stol | 189 697 | 70 804 | 37,3 % |
| bord | 135 790 | 50 557 | 37,2 % |
| fåtölj | 86 352 | 43 090 | **49,9 %** |
| byrå | 75 595 | 31 605 | 41,8 % |
| förvaring | 94 559 | 30 358 | 32,1 % |
| soffa | 131 101 | 25 554 | 19,5 % |

Andelen speglar hur stor del av typen som säljs på auktion, inte hur ofta möbler
går sönder.

---

## Vad som ändå går att mäta

Enbart på realized/auktion:

| gruppering | rader | kvalificerade grupper (≥8+8) | rader i dem |
|---|---|---|---|
| märke + modellord + typ | 24 650 | **7** | 4 181 |
| modellord + typ | 63 506 | **36** | 11 525 |
| bara möbeltyp | 469 395 | 20 | 401 524 |

De största grupperna är designklassiker:

```
lamino yngve|fatolj             1474 flaggade /  62 oflaggade
jacobsen sjuan|stol             1455 /  76
bruno mathsson pernilla|fatolj  1133 /  26
farmor|fatolj                    649 /  67
```

Fördelning över typ bland de 36: fåtölj 13, stol 11, byrå 3, resten enstaka.

### Kontrollgruppen är liten men äkta

Den oflaggade sidan i auktionsdatan är inte tomma fält utan genuina
icke-anmärkningar: "No remarks" (1 204), "Gott skick", "Nyskick", "Renoverad
och kompletterad". Det är en användbar kontroll — men den utgör bara 3,9 % av
auktionsraderna, och i flera grupper är n under 30.

---

## Min bedömning inför Fas 1

**Studien kan genomföras, men inte på den population motorn prissätter i.**

Motorn prissätter på **asking**. Flaggorna finns bara i **realized**. En
avdragstabell mätt på auktionsklubbade designklassiker och applicerad på
Blocket-utrop för IKEA-möbler vore en extrapolering över både kanal och
sortiment — precis den sortens blandning som `AUCTION_CORRECTION` finns för att
motverka, och som percentilstudien visade skevar med faktor 1,36.

Tre vägar, i den ordning jag skulle välja:

**1. Vänta på din Blocket-skrapning.** Gradextraktionen är nu byggd (se nedan),
så ny data ger både flaggor och grad i rätt population. Det är den enda vägen
som ger ett avdragssystem för den marknad motorn faktiskt betjänar.

**2. Kör studien på auktionsdata ändå, men som *riktningsstudie*** — mät
kategoriernas inbördes ordning och kombinationseffekten (Fas 2:3), inte
absoluta avdrag. Ordningen "spricka kostar mer än slitage" håller sannolikt
över kanaler även när nivåerna inte gör det. 36 grupper räcker för riktning,
inte för nivå, och cellerna per typ skulle nästan alla bli
`insufficient_data` mot din 30-gruppsgräns.

**3. Bygg avdragssystemet mekaniskt utan tabell** — basregeln, stapelregeln och
grad-multiplikatorerna med alla värden `insufficient_data`, så att strukturen
finns när underlaget kommer. Ingen mätning, bara ställningen.

Jag lutar åt **1 + 3**: bygg ställningen nu, fyll den när data finns. Väg 2 ger
siffror som ser mätta ut men inte gäller för produktionens population, och den
sortens tal brukar överleva sin varningstext.

---

## Byggt i Fas 0 (den villkorade delen)

Gradextraktionen som specen bad om **om graderingen inte överlevde**:

`type_system.damage.grades()` och `grade_columns()` läser gradadjektiv inom tre
ord från skadeordet och ger 0 (nedtonad) / 1 (neutral) / 2 (förstärkt).
Förstärkning vinner över nedtoning — "små repor och kraftigt slitage" får inte
läsas som en lindrig annons.

```
"Liten fläck på sitsen"          -> {'stain': 0}
"Kraftigt slitage och små repor" -> {'wear': 2, 'scratch': 0}
"Repor förekommer"               -> {'scratch': 1}
```

Sju `grade_*`-kolumner tillagda i intagsvitlistan. De är **tomma för hela den
befintliga korpusen** och fylls från nästa skrapning. **12 nya tester.**

Nivåerna är etiketter, inte multiplikatorer — kopplingen till pris ska mätas,
inte antas.

---

## En lucka i saneringen som jag hittade under revisionen

`prod_full/auctionet_sold_full.ndjson` bär fortfarande fritextfältet
`condition` — 462 965 rader, median 84 tecken. Min raderingslista täckte
`condition_text` men inte `condition`.

Det var lyckosamt här: fältet var enda vägen att revidera skadeflaggorna mot sin
källa. Men det är kvarvarande skyddat material, och det ska bort när du säger
till. Säg om jag ska ta det nu — det tar några minuter och kräver ingen
omkörning av något annat.

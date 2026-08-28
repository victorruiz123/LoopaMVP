# Bildtröskeln mätt med facit ur databasen

Handmärkningen underkändes i stickprov. Felet var metoden — att bedöma "samma
möbel?" ur två foton är subjektivt, och jag var för liberal. **Trösklarna
0,65 / 0,68 / 0,76 är ogiltiga och ska inte implementeras.**

Detta är omgjort med textbaserat facit: två annonser vars titlar bär samma
märke OCH samma modellnamn visar samma modell. Ingen bedömning, en uppslagning.

**Motorn är orörd.** `IMAGE_SIMILARITY_MIN = 0.45` står kvar.

## Underlag

```
par                      9 779   (~500 per klass och möbeltyp, balanserat)
möbeltyper                  10
skärmdumpar hittade        38 bilder -> 221 par bortsorterade
uteslutet                  dubblettgrupper, near-duplicates (>0,98), bild saknas
frö                        20260806   parlistan: image_pairs/facit_par.csv
```

Alla tio möbeltyper nådde ~500 par per klass. `matgrupp`, `spegel` och
`del/tillbehör` föll bort helt — för dem finns för få annonser med både
igenkänt märke och modellnamn.

## Resultat per möbeltyp

Sorterat på separation. AUC 0,5 = ingen separation, 1,0 = perfekt.

| möbeltyp | par/klass | AUC | median samma | median olika | tröskel | sens | spec | rekommendation |
|---|---|---|---|---|---|---|---|---|
| stol | 500 | **0,957** | 0,811 | 0,358 | **0,63** | 0,90 | 0,96 | **justera** |
| fåtölj | 492 | **0,887** | 0,736 | 0,407 | **0,61** | 0,79 | 0,86 | **justera** |
| fotpall | 500 | **0,876** | 0,651 | 0,312 | **0,52** | 0,79 | 0,80 | **justera** |
| byrå | 500 | 0,691 | 0,498 | 0,313 | 0,44 | 0,59 | 0,73 | behåll 0,45, låg vikt |
| soffa | 484 | 0,662 | 0,632 | 0,519 | 0,53 | 0,71 | 0,53 | låg vikt |
| bord | 497 | 0,612 | 0,347 | 0,273 | — | 0,37 | 0,80 | **skrota** |
| bäddsoffa | 488 | 0,592 | 0,661 | 0,608 | — | 0,93 | 0,23 | **skrota** |
| hylla | 476 | 0,577 | 0,274 | 0,225 | — | 0,64 | 0,47 | **skrota** |
| säng | 481 | 0,522 | 0,314 | 0,298 | — | 0,31 | 0,77 | **skrota** |
| hörnsoffa | 480 | 0,513 | 0,523 | 0,541 | — | 0,85 | 0,22 | **skrota** |

## Var ingen tröskel är meningsfull — rakt ut

**Hörnsoffa (AUC 0,513) och säng (0,522) är rent slumpmässiga.** Medianlikheten
för samma modell är 0,523 mot 0,541 för olika modeller — den positiva klassen
ligger alltså *lägre* än den negativa. Ingen tröskel kan separera det. Samma
gäller hylla (0,577) och bäddsoffa (0,592).

**Bord (0,612) bekräftas.** Det var slutsatsen från handmärkningen som höll:
bildlikheten kan inte identifiera bord. Medianen för samma modell är 0,347 —
under dagens tröskel 0,45 — så 320 av 497 positiva par skulle filtreras bort
medan 90 negativa släpps igenom. Det förklarar matbordsmissen i benchmark 2.

**Soffa (0,662) är svagare än väntat.** Specificiteten vid bästa tröskel är
0,53, alltså knappt bättre än en slantsingling. Att den ursprungliga
kalibreringen gjordes på soffor gör resultatet extra obekvämt.

Bara **stol, fåtölj och fotpall** bär en tröskel. De har distinkt silhuett och
fotograferas ofta ensamma mot enkel bakgrund; soffor och sängar fotograferas i
rum där möblerna tar en mindre del av bilden.

## Jämförelse mot dagens 0,45 och mot den underkända mätningen

```
möbeltyp     dagens 0,45           handmärkt (ogiltig)    facit
stol         144 FP / 27 FN        0,69                   0,63
fåtölj       201 FP / 39 FN        0,65                   0,61
fotpall      154 FP / 61 FN        —                      0,52
soffa        313 FP / 76 FN        0,68                   0,53 (svag)
säng         110 FP / 334 FN       0,76                   ingen
hylla         72 FP / 355 FN       0,88                   ingen
bord          90 FP / 320 FN       går inte               ingen
```

Den handmärkta mätningen låg **systematiskt för högt** för stol och fåtölj, och
gav trösklar för säng och hylla där facitet säger att ingen tröskel finns. Båda
felen pekar samma väg: mina positiva par var i själva verket olika möbler som
såg lika ut, vilket sköt den positiva fördelningen uppåt.

Dagens 0,45 är för lågt för de tre typer där en tröskel går att sätta, och
samtidigt för högt för bord, hylla och säng — där det kastar bort merparten av
de faktiskt matchande annonserna.

## Samma modell ≠ samma möbel

Uppdelningen på storlek visar att distinktionen inte spelar någon roll för
bildlikheten:

```
              samma storlek        annan storlek
soffa         0,656  (n=58)        0,682  (n=44)
hörnsoffa     0,491  (n=159)       0,507  (n=180)
bäddsoffa     0,694  (n=12)        0,692  (n=21)
```

Medianerna är i praktiken identiska, och för soffa och hörnsoffa ligger *annan*
storlek marginellt högre. DINOv2 skiljer alltså inte en tvåsits från en femsits
av samma modell. Storleken måste komma ur texten — bilden bär den inte.

Uppdelningen gick bara att göra för de tre soffatyperna; för övriga saknar för
många annonser storleksord.

## Sidofynd

**38 skärmdumpar** från ikea.se och jysk.se hittades i bilddatan och tog med sig
221 par. De embeddas som möbler och förorenar både bildsökning och kohort.
Detektorn kräver mobilproportion *och* över 55 % nästan vita pixlar — ett av
kriterierna ensamt fångar riktiga studiofoton.

**Sänggavlar klassas som `säng`.** Det påverkar säng-resultatet: en stor del av
säng-paren är stoppade gavlar, som visuellt är rektanglar i tyg. Att AUC blir
0,522 kan delvis vara den effekten snarare än en egenskap hos sängar. Oavsett
vilket är slutsatsen densamma — bildfiltret hjälper inte där.

## Filer

- `image_pairs/facit_par.csv` — de 9 779 paren, omkörbara med frö 20260806
- `image_pairs/facit_analys.json` — fullständig statistik
- `image_pair_facit.py` — parbyggaren
- `validate_images.py pairs --per-class 500` — kör om mätningen

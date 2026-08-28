# Bildpar-rapport — mätning av bildtröskeln

Engångsjobb. Målet var att ersätta gissningen `IMAGE_SIMILARITY_MIN = 0.45` med
uppmätta trösklar per möbeltyp. **Ingenting i motorn är ändrat.**

## Huvudresultat: 0,45 är för lågt, och det är inte nära

```
etikett                      n    median    p25–p75
olika                      112     0,600    0,318–0,740
samma_modell_annan_variant  11     0,842    0,767–0,862
samma_variant                3     0,769    0,725–0,780
```

Medianen för **olika möbler är 0,600** — alltså långt över dagens tröskel 0,45.
Vid 0,45 släpps 32 av 112 olika-par igenom (29 %), och för bord och matgrupp
är det 15 av 25 respektive 10 av 13.

Den uppmätta tröskeln totalt är **0,68** (Youdens J = 0,71, sensitivitet 1,0,
specificitet 0,71). Alla 14 positiva par ligger över 0,68; inget positivt par
ligger under 0,45, vilket betyder att en höjning inte kostar några träffar i
det här materialet.

## Per möbeltyp

| möbeltyp | par | tröskel | J | separation | falska pos. vid 0,45 | positiva par |
|---|---|---|---|---|---|---|
| fåtölj | 24 | **0,65** | 0,86 | 1,74 | 12 | 2 |
| soffa | 24 | **0,68** | 0,81 | 1,48 | 12 | 3 |
| säng | 13 | **0,76** | 0,90 | 1,40 | 5 | 3 |
| stol | 13 | **0,69** | 0,80 | 0,61 | 8 | 3 |
| byrå | 7 | **0,79** | 0,80 | 0,56 | 5 | 2 |
| hylla | 7 | **0,88** | 1,00 | 0,57 | 5 | 1 |
| bord | 25 | **går inte** | — | — | 15 | **0** |
| matgrupp | 13 | **går inte** | — | — | 10 | **0** |

`separation` = avståndet mellan klassernas medianer mätt i olika-klassens
spridning. Under ~1,0 betyder tröskeln lite oavsett värde.

## Där separationen är dålig — och där den inte finns alls

**Bord och matgrupp: noll positiva par av 38.** Inte ett enda par av de 38
märkta visade samma möbel — inte vid 0,60, inte vid 0,81, inte vid 0,82. Två
teaksoffbord från 60-talet ser likadana ut för DINOv2 utan att vara samma
möbel, och två matgrupper med ljust träbord och spjälstolar likaså.

Det förklarar matbordsmissen i benchmark 2 direkt: bildfiltret kan inte
identifiera bord, och vid 0,45 blev de 617 som passerade ett i praktiken
slumpmässigt urval. **För bord och matgrupp bör bildfiltret ha låg eller ingen
vikt**, oavsett vilken tröskel som väljs.

**Stol, byrå och hylla har separation 0,56–0,61** — grupperna överlappar
kraftigt. Trösklarna 0,69/0,79/0,88 vilar dessutom på 1–3 positiva par vardera,
så de är riktningsangivelser, inte mätningar.

**Bara fåtölj (1,74), soffa (1,48) och säng (1,40) har separation som duger.**
Där är också underlaget bäst. Det stämmer med den ursprungliga kalibreringen —
den gjordes på soffor och fåtöljer, och det är just de typerna som fungerar.

## Vad som märktes, och vad som inte gjordes

```
par valda        200   (25 per möbeltyp, 40 per likhetsspann, frö 20260806)
par märkta       128
därav osäkra       2   (räknade bort ur mätningen)
```

**72 par är omärkta**, och de sitter i de låga spannen: matgrupp 79–90,
stol 103–114, hylla 127–144, byrå 151–168, säng 181–192. Jag prioriterade
0,45-och-uppåt för de fem senare möbeltyperna, eftersom tröskelbeslutet ligger
där, och märkte soffa, fåtölj och bord fullständigt över hela spannet.

Konsekvensen ska vägas in: **de omärkta paren är alla lågsimilära, och i det
märkta materialet är lågsimilära par uteslutande `olika`** (30 av 30 för
soffa/fåtölj/bord under 0,45). Skulle de märkas skulle de därför sannolikt öka
olika-klassen i de låga spannen, vilket flyttar de föreslagna trösklarna
**uppåt** eller lämnar dem oförändrade — inte nedåt. Siffrorna ovan är alltså
konservativa i den riktning som spelar roll.

Fotomixen blev 86 blocket/blocket, 28 blandade och 14 auctionet/auctionet —
alltså övervägande hemmafoton, vilket är rätt för användarbilder.

## Två fynd utöver tröskeln

**Skärmdumpar ligger i bilddatan.** Fyra av de 128 paren hade en skärmdump från
ikea.se eller jysk.se som ena sida (par 13, 55, 64, 145). De är annonsbilder i
databasen och embeddas som möbler. Det förorenar både bildsökningen och
kohorten.

**Sänggavlar klassas som `säng`.** Alla tre positiva säng-par är stoppade
sänggavlar, inte sängar. De är egentligen delar, och variantklassificeringen
borde troligen ha dem i `del/tillbehör`.

## 20 par att stickprova

Kontrollera gärna dessa — de är valda för att täcka besluten som betyder mest:
alla positiva par, plus de olika-par som ligger högst i likhet.

| par | möbeltyp | likhet | min etikett |
|---|---|---|---|
| 147 | hylla | 0,88 | samma_modell_annan_variant |
| 174 | byrå | 0,88 | samma_modell_annan_variant |
| 50 | fåtölj | 0,89 | samma_modell_annan_variant |
| 199 | säng | 0,85 | samma_modell_annan_variant |
| 23 | soffa | 0,85 | samma_modell_annan_variant |
| 125 | stol | 0,84 | samma_modell_annan_variant |
| 172 | byrå | 0,79 | samma_variant |
| 196 | säng | 0,79 | samma_modell_annan_variant |
| 21 | soffa | 0,77 | samma_modell_annan_variant |
| 47 | fåtölj | 0,77 | samma_variant |
| 200 | säng | 0,76 | samma_modell_annan_variant |
| 124 | stol | 0,76 | samma_modell_annan_variant |
| 122 | stol | 0,75 | samma_modell_annan_variant |
| 16 | soffa | 0,68 | samma_variant |
| 96 | matgrupp | 0,82 | olika |
| 98 | matgrupp | 0,82 | olika |
| 74 | bord | 0,81 | olika |
| 75 | bord | 0,81 | olika |
| 171 | byrå | 0,83 | olika |
| 46 | fåtölj | 0,79 | olika |

De sex sista är de viktigaste att kontrollera: har jag fel där, och de faktiskt
är samma möbler, faller slutsatsen om bord och matgrupp.

## Filer

- `image_pairs/image_pairs.csv` — de 200 valda paren, återskapbara med frö 20260806
- `image_pairs/image_pairs_labeled.csv` — de 128 märkta, med motivering per par
- `image_pairs/ark_01.jpg` … `ark_34.jpg` — kontaktkartorna jag tittade på
- `image_pairs/analys.json` — fullständig statistik
- `build_image_pairs.py`, `analyse_image_pairs.py` — omkörbart

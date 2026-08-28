# Mall och checklista för nya facit-möbler

De 22 befintliga möblerna är **förbrukade som bevis**. Golvet, taxonomin,
storleksnivån och shrinkage-vikten har alla justerats medan de användes, så
siffror mätta på dem är optimistiska. Den här mallen finns för att nästa mängd
ska kunna bära ett ärligt tal.

## Vad varje fall behöver

Fyll en CSV eller JSON med en rad per möbel. Endast fyra fält är obligatoriska.

| fält | krav | varför |
|---|---|---|
| `nr` | ja | Identifierare i rapporterna |
| `brand` | **tomt om det inte finns** | Ett tomt märke är ett giltigt och viktigt fall — det är ekbordsklassen. Gissa aldrig ett märke. |
| `model` | **tomt om det inte finns** | Skriv modellnamnet, inte produktrubriken. `Söderhamn`, inte `Söderhamn bäddsoffa 3-sits` — de extra orden kollapsade sökningen från 2 853 träffar till 2. |
| `facit_low`, `facit_high` | ja | Godkänt prisintervall i kronor |
| `variant` | om känd | Möbeltyp *eller* storlek: `hörnsoffa`, `3-sits`, `Bord och 4 stolar`. Harnessen läser storleken härifrån. |
| `condition` | om känd | Påverkar inget i dag (`CONDITION_PRICING = False`) men sparas för när skicket slås på |
| `img` | starkt önskvärt | Filnamn relativt bildmappen. Utan bild kan varken typröstningen, ledorden eller den visuella kohorten prövas. |
| `note` | valfritt | Fritext: varför fallet är svårt, vad du vet som motorn inte vet |

### Exempel

```csv
nr,brand,model,variant,condition,facit_low,facit_high,img,note
1,IKEA,Kivik,2-sits,Bra skick,1000,1800,kivik_2sits.jpg,liten variant av vanlig modell
2,IKEA,Kivik,5-sits,Bra skick,3500,6000,kivik_5sits.jpg,samma modell som 1 men stor
3,,,matgrupp,Okej skick,1500,2500,matgrupp_ek.jpg,inget märke syns någonstans
```

Bilderna läggs i en mapp och pekas ut med `--images`, eller anges direkt i
`img`-kolumnen som relativ sökväg.

## Sammansättningskrav

Mängden ska vara 20–30 fall och täcka de felklasser motorn faktiskt har. Utan
detta mäter man bara det som redan fungerar.

| krav | antal | varför just detta |
|---|---|---|
| **Storleksvarianter av samma modell** | ≥ 5 | Prisspridningen inom variant har median 78 %. Ett par som `Kivik 2-sits` (1 250 kr) och `Kivik 5-sits` (4 900 kr) prövar storleksnivån — den enda nivån som ännu är omätt på skarpa fall. |
| **Anonyma utan modellnamn** | ≥ 5 | Ekbordsklassen. Prövar identitetsspärren, den visuella kohorten och spridningsvarningen. |
| **Low-end** | ≥ 5 | Auktionsdatans kanalgap är −0,42 för billiga möbler, och studierna levererar design med hög trovärdighet men low-end med förbehåll. |
| **Tunt underlag (< 20 träffar)** | ≥ 3 | Prövar shrinkage och filtergolvet. Kinnarps-fallet var enda befintliga. |
| **Dubbelmarknad** | ≥ 1 | Kontorsmöbler säljs både som begagnat och som nyvara till företag. `auto`-basvalet väljer där mellan två marknader. |

`evaluate_examples.py --check-composition` räknar av listan mot kraven och
säger vilka som fattas innan du kör mätningen.

## Frysregler — icke förhandlingsbara

1. **Inga trösklar, golv, taxonomiregler eller k-värden får justeras mot denna
   mängd.** Inte ett värde, inte "bara för att se".
2. **Hittas ett fel och fixas är mängden förbrukad.** Nästa verifiering kräver
   nya fall. Ett fel får gärna fixas — men då är siffran på den mängden inte
   längre ett oberoende mått.
3. **Rapportering sker per felklass**, inte som en totalsiffra. Svält, storlek,
   ekbord och övrigt är olika problem med olika åtgärder, och en totalsiffra
   döljer vilken som återstår.
4. Mängden körs i **båda lägena** — text och text+bild. Skillnaden mellan dem
   är måttet på vad bilden bidrar med.

Reglerna finns i kod: `evaluate_examples.py --frozen` skriver en hash av
specfilen till resultatet, så att en ändrad mängd inte tysta kan förväxlas med
den ursprungliga.

## Varför de gamla 22 inte räcker

| justering | mängden den gjordes mot |
|---|---|
| `FALLBACK_SHRINKAGE_K = 6` | svept mot de 11 första |
| `matbord`/`matgrupp`-delningen | motiverad av Mio Santos |
| `MIN_COMPARISON_SET = 30` | valt teoretiskt, men verifierat mot båda mängderna |
| storleksnivån | motiverad av Mio Town och Kivik-mätningen |
| identitetsspärren | motiverad av Ekbord och Matgrupp |

Bara golvet på 30 valdes utan att titta på testmängderna. Allt annat har sett
dem, och därför är 100 % / 90,9 % ett tak snarare än en skattning.

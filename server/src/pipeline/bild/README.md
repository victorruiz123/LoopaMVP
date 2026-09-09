# Produktbild

Säljarens foto in — en produktbild ut, med möbelns egna pixlar orörda.

```
originals/<säljarens fil>          rörs aldrig
  → segmentera.ts   modellen svarar: hur mycket möbel per pixel
  → kant.ts         snäpp mot bildens kanter, öar bort, rummets färg ur kantbandet
  → kvalitet.ts     sju mått, varav två invarianter
  → komposition.ts  beskärning, skala, duk, kontaktskugga
```

Annonsen bär upp till FEM sådana bilder, inte en. En vy säljer inte en begagnad möbel: den som
funderar på en soffa för sex tusen vill se ryggen, sitsen och benen, och den frågan besvaras annars
av en mejlkonversation eller inte alls. Rutorna är redan filmade.

Galleriets bilder ligger mot rent vitt. FÖRSTA bilden — annonsens ansikte — står i stället i en
studio: ett tomt golv och en vägg, samma pixlar under varje annons i butiken. Se `studio.ts`.

Gränssnittet är `bearbetaMobelbild(bild, { studio })` (även exporterad som `processFurnitureImage`) i
`produktbild.ts`, som ger `{ processedImage, studioImage, transparent, mask, qualityScore,
needsReview, metadata }`. På jobbnivå: `byggOmslag()` i `omslag.ts`, som väljer rutorna, bygger
galleriet och skriver filerna.

## Ingen generativ modell rör möbeln

Det som frågas en modell OM MÖBELN är EN sak: vilka pixlar som är möbel. Färg, form, material,
slitage och skador kommer från säljarens egen fil och går orörda igenom.

Studiobakgrunden är ritad av en bildmodell, och den är undantaget som inte är ett undantag: modellen
ritade ett TOMT RUM, en gång, till en incheckad fil. Möbeln läggs ovanpå den av samma aritmetik som
lade den mot vitt. Skillnaden mot ett vitt fält är vad som ligger BAKOM urklippet, aldrig vad som är
i det. Det kontrolleras mätbart i varje körning — `fargdrift` ska vara 0 och `inreOrord` ska vara 1 —
och ett brott mot dem stoppar bilden. Ett löfte som bara hålls av att koden är rätt är ett löfte
tills någon ändrar i koden.

Enda stället kedjan skriver i färgkanaler är `dekontaminera` i `kant.ts`, och bara där alfa säger att
pixeln är en BLANDNING av möbel och rum (0,02 < α < 0,98) — alltså pixlar som aldrig bar möbelns
riktiga färg. Utan det steget får varje urklipp en rand av rummets färg mot det vita.

## Modellvalet: mätt, inte läst

Publicerade siffror gick inte att använda. Varje bakgrundsborttagningsmodell rapporterar sina mått på
DIS5K eller COCO — djur, människor och produkter mot rena bakgrunder. Loopa får mobilfoton av en
soffa i ett stökigt vardagsrum. Benchmarken (`npx tsx scripts/bild-bench.ts`) kör därför alla modeller
över riktiga säljarfoton ur `server/data/jobs`.

12 bilder, 12 olika jobb, 2026-09-06, på processor:

| modell | byggda | granskning | median | poäng | band | invariantbrott |
|---|---|---|---|---|---|---|
| u2netp | 12/12 | 1 | 5,0 s | 0,49 | 0,20 | 0 |
| u2net | 12/12 | 0 | 5,4 s | 0,65 | 0,10 | 0 |
| isnet-general-use | 12/12 | 2 | 9,2 s | 0,55 | 0,18 | 0 |
| **birefnet-general** | 12/12 | 1 | **74,4 s** | **0,70** | **0,07** | 0 |

`band` är andelen av möbelytan som är halvtransparent — alltså hur obeslutsam masken är. Det är det
mått som bäst förutsäger om en människa ser att bakgrunden tagits bort, och BiRefNet är dubbelt så
bestämd som tvåan.

**ISNet hamnade under u2net**, tvärtemot sina publicerade siffror. På en soffa framför en likadan
soffa mot en beige vägg gav den 1,4 % säkert-möbel och 40,8 % osäkert — en dimma. BiRefNet gav 40,2 %
säkert och 0,3 % osäkert på samma bild, och tog rätt soffa. Det är hela skälet den här tabellen finns
i stället för ett modellnamn hämtat ur ett papper.

Priset är femton gånger tiden. Det är rätt pris här: omslaget byggs utanför säljarens väntan (se
`pipeline/run.ts`), och en mask som tappar ett bordsben är dyrare än en minut.

### Vad som inte står i registret, och varför

- **SAM 2 / SAM 3 / Grounded SAM** svarar på fel fråga. De pekar ut vilket FÖREMÅL som menas, med en
  binär mask. Ett urklipp mot vitt behöver motsatsen — en mjuk alfakanal längs kanten, för det är den
  som avgör om en fransad tygkant ser klippt eller riktig ut.
- **RMBG-1.4 (BRIA)** är den enda som mätbart tävlar med BiRefNet, och licensen är BRIA:s egen,
  icke-kommersiell utan avtal. Loopa säljer möbler. Den står inte i registret alls — en modell i
  registret är en modell någon kan råka sätta i drift.
- **rembg** är inte en modell utan ett pythonbibliotek som kör precis de ONNX-filer som står i
  registret. Vi kör dem redan, i noden vi ändå har.

## Kvalitetskontroll

`kvalitet.ts` mäter RESULTATET, inte modellens självförtroende: en modell som pekat ut en matta i
stället för en soffa är precis lika säker som när den har rätt.

Sju mått — täckning, beskuren, band, fragment, benförlust, färgdrift, inre orörd. Faller något
sätts `needsReview`. Bilden byggs och sparas ändå (en människa ska kunna öppna den bredvid
originalet) men går inte ut publikt av sig själv. Den frågan ställs på ETT ställe: `harGodkantOmslag`
i `omslag.ts`, som både kortet, butikens rutnät och serverporten frågar — och `publikaGalleribilder`
bredvid den, som ställer samma krav per galleribild. En flaggad vinkel faller ur bläddringen för sig;
ett flaggat OMSLAG tar hela galleriet med sig, för en bläddring som börjar i en bild vi inte står för
är värre än ingen bläddring.

Lista de flaggade: `npx tsx scripts/bygg-produktbilder.ts --granska`

## Filer per jobb

```
originals/<säljarens fil>   rörs aldrig
cover/cover.jpg             OMSLAGET: möbeln i studion, 1600×1600
cover/galleri/1.jpg         samma bildruta som omslaget, mot rent vitt
cover/galleri/2..N.jpg      annonsens övriga vinklar, mot rent vitt
cover/transparent.png       omslagets möbel utan bakgrund, mot vilken botten som helst
cover/mask.png              omslagets silhuett
cover/produktbild.json      modell, mått, kvalitetsdom, tid — per byggd bild
```

`cover.jpg` och `galleri/1.jpg` är samma möbel på samma plats med olika botten. Den vita finns kvar
som reserv: går studiobakgrunden förlorad ligger den redan byggd, utan ett nytt modellvarv.

## Studiobakgrunden

En enda incheckad fil, `server/assets/studio/`, med sin prompt i sidofilen bredvid. Gör om den med

```
npx tsx scripts/studiobakgrund.ts --prov          # några förslag att titta på
npx tsx scripts/studiobakgrund.ts --valj bench/studio/forslag-1.jpg
```

Fogen mellan vägg och golv MÅSTE ligga ovanför möbelns nederkant (0,925 av rutan), annars står
möbeln på väggen. Höjden mäts på förslaget och ett som ligger fel underkänns — se `studio.ts`.
Saknas filen byggs omslaget mot vitt, precis som innan studion fanns.

## Att byta modell

En rad: `PRODUKTBILD_MODELL=isnet-general-use`. Registret i `modeller.ts` bär indatasida,
normalisering, passform och hur utdata läses; `segmentera.ts` vet ingenting om vilken modell den kör.
Saknas den valda filen faller koden nedåt genom `RESERVKEDJA` — sämre bild, aldrig ett kraschat jobb.

Hämta filerna: `./scripts/fetch-models.sh` (drift) eller `--alla` (även jämförelsemodellerna).

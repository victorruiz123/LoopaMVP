# Röstrundan (Voice Tour) — plan och prototyp

Fristående inspelningsläge: säljaren filmar **upp till tre möbler i EN sammanhängande film**, berättar
kort om varje möbel medan de går runt den, zoomar in på skador och pratar samtidigt — och det som sägs
blir ledtrådar till skickmotorn så att skadorna blir lättare att hitta.

Byggd som en **helt egen sida i MVP:n**, avskild från det skarpa flödet, så att den kan testas när som
helst utan att röra något annat:

```
web/voicetour.html            <- öppnas på https://localhost:5190/voicetour.html
web/src/__dev/voice-tour.tsx  <- hela sidan, självständig (samma mönster som dim.html/wait.html)
server/src/voiceTour.ts       <- POST /api/voice-tour/transcribe (Aqua Voice-proxy)
```

## Så fungerar den

```
säljaren trycker "Starta rundan"
  |  EN kamerasession, EN kontinuerlig ljudinspelning (hela rundan)
  |  EN videoinspelning PER MÖBEL (klipps osynligt vid "Nästa möbel")
  v
möbel 1: gå runt, berätta ("ekbord från 60-talet, lite slitet...")
  |  vid en skada: GÅ NÄRA med kameran och beskriv den. Ingen knapp —
  |  transkriptets tidsstämplar pekar ut när skadan beskrevs, och bild-
  |  rutan vid den tidpunkten plockas ur klippet som närbild i efterhand
  v
"Nästa möbel" -> möbel 2 -> "Nästa möbel" -> möbel 3 -> "Avsluta"
  |
  v  efterbearbetning (allt lokalt + två API-anrop)
1. bildrutor per möbel via befintliga extractBestFrames() — oförändrad
2. hela rundans ljud -> Aqua Voice Avalon (verbose_json, segment-tidsstämplar)
3. transkriptet skivas per möbel via tidsfönstren, närbildscitat via skadestämplarna
4. ETT jobb per möbel: POST /api/jobs { images (närbilder + vyer, max 6), sellerNotes }
5. sidan pollar de 2-3 jobben och visar betyg + fynd sida vid sida
```

### Varför en videoinspelning per möbel, inte en som klipps efteråt

"Nästa möbel" stoppar den pågående `MediaRecorder` och startar nästa på samma kameraström — glappet är
~100 ms och säljaren märker inget. Vinsten är att **varje möbel blir en egen blob** som går rakt in i
den redan trimmade `extractBestFrames()` utan en enda ändring: tidsbuckets, skärpeval, deadline — allt
återanvänds per möbel i stället för att behöva bygga tidsfönster-klippning i `videoFrames.ts`.

Ljudet spelas däremot in i **en obruten inspelning för hela rundan** (eget `MediaRecorder` på bara
ljudspåret, `audio/webm;codecs=opus`, ~1 MB/min). Ett anrop till Aqua i stället för tre, och
segment-tidsstämplarna ligger i rundans globala tidslinje så att skivningen per möbel är ren aritmetik
mot möblernas start/slut-tider.

### Aqua Voice (Avalon API)

- `POST https://api.aquavoice.com/v1/audio/transcriptions`, OpenAI-kompatibelt. Modell `avalon-v1.5`,
  $0,39/ljudtimme, webm stöds, max 25 MiB / 1 h.
- **Batch, inte streaming** — API:t tar bara `stream=false`. Därför transkriberas rundan direkt när
  den avslutats, inte medan man pratar. Det passar pipelinen, som ändå är batch.
- `response_format=verbose_json` + `timestamp_granularities[]=segment` ger segment med `start`/`end`
  i sekunder — det som gör per-möbel-skivningen möjlig.
- `prompt`-fältet skickar ordförrådshintar ("repa, fläck, fanér, nopprig...") så svenska möbeltermer
  hörs rätt. `language=sv` sätts explicit.
- Nyckeln (`AQUA_API_KEY` i `server/.env`) ligger **bara på servern** — webbsidan anropar
  `/api/voice-tour/transcribe`, aldrig Aqua direkt. Utan nyckel svarar servern 503 med klartext,
  den hittar aldrig på ett transkript.

### Hur talet gör skadorna lättare att hitta

Jobbet får ett nytt, valfritt fält `sellerNotes` som följer med hela vägen till inspektionsprompten
(`server.ts -> jobStore -> run.ts -> inspect.ts`) och läggs som ett **eget, tydligt märkt block** —
inte inblandat i `productContext`, som semantiskt är produktfakta:

> Säljarens muntliga beskrivning under filmningen (transkriberad): "..."
> Använd den som ledtråd om VAR du ska titta extra noga. Beviskravet gäller oförändrat:
> rapportera bara det du ser i bilderna — hitta aldrig på ett fynd för att beskrivningen nämner det.

Formuleringen är medveten: inspektionsprompten är skriven strikt bevisbaserad
(`inspect.ts`), och en hint som fick modellen att rapportera osedda skador hade
förstört hela attestvärdet. Ledtråden styr *uppmärksamheten*, inte *slutsatsen*.

Närbilderna tas **automatiskt, utan knapp** — det var en knapp i första utkastet, struken efter test:
säljaren ska bara gå och prata, som i appens vanliga filmning. Segment i transkriptet som matchar en
skadeordlista (rep-, fläck, sprick-, slit-, fanér- ...) blir tidpunkter; bildrutan vid varje sådan
tidpunkt söks fram ur möbelns videoblob (max 2 per möbel, träffar närmare än 6 s ihopslagna) och
skickas som `source: "manual"` med `viewLabel: "närbild — säljaren beskrev en skada här"`. Citatet
läggs i `sellerNotes` kopplat till bilden. Instruktionen till säljaren bär logiken: "gå nära skadan
och beskriv den" — då ÄR bildrutan vid beskrivningsögonblicket en närbild.

**Utan `sellerNotes` är prompten byte-identisk med förut** — Gemini-cachen och regressionssviten
påverkas inte av att fältet finns.

## Ändringar i befintliga filer (alla additiva, valfria fält)

| Fil | Ändring |
|---|---|
| `server/src/server.ts` | `sellerNotes` i `CreateJobBody`, route för `/api/voice-tour/transcribe` |
| `server/src/jobStore.ts` | `sellerNotes` sparas på jobbet (så `retry` spelar upp den också) |
| `server/src/types.ts` | `sellerNotes?: string \| null` på `ConditionJob` |
| `server/src/pipeline/run.ts` | parametern vidare till `inspectFurniture` |
| `server/src/pipeline/inspect.ts` | det märkta blocket i user-prompten |
| `server/.env.example` | `AQUA_API_KEY` dokumenterad |

## "Hör den mig?" — återkopplingstrappan

Den svåraste UI-frågan i hela funktionen. Säljaren pratar med en telefon som inte svarar, och tror
man inte att den lyssnar slutar man berätta. Problemet är skarpast på **iPhone**, där live-igenkänning
är avstängd (den kapar mikrofonen från inspelningen) — där stod skärmen tidigare helt stilla.

Lösningen bygger därför på **ljudnivån**, som fungerar överallt, inte på taligenkänning. Fem steg,
i stigande grad av bevis:

| Steg | Vad det svarar på | Var |
|---|---|---|
| **Mikrofontest**, 5 s | "fungerar mikrofonen alls?" | startsidan, före filmning |
| **Nivåmätare** | "hör den mig just nu?" | filmningen, rör sig inom en bildruta |
| **Taltidslinje** | "sparas det?" | filmningen, en ruta per sekund |
| **Taltid**, "38 s tal" | "hur mycket har jag bidragit?" | filmningen, ackumulerad per möbel |
| **”Möbel 1 uppfattad: …”** | "vilka ORD hörde den?" | filmningen, medan nästa möbel filmas |

Det sista steget är det enda riktiga ordbeviset som går att ge på en iPhone, och det kommer av att
**transkriberingen startar så fort en möbel är färdigfilmad** i stället för när hela rundan är det.
Samma ändring kortar väntan efteråt: möbel 1 och 2 är redan transkriberade när stoppknappen trycks.

Kedjan avslutas på resultatkortet: transkriptet, raden "↳ skickades med som ledtråd till
besiktningen", och ✔/⚠-avstämningen. Hörd -> sparad -> förstådd -> **använd**.

Mikrofontestet finns för att felet det fångar är det dyraste i flödet: en tyst inspelning upptäcks
annars först efter tre filmade möbler, och då är rundan förlorad. Exakt det hände på iPhone innan
enspårsinspelningen kom på plats.

## Utseendet

Stilarna ligger i [`web/src/__dev/voice-tour.css`](web/src/__dev/voice-tour.css) och bygger **helt**
på tokens i `styles.css` — ingen egen palett, inga egna radier, inga egna typsnittssteg. En testbänk
som ser ut som något annat än appen mäter fel sak: intrycket av flödet är en del av det som ska
bedömas.

Tre beslut värda att känna till:

- **Startsidan är en numrerad lista, inte tre stycken.** Instruktionen läses en gång, stående i en
  möbelaffär. Siffrorna bär ordningen så texten slipper säga "sedan" och "därefter".
- **Mikrofontestet är en ljus, nedsänkt yta** — det låg en tid som en svart ruta mitt i det cremevita
  kortet, ett främmande föremål på sidan. Tillståndet bärs nu av tonade bakgrunder (grön/amber/röd
  ur paletten) i stället för av en svart låda.
- **Kameraöverläggen är frostat glas** (`backdrop-filter`), inte grå plattor: bildrutan ska fortsätta
  synas igenom, annars äter hörselpanelen upp den nedre tredjedelen av det säljaren filmar.

Nivåmätarens staplar är **grå när det är tyst och gröna när det hörs tal** — samma grönt som
taltidslinjen och skadekvittot. "Det här räknas" har en färg i hela flödet.

Designarbete här görs inte blint: `VOICE_TOUR_SHOT=x.png` på röktestet sparar resultatskärmen. En
knapp låg en gång med **vit text på vit botten** i flera omgångar innan någon tittade på den.

## Talet driver mer än skadeletningen

Tre saker till plockas ur det säljaren säger (ren logik i `web/src/__dev/voice-tour-logic.ts`,
testad i `tests/voice-tour-logic.test.ts`):

- **Märket.** Transkriptet matchas mot appens märkesregister (hela ord, längsta namn först,
  registrets stavning vinner) och skickas med jobbet — då startar backend modellsökningen ur
  bilderna, precis som när säljaren väljer märke på startsidan. "Märket räcker för att starta."
- **Avstämningen.** På resultatkortet ställs varje nämnd skada mot modellens fyndlista via en
  medvetet BRED ord→typ-mappning (repa -> scratch/scuff/abrasion/...): ✔ motsvarande skada
  rapporterad, ⚠ värd att dubbelkolla. En ⚠ är inte automatiskt en miss — "inga repor" är också
  ett skadeord i en mening — men den pekar ut exakt vad som ska granskas.
- **Röstkommandot "nästa möbel"** byter möbel utan knapptryck där taligenkänning är aktiv
  (inte iOS) — händerna är upptagna med kameran.

## Att testa själv

```bash
npm run server:dev     # AQUA_API_KEY i server/.env (annars 503 med förklaring)
npm run web:dev
# öppna https://localhost:5190/voicetour.html
```

Sidan är dev-only: den ligger inte i `vite build` (samma som `dim.html`), så den kan aldrig läcka ut
i produktion av misstag. Den autentiserar med maskinkontot — klistra in `CONDITION_SERVICE_KEY` ur
`server/.env` i nyckelfältet första gången (sparas i localStorage). Jobben den skapar ägs av
maskinkontot, precis som mätharnessens.

På telefon: samma som huvudappen — LAN-adressen kräver HTTPS-certet (`web/scripts/make-dev-cert.sh`),
och mikrofonen kräver säker kontext precis som kameran.

## Avgränsningar i v1 (medvetna)

- **Ingen realtidstranskribering** — Avalon är batch-only. Vill man se texten live senare är
  webbläsarens `SpeechRecognition` en gratis förhandsvisning, med Aqua som facit efteråt.
- **Märke/modell anges inte** i rundan, så prissättningen körs inte — det här är en skadedetektions-
  och flödestestbänk. Fälten kan läggas till per möbel på resultatvyn senare.
- **Max 3 möbler**, max 3 min runda (ljudfilen ska hålla sig långt under 25 MiB, och 6 bildrutor per
  möbel sätter ändå taket för vad en längre film tillför).
- **Digital zoom** via `track.applyConstraints({advanced:[{zoom}]})` fungerar på de flesta Android-
  telefoner i Chrome; där den saknas (iOS Safari) säger knappen åt en att gå närmare — närbilden tas
  ändå i full sensorupplösning.

## Röktestet: hela kedjan, utan att filma något

```bash
node tests/voice-tour-audio.mjs     # skriver talfilen (Windows egen talsyntes)
CONDITION_SERVICE_KEY=... node tests/voice-tour-e2e.mjs
```

Kör den riktiga sidan i en riktig webbläsare, med talfilen som mikrofon och Chromiums testbild som
kamera. Inget mockas: talet går till Aqua, transkriptet till märkesdetekteringen och skadeordlistan,
närbilden plockas ur den inspelade videon, jobbet körs genom Gemini. Kostar en Aqua-transkribering
och en Gemini-inspektion. Kräver `playwright-core` och en Chromium-binär (`PW_CHROMIUM`).

Första körningen (2026-09-07) gav alla kontroller gröna — och en sak till, viktigare än testet självt:

> Säljaren SA att det fanns en repa. Kameran visade en grön testbild. Modellen rapporterade **noll
> fynd**, och avstämningen flaggade ⚠ "ingen motsvarande skada rapporterad".

Ledtråden lockade alltså inte fram ett påhittat fynd. Det är hela poängen med formuleringen i
`inspect.ts`, den dyraste egenskapen att tappa i en framtida promptändring — och nu den billigaste
att upptäcka att man tappat.

Testet fångade också en bugg i `voiceTour.ts`: Avalon läser formatet ur **filändelsen** och svarade
400 på en wav som skickades som `tour.bin`. I drift är blobben alltid webm/mp4, så felet hade legat
dolt tills någon skickade något annat.

## Mätningen: gör talet någon skillnad?

Att ledtrådarna BORDE hjälpa är en hypotes. Mätningen finns:

```bash
npm run voice:impact -- --latest        # senaste röstrundejobbet
npm run voice:impact -- --all-voice     # varje jobb som har tal
```

Samma bildrutor, två körningar — en med `sellerNotes`, en utan — och fyndlistorna ställda mot
varandra. Kostar två riktiga Gemini-anrop per möbel.

Två saker mätningen **inte** kan, och som står i skriptets huvud också:

- **Bruset.** Gemini-cachen slår på modell + prompt + bildbytes. De två armarna har olika prompter
  och kan alltså inte förorena varandra — men samma arm körd igen träffar cachen och ger identiskt
  svar, så variationen mellan två identiska körningar går inte att mäta härifrån. En skillnad på
  ett fynd är en observation, inte en effekt.
- **Sanningen.** Ingen arm vet vad som faktiskt finns på möbeln. Fler fynd är inte självklart
  bättre — det kan vara talet som lockat fram en fabrikation, vilket är precis den risk
  ledtrådsblocket är formulerat för att motverka. Därför skrivs fyndlistorna ut i klartext:
  läs VILKA fynd som tillkom, inte hur många.

Kör den på möbler med skador på baksidor och undersidor — det är där uppmärksamhetsstyrningen
borde vara värd mest.

## Öppen post: närbilderna tränger ut vyer

Ett jobb får sex bilder (`MAX_IMAGES_PER_JOB`), och närbilderna läggs först. Två auto-närbilder
betyder alltså **fyra** varvsvyer i stället för sex — samma sorts kvalitetskostnad som README:s
öppna post om 8 -> 6 bildrutor, och lika omätt.

Bytet är rimligt på förhand: en närbild på en skada säljaren själv pekat ut borde bära mer
information än den sjätte vinkeln av en hel möbel. Men "borde" är inte mätt, och `voice:impact`
mäter det inte heller — den jämför med och utan TAL, inte med och utan närbilder. Mätningen som
stänger posten är en tredje arm: samma film, samma tal, men bara varvsvyer.

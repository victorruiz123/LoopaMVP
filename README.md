# Loopa Condition

Besiktningsmotor för begagnade möbler: `ConditionInput -> ConditionResult`. Bilder in, ett A–F-betyg ut
tillsammans med en lista skador, var och en med typ, allvarlighetsgrad, påverkan och en markerad
bildruta som bevis.

Sedan 2026-08-27 är prismotorn under `Price_engine/` inkopplad i samma flöde: säljaren väljer märke och
skriver modellnamn, filmar ett varv, och får tillbaka skick, skador **och** prisförslag i ett svar. Skickmotorn
detekterar skadorna, prismotorn värderar dem — arbetsdelningen är hela poängen, och ingendera gör den
andras jobb.

Utbruten ur `vips-buy-sell-hub` (`experiments/condition-grading/`). Modulen var självständig redan där
— inga importer lämnade mappen — så inget behövde skrivas om vid flytten.

## Kör lokalt

```bash
npm run install:all          # rot + server + web

cp server/.env.example server/.env    # fyll i GEMINI_API_KEY
npm run server:dev           # backend på http://localhost:8799
npm run price:dev            # prismotorn på http://127.0.0.1:8000
npm run web:dev              # frontend på https://localhost:5190
```

`price:dev` startar prismotorn ur `Price_engine/Price_engine` med dess egen `.venv`, pekad mot korpusen i
`Price_engine/vips-ml-data/vips-fas0` och med `PRICE_ENGINE_DAMAGE=1` så skadeavdragen är på. **Första
uppstarten tar flera minuter** — 1,5 miljoner annonser städas och cachas, och bildmodellerna förvärms —
därefter läses allt ur `.cache/` på någon minut. Sökvägen till datan skickas absolut med flit: cachenyckeln
innehåller filens sökväg som *sträng*, så en relativ sökväg missar en cache som byggts absolut och städar
om alltihop.

Prismotorn är **valfri**. Är den inte igång blir svaret ett skickresultat utan pris, med orsaken utskriven i
gränssnittet — aldrig ett misslyckat jobb. Skanningen kostade en Gemini-körning; den får inte gå förlorad
för att en andra tjänst ligger nere.

Öppna **https://localhost:5190**. Webbservern kör HTTPS med självsignerat certifikat — webbläsaren
varnar en gång. Det behövs: kameran i webbläsaren (`getUserMedia`) kräver säker kontext, och utan den
fungerar bara filuppladdning.

Backend binder mot `127.0.0.1`. Frontend når den via vites proxy, så en telefon på samma nät kan använda
appen via datorns nätverksadress utan att backend ligger öppen.

## Miljövariabler

Alla i `server/.env`, se `server/.env.example`.

| Variabel | Krävs | Vad |
|---|---|---|
| `GEMINI_API_KEY` | ja | Nyckel från [Google AI Studio](https://aistudio.google.com/apikey). Utan den vägrar servern analysera — den hittar aldrig på resultat. |
| `CONDITION_API_KEY` | för API:t | Delad hemlighet för `/v1/condition`. Saknas den svarar API:t 503 på allt; det startar aldrig öppet. Generera med `openssl rand -hex 32`. |
| `PORT` | nej | Backendport, standard 8799. |
| `PRICE_ENGINE_URL` | nej | Prismotorns adress, standard `http://127.0.0.1:8000`. |
| `PRICE_ENGINE_API_KEY` | nej | Bara om prismotorn startats med en nyckel satt. |
| `PRICE_ENGINE_TIMEOUT_MS` | nej | Hur länge vi väntar på ett prissvar, standard 45000. |
| `PRICE_ENGINE_USE_IMAGE` | nej | `1` skickar en bildruta för möbeltypsklassning. Av som standard, se nedan. |

## Tester

```bash
npm test                     # 134 tester, inga API-anrop, ingen nyckel behövs
npm run baseline -- --check  # jämför fixturerna mot baseline.json
```

Sviten fryser pipelinen vid ingången till dedup, så den kör den deterministiska halvan — dedup och
betygsättning — mot inspelade och syntetiska fixturer. Den mäter inte promptändringar; de ligger
uppströms om fryspunkten och kräver riktiga körningar.

`npm run record -- --latest --furniture "namn"` gör en färdig körning till en ny fixtur.

## Pipeline

```
märke + modell ->  (bärs med hela vägen, används först i price)
bildrutor      ->  inspect    ett Gemini-anrop, hela möbeln, delsvep + skadelista
               ->  verify     andra besiktaren: granskar fynden och letar efter det som missades
               ->  dedup      lokalt skyddsnät mot dubbelrapportering
               ->  grade      deterministisk A-F, noll LLM
               ->  price      prismotorn: percentil över liknande annonser, minus skadeavdrag
```

Betyget är det sämre av två oberoende spår: de bekräftade skadorna, och en holistisk slitagebedömning.
Ingetdera kan förbättra det andra. A–F mappas till fyra publika strängar: Nyskick, Mycket bra skick,
Bra skick, Okej skick.

## Märkesväljaren

Startsidans två fält ligger i en **grupperad lista** — två rader som delar en yta och skiljs av ett
indraget hårstreck. Två rader i ett kort läser som ett formulär; två inramade boxar läser som två
separata beslut. Märkesraden är en knapp: tryck öppnar en bottensheet på 78 % av skärmhöjden med
sökruta och "Populära märken". Arket går att **dra ned för att stänga** — greppet sitter bara på
handtaget och rubriken, eftersom lyssnande på hela arket hade gjort varje listsvep till en
halvstängning.

Två listor bakom rutan, och båda behövs:

- **Startlistan**, [`web/src/lib/brandSeed.ts`](web/src/lib/brandSeed.ts) — 24 märken, handplockad. En
  startvy ska gå att överblicka, inte scrollas igenom.
- **Sökregistret**, startlistan unionerad med [`web/src/lib/brands.ts`](web/src/lib/brands.ts) (204 märken
  mätta mot prismotorns korpus). Söker man söks allt igenom; startlistan är en genväg, inte ett register.

Unionen är inte kosmetisk. Skeidar, Norell Möbel och West Elm står i startlistan men saknas i korpusen,
och utan den gav en sökning på "west" noll träffar på ett märke som syntes i rutan ovanför. Åt andra
hållet stavar korpusen HAY som "Hay", så samma märke visades olika beroende på om man bläddrade eller
sökte — startlistans stavning vinner därför.

Hittas märket inte bär **tomtillståndet** den manuella vägen: sökningen innehåller redan det märket ska
heta, så "Använd 'Ekedalen Möbler'" räcker — inget eget fält, ingen lägesväxling. **Fritext blir ett
fullgott märke**; en tvingande lista hade gjort de kända märkena till en gräns för vad som går att
sälja, vilket det inte är.

Monogram, inte logotyper: riktiga märkeslogotyper kräver egna uppladdade assets med klarerad
upphovsrätt, och ett logotyp-API i stället (Clearbit och liknande) är både avvecklat och en extern
beroendekedja mitt i ett formulär som ska fungera i en möbelaffär med dålig täckning.

Listan är **genererad, inte skriven för hand**:

```bash
Price_engine/Price_engine/.venv/bin/python scripts/build_brands.py > web/src/lib/brands.ts
```

Medlemskapet har två källor: korpusens egen `brand`-kolumn (116 märken, alla tas med) och en
kandidatlista över kända möbel- och designnamn, som utelämnas när de saknar träffar i annonstexten. Ett
märke i väljaren som motorn inte hittar en enda annons för vore ett löfte vi inte kan hålla.

Antalet per märke mäts **på annonstexten för alla**, aldrig ur `brand`-kolumnen. Kolumnen är ifylld på
2,3 % av korpusen, så en sortering som blandade de två skalorna la IKEA (19 783 taggade rader) under en
designer med 33 000 textomnämnanden. Med samma skala för alla hamnar IKEA först, på 306 834.

Designernamn står med flit i samma lista — prismotorn söker i en textklump som innehåller
designerkolumnen, och på vintagemöbler *är* designern det annonsen säljs under.

Ett undantag hanteras explicit: **Sits** är både ett märke och ordet i "3-sits", och textmätningen ger
62 568 mot 104 taggade — kvot 0,07 mot en taggningsgrad på 2,3 %. Där används kolumnräkningen i stället.
Bruno Mathsson och Svenskt Tenn har liknande låga kvoter men står kvar på sin textmätning: de nämns
oftare i annonstext än korpusen bryr sig om att tagga dem, och det är riktig signal, inte en krock.

## Snabbheten

Tre mätta flaskhalsar, tre olika åtgärder. Alla siffror är körda mot en 30 s 1280x960-inspelning
respektive riktiga jobb, inte uppskattade.

### Bildruteuttaget: 12,8 s -> 4,0 s

Sökning var *hela* kostnaden — 345 ms per sökning, 40 sökningar. MediaRecorder skriver nästan inga
nyckelbildrutor, så varje `currentTime`-hopp avkodar framåt från en avlägsen nyckelruta och kastar
nästan allt. Att söka från fyra `<video>`-element parallellt gjorde det *långsammare* (14,2 s): fyra
avkodare trängs om samma kärnor och gör om samma arbete.

Rätt åtgärd var att sluta söka. `extractByPlayback` spelar klippet en gång i 16x fart och tar emot
varje bildruta via `requestVideoFrameCallback` — linjär avkodning, varje ruta avkodad exakt en gång.

| metod | tid | kandidater | medelskärpa |
|---|---|---|---|
| sökning, 40 kandidater | 12,8 s | 40 | 12,86 |
| uppspelning 4x | 7,5 s | 271 | 12,99 |
| uppspelning 8x | 4,8 s | 150 | 12,96 |
| **uppspelning 16x** | **3,7 s** | **93** | **12,91** |

Snabbare *och* skarpare, vilket inte är en avvägning: passet ser två till sju gånger fler kandidater
än de 40 sökversionen tog, så bästa-i-bucket väljs ur en större hög. Sökvägen finns kvar som reserv
och används när `requestVideoFrameCallback` saknas, uppspelning nekas, farten klampas under 3x eller
för få buckets fylls — den nya vägen kan alltså bara bli en förbättring.

#### Tidsbudgeten

Första versionen av det här kunde ta flera minuter, av tre fel som multiplicerade varandra:

1. Uppspelningen avbröts på en **förutsägelse** — "det här borde ha tagit 13,5 s" — och kastade varje
   bildruta den redan avkodat. En avkodare som bara är långsammare än gissningen gör ändå framsteg.
2. Sedan kördes ett **helt nytt 40-sökningssvep** ovanpå. Faserna lades ihop; en budget som får
   spenderas två gånger är ingen budget.
3. Varje sökning hade **8 sekunders timeout**. 40 × 8 = 320 sekunder i värsta fall.

Nu gäller **en delad deadline** för hela modulen. Uppspelningen slutar när filmen tar slut, när
avkodaren stannat (ingen bildruta på 2,5 s) eller när deadline passerats — aldrig på en gissning, och
den behåller alltid det den hunnit. Sökning **fyller bara hål**, bredd först: mitten av varje saknad
bucket innan någon bucket får en andra kandidat, så täckningen av möbeln säkras före skärpan inom en
vy. Extra kandidater köps bara för tid som ryms i målbudgeten på 5 s, prövat per sökning.

`openVideo` var dessutom modulens sista obundna väntan: `loadedmetadata` är inte garanterad att komma,
och en container webbläsaren halvt känner igen kunde lämna elementet utan både event och fel. "Bearbetar
video…" i evighet är det värsta felet i hela inspelningsflödet, eftersom varvet redan är filmat.

Mätt, 51 s / 1920x1440:

| väg | tid | vyer |
|---|---|---|
| uppspelning (normalfallet) | 3,7 s | 8/8 |
| utan `requestVideoFrameCallback` | 5,2 s | 8/8 |
| uppspelning nekad | 5,3 s | 8/8 |
| farten klampad till 1x (Safari-liknande) | 5,2 s | 8/8 |
| absolut tak | 20 s | — |
| trasig fil | 0,01 s | fel |

Uttaget loggar numera vilken väg det tog (`[videoFrames] playback · 3.5s · 8/8 vyer · 61 bildrutor
sedda · fart 16x`) och visar samma rad på granskningsskärmen, så en seg körning går att felsöka utan
att bygga om något.

**Priset:** urvalet är inte längre bitidentiskt mellan körningar. Vilka rutor som *presenteras*
varierar någon millisekund, så samma film kan ge något olika bildrutor. Sökvägen var deterministisk.
Testsviten fryser på post-verifierade defekter och berörs inte, men en omkörning av samma *film*
träffar inte längre Gemini-cachen. Ett omtag på ett jobb gör det, eftersom det spelar upp de sparade
bildrutorna.

### Priset går parallellt med filmningen

Prismotorn behövde aldrig videon: den söker i annonskorpusen på märke och modell, och skadelistan är
ett avdrag som läggs på efteråt. `POST /api/price` svarar därför på de två fälten ensamma. Appen
startar den frågan i samma ögonblick som säljaren lämnar startsidan, medan de går sitt varv.

Prismotorn svarar på 5-11 s. En varvfilmning tar 30-40. Priset står alltså färdigt när prisvyn
öppnas, och säljaren väntar noll sekunder på det.

Skärmordningen följer av det: pris först, skick sedan. Prisvyn säger rakt ut att siffran är *före*
skickbedömning — en siffra som tyst sjunker mellan två skärmar läser som ett svek även när den är
riktigare.

### Skicket publiceras i två steg

Granskningen förbättrar fyndlistan men är inte ett villkor för den — faller den bort behålls fynden
som de rapporterades. Alltså finns det ett giltigt svar redan när huvudinspektionen är klar, och att
hålla det inne gav säljaren en spinner i stället för sitt resultat.

`run.ts` publicerar därför resultatet två gånger: ett delresultat direkt efter inspektionen, märkt
`reviewPending`, och det slutgiltiga när granskningen och prissättningen landat. Mätt på ett ocachat
jobb med fem bilder:

```
delresultat publicerat   55,1 s   (huvudinspektionen tog 54,9 s — Gemini under last)
slutresultat             75,4 s   (granskning 15,1 s + prissättning)
```

**20,3 sekunder tidigare.** Slutresultatet är oförändrat; det är väntetiden fram till första svaret
som försvinner. Resultatvyn visar en banner medan granskningen pågår och uppdaterar sig själv när den
landar.

Dessutom laddas bilder och beskärningar numera parallellt i `inspect.ts` och `verify.ts` i stället
för i tur och ordning — tio fynd betydde tio `sharp`-anrop efter varandra innan granskningen kunde
börja.

### Öppen post: 8 -> 6 bildrutor

Videovägen valde åtta vyer fram till 2026-08-28 och väljer sex sedan dess. Ändringen är gjord på

- en **uppskattad** tidsvinst: ~8 s, interpolerad ur två mätpunkter (4 bildrutor -> 21,2 s,
  8 bildrutor -> 36,9 s). Sexbildersfallet är aldrig mätt — båda försöken slog i Gemini 503.
- en **omätt** kvalitetskostnad: två vyer färre av möbeln. En skada som bara syns från ett håll har
  färre chanser att hamna i en vald bildruta, och exakt hur mycket färre vet vi inte.

Det här är alltså en skuld, inte ett avklarat beslut. `npm run fixture:add -- <film> --label X
--compare-frames 6,8` är mätningen som stänger den: samma film genom pipelinen två gånger i samma
sittning, plus en tredje körning som ger brusnivån. Kör den på inspelningsdagen, på möbler med
skador på baksidor och undersidor — det är där två vyer färre borde märkas, och det är precis vad
dagens fixturunderlag (fem möbler, betyg A-C, inga strukturella eller funktionella skador) saknar.

Fixturerna bär `frame_count` så att gamla åttabildersskörningar inte tyst blandas ihop med nya
sexbilders i en kvalitetssiffra. De sexton befintliga inspelade är inspelade med åtta vyer, men bara
två går att **belägga** — källjobben är raderade och bevisen ger bara en undre gräns. De övriga
fjorton står som `unknown` hellre än som ett antagande förklätt till mätning.

### Att återställa

Läget före det här arbetet ligger som tagg:

```bash
git reset --hard pre-speedup
```

## När analysen faller

Anropen mot Gemini gör ETT försök på primärmodellen och ett på reservmodellen — ingen backoff-kedja,
enligt `gemini.ts`. Slår båda fel är körningen slut, och det inträffar: 2026-08-27 svarade båda
modellerna 504 `DEADLINE_EXCEEDED` på en riktig skanning, och samma bilder gick igenom utan problem
minuter senare.

Två saker ska hända då, och gjorde det inte förut:

- **Bildrutorna ska överleva.** Jobbet bär sedan dess sin egen `images`-lista, sparad vid skapandet i
  stället för bara i det färdiga resultatet. Förut låg filerna kvar på disk men ingenting sa vilka de
  var, så enda vägen framåt var att filma om — för ett fel som aldrig var säljarens.
  `POST /api/jobs/:id/retry` spelar upp exakt de bildrutorna igen; identiska bilder träffar dessutom
  Gemini-cachen för den del av körningen som hann lyckas, så ett omtag är billigare än förstaförsöket.
  Ett jobb från före ändringen saknar listan och svarar 409 i stället för att låtsas.
- **Felet ska gå att förstå.** Analysvyn visade `job.error` ordagrant, alltså
  `{"error":{"code":504,...}}` rakt i ansiktet på säljaren. `web/src/lib/errors.ts` översätter i stället
  till vad som hände, om det var deras fel och vad de ska göra — och döljer knappen "Försök igen" när ett
  omtag omöjligt kan hjälpa, som vid en saknad API-nyckel. Råtexten finns kvar under "Tekniska detaljer".

## Truth-cardet

Tredje motorn i flödet: `loopa-landing-page-main` tar bildrutorna och märket och letar upp VAD möbeln
är — exakt modell, mått, material, nypris — och skriver en färdig annonstext, med källor.

Den **anropas, inte kopieras**. `functions/api/seller/generate.ts` är en Cloudflare Pages Function men
skriven mot webbstandard: den tar en `Request`, returnerar en `Response` och läser sin enda hemlighet
ur ett `env`-objekt den får in. Node har allt det globalt, så
[`server/src/listing.ts`](server/src/listing.ts) anropar handlern rakt av. En portad kopia hade
fungerat i dag och glidit isär i morgon.

Sökvägen byggs vid körning med flit: en statisk import hade dragit in landningssidans egen
TypeScript-uppsättning i skickmotorns typkontroll utan att tillföra något — kontraktet i `types.ts` är
ändå vårt eget.

### Tre grenar, en körning

```
bildrutor + märke ─┬─ inspect → verify → grade ──┐
                   │                             ├─ price (behöver skadelistan)
                   └─ annonsgenerator ───────────┘
```

Annonsgeneratorn behöver bara bildrutorna och märket — inte betyget, inte skadelistan. Den startar
därför samtidigt som besiktningen och väntas in allra sist. Kedjad efter besiktningen hade den lagt
sina 15–26 sekunder ovanpå i stället för bredvid.

Resultatet publiceras i tre steg: delresultat efter inspektionen, skick + pris efter granskningen, och
annonsen när den landar. Den sista publiceringen väntar inte in de andra och tvärtom — den långsammaste
grenen får inte sätta allas tempo.

Faller besiktningen medan generatorn lyckas sparas annonsen ändå på jobbet. Grenarna delar inga
anrop, och ett Gemini-avbrott i den ena ska inte kasta arbete den andra redan betalat för.

### Ordningen på skärmen

**Pris → skick → truth-card.** Priset visas först men räknas *sist*: prismotorn drar av för skadorna,
så en siffra hämtad innan skickgraderingen är klar är en annan siffra än den riktiga. Prisvyn väntar
därför in `reviewPending: false` innan den visar något tal alls. Ett preliminärt pris som sedan sjunker
läser som ett svek även när det är riktigare.

Generatorn svarar hellre degraderat än med fel — `status` säger `full`, `partial` eller `fallback`, och
truth-cardet visar det på kortet i stället för i en fotnot. En annons där måtten är gissade ska inte se
likadan ut som en där de har en källa.

## Prissättningen

Prismotorn **detekterar aldrig** en skada. Den tar emot skadelistan skickmotorn redan bekräftat och
värderar den — det är den arbetsdelning `Price_engine/Price_engine/price_engine/damage_pricing.py` är
byggd kring, och den enda som håller: en språkmodell kan se en fläck på ett foto, men inte vad den gör med
priset på svenska andrahandsmarknaden.

Kopplingen ligger i [`server/src/pricing.ts`](server/src/pricing.ts):

- **Skadetyp → avdragskategori** är avsiktligt *partiell*. Femton av skickmotorns typer har en entydig
  motsvarighet i prismotorns tabell och skickas färdigmappade (`matchedBy: "condition-system"`, vilket
  motorn passerar orört genom sin `normalise`). Resten skickas som svensk fritext och lämnas till motorns
  egen synonymmatchning. En felaktig kategori är sämre än ingen — den flyttar riktiga pengar på en gissning.
  `scratch` blir `repa_skinn` i stället för `repa_hard` när delen eller beskrivningen nämner skinn eller
  läder; en skinnrepa är en annan tabellrad och kostar flera gånger så mycket.
- **S1–S4 → 0/1/2.** S1 hamnar på 0, under motorns väsentlighetströskel: fyndet listas och sänker
  *skicket*, men rör inte priset. Det är motorns regel, inte vår — "AI:n ser mer än köparen bryr sig om".
- **Bara det som räknas.** Samma urval som betyget använder: säljarens `rejected` faller bort, `confirmed`
  och `corrected` räknas, i övrigt gäller verifieringens `CONFIRMED`.
- **Ingen bild skickas med — avsiktligt, och mätt.** Modellnamnet ensamt pinnar inte ner möbeltypen —
  "Landskrona" spänner över soffa, hörnsoffa, fåtölj och fotpall — men prismotorns typsystem härleder den
  redan ur namnet (`derivedType: soffa`, med bäddsoffa/hörnsoffa kvar som kandidater). Att i stället
  skicka en bildruta får motorn att klassificera typen med ett externt LLM-anrop som dess klient bygger
  **utan timeout och med två omförsök**: samma fråga svarade på under en sekund utan bild och hade efter
  tre minuter inte svarat med. Sätt `PRICE_ENGINE_USE_IMAGE=1` för att slå på det igen när det anropet
  fått en gräns på Python-sidan. Bildomsorteringen (DINOv2) är avstängd oavsett; den är ett tyngre pass
  igen och tillför inget här.

Säljarens korrigeringar räknar om **båda** halvorna. `regradeAndReprice` i
[`server/src/server.ts`](server/src/server.ts) är den enda vägen tillbaka från alla fyra
korrigeringsendpoints, så betyg och pris kan inte glida isär — felläget där en bortplockad skada försvinner
ur betyget men fortfarande dras av från priset finns inte.

Går prismotorn inte att nå vid en omräkning behålls det gamla priset med en notering. Ett inaktuellt tal
med en förklaring är bättre än att blanka ut ett tal säljaren redan tittade på.

## API

`POST /v1/condition` och `GET /v1/condition/:id`, autentiserade med `x-api-key`. Samma pipeline som
appen — båda går genom samma funktion, så de kan inte glida isär.

```bash
curl -X POST http://localhost:8799/v1/condition \
  -H "x-api-key: $CONDITION_API_KEY" -H "Content-Type: application/json" \
  -d '{"brand":"IKEA","model":"Landskrona 3-sits",
       "images":[{"dataUrl":"data:image/jpeg;base64,...","source":"video"}]}'
```

---

<details>\n<summary>Ursprunglig README från vips-buy-sell-hub</summary>\n\n# Condition Grading — MVP (V3)

Standalone, isolated engine: `ConditionInput -> ConditionResult`. Does not import from Visual Discovery,
Pricing, Truth Engine, or the Vips Matcher. Lives entirely under this folder.

- `server/` — Node/TS backend (no framework, matches `ai-backend`/`truth-engine` convention). Calls
  Gemini directly server-side via `@google/genai`. Never exposes `GEMINI_API_KEY` to the browser.
- `web/` — small standalone Vite/React frontend for local testing (capture → analysis → result → evidence
  → seller corrections).
- `reference/hannes-prototype.mp4` — UX reference video (not reproduced code).

## Setup

```bash
cd experiments/condition-grading/server
npm install
cp .env.example .env   # then fill in GEMINI_API_KEY (https://aistudio.google.com/apikey)
npm run dev            # http://localhost:8799

# in a second terminal
cd experiments/condition-grading/web
npm install
npm run dev             # http://localhost:5190
```

Open **http://localhost:5190** in your browser (use a phone on the same network/Tailscale, or your laptop
webcam). Camera access requires `localhost`, HTTPS, or a Tailscale-served host — a plain LAN IP will be
blocked by the browser. `vite.config.ts`'s `allowedHosts` already includes the project's Tailscale host.

If `GEMINI_API_KEY` is missing, the server logs a warning on startup and any analysis request will fail
with a clear error — it never fabricates results.

## API

`/v1/condition` kör exakt samma pipeline som appen — båda går genom `createConditionJob`, så de kan inte
glida isär. Autentiseras med `x-api-key` mot `CONDITION_API_KEY` i `server/.env`. Utan nyckel i miljön
svarar API:t 503 på allt; det startar aldrig öppet.

```bash
# starta en bedömning — bilderna är data-URL:er, redan utvalda av anroparen
curl -X POST http://localhost:8799/v1/condition \
  -H "x-api-key: $CONDITION_API_KEY" -H "Content-Type: application/json" \
  -d '{"brand":"IKEA","model":"Landskrona 3-sits",
       "images":[{"dataUrl":"data:image/jpeg;base64,...","source":"video"}]}'
# -> 202 {"jobId":"...","imageCount":8,"statusUrl":"/v1/condition/..."}

# polla tills status inte längre är "running"
curl http://localhost:8799/v1/condition/<jobId> -H "x-api-key: $CONDITION_API_KEY"
# -> {"status":"done","stage":"done","result":{ ...ConditionResult... }}
```

Servern binder mot **127.0.0.1**, alltså bara samma maskin. `/api/*` — det webbappen använder — har
ingen autentisering, och att binda mot alla gränssnitt lade den öppen för vem som helst på samma WiFi.
Telefonen når appen ändå: den laddar sidan från vite, och vite proxar `/api` vidare härifrån.

## Ports

| Service | Port | Why |
|---|---|---|
| `web` (Vite) | 5190 | avoids the main app's 8080 |
| `server` (Node) | 8799 | avoids `ai-backend`/`truth-engine`'s shared default 8787 |

## Pipeline (V3 — MVP: max 2 Gemini calls, sub-30s SLA)

The V2 pipeline (one Gemini call per selected viewpoint + tiling + a separate holistic call) took
~10-13 minutes per real scan and produced duplicate damages (same physical mark reported 2-3x under
slightly different part-name wording). V3 replaces that with:

```
capture (web/src/screens/CaptureScreen.tsx): manual photo capture/upload, OR a guided video walkaround
  -> web/src/lib/videoFrames.ts (100% client-side, no AI): sample ~20 candidate frames across the video,
     score sharpness (downscaled gradient magnitude) + exposure, bucket into 8 temporal segments, keep the
     best-scoring frame per segment, drop near-duplicates via an 8x8 average-hash Hamming-distance check
     (with a floor: never collapse below 4 frames even if the source barely changes)
  -> seller reviews the selected 6-8 thumbnails before analysis starts, can add/remove
  -> POST /api/jobs with the final curated image list (already selected — no server-side selection step)

  -> server/src/pipeline/inspect.ts — ONE Gemini call, ALL images at once: systematic taxonomy-driven
     inspection instructed to (a) consolidate the same physical defect across views into one entry with
     multiple evidence[] observations, never split it, and (b) produce a holistic overallCondition read
     in the SAME response — no separate holistic call.
  -> server/src/pipeline/verify.ts — OPTIONAL second call, only for findings that are low-confidence or
     S3/S4 or non-cosmetic-impact; all flagged crops batched into ONE call. Skipped entirely (0 calls) if
     every finding is already clear.
  -> server/src/pipeline/dedup.ts — local safety net: same-image bbox-IoU merge + cross-view same-type/
     same-part merge, in case the main call still split something.
  -> server/src/pipeline/grade.ts — deterministic A-F = the WORSE of (grade from confirmed local defects)
     and (grade from the holistic wear/functionality/structure read) + a short 1-2 sentence rationale.
```

**Model:** `gemini-3.6-flash` primary, `gemini-3.7-flash` fallback (see `server/src/gemini.ts` for the
live-measured reasoning — re-measured 2026-08-26: 3.6-flash answers a 7-image call in ~12s while
3.5-flash never answers at all, with 7 images or with 2). One attempt on primary, one
on fallback if that fails — no backoff chains. **Google enforces a hard 10s minimum on `httpOptions.timeout`**
(discovered live via a real 400 error) — every configured timeout clamps to that floor.

Gemini responses are cached on disk by (model, resolution, prompt, image bytes) hash
(`server/data/cache/`) — re-running the same images never re-spends tokens.

## Kör en egen video lokalt

Startsidan → **Ladda upp en videofil** tar en färdig film och kör den genom exakt samma
bildruteurval som en kamerainspelning (`web/src/lib/videoFrames.ts` — en `File` är en `Blob`, så
inget i pipelinen märker skillnaden). Ingen rotations-UI inblandad.

Längst ned på resultatskärmen sitter **Teknisk information**, en hopfälld inspektionsvy som läser
debug-spåret nedan: täckning, vilken modell som svarade och om anropet var en cacheträff, tokens och
kostnad, dedup före/efter, helhetsbedömningen, betygsspåret, de analyserade bildrutorna med etikett
och källa, samt varje fynd med severity, impact, confidence, verifieringsstatus och sitt beskurna
utsnitt. Säljarvyn ovanför är oförändrad — den ska fortsatt vara fri från teknisk text.

En färdig körning kan sparas som testfixtur:

```bash
npm run condition:record -- --latest --furniture "stol ek"
npm run condition:baseline    # fyller fixturens expected-block
npm run condition:test
```

Fixturen fryser den post-verifierade defektlistan (`debug.json`s `verifiedDefects`), alltså precis
det `dedupeDamages` får in, så en omspelning kör dedup och betygsättning på riktigt utan att någonsin
anropa Gemini igen. Flera körningar av samma möbel ska dela `--furniture`-namn — stabilitetstestet
grupperar på det.

**Debug trace:** `GET /api/jobs/:id/debug` (linked at the bottom of the result screen) returns the full
taxonomy checked, raw pre-dedup defects, which findings got the optional verification pass and why,
rejected/confirmed findings, dedup before/after counts, the holistic assessment, the grade trace, and every
Gemini call made (purpose, tokens, cache hit, model actually used, latency). Not shown in the seller UI.

## Report UI

`ResultScreen.tsx` is seller-facing, not a debug view: big grade + one short rationale sentence at the top
(no model/token/cost/technical text), a "Vi hittade N synliga skador" line, findings grouped by type
("Repor — 2"), and each physical defect's evidence image shown large and inline by default — no
expand-to-see-evidence step. Tapping the image opens a zoom/pan fullscreen view. Original photos and the
debug link are both secondary/collapsed at the bottom.

## Seller corrections

`POST /api/jobs/:id/damages/:damageId` with `{action:"confirm"|"reject"|"edit", patch?}` and
`POST /api/jobs/:id/damages` (add a missed damage) both recompute the grade deterministically from the
corrected CONFIRMED-damage set and persist it.
\n</details>\n
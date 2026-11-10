# Identifiering via Googles AI-läge (SerpApi)

Från 2026-11-09 identifieras möbeln i säljarflödet av **Googles AI-läge**, som Loopas **server** frågar via SerpApi (`engine=google_ai_mode`). Det är samma frågor, samma flöde och samma kort som det lokala Electron-skalet använder (ett internt testverktyg som inte ligger i repot), men utan att någon behöver ha skalet: servern frågar, webbläsaren behöver inget annat än den vanliga webben. Skickbedömning, pris och annons körs som vanligt efter identifieringen.

Den äldre identifieringen (servern frågar Gemini med webbsök själv, `runIdentify`) finns kvar som **reserv**: den tar över på uppladdningar där SerpApi-flödet inte är på (se *När flödet är på*), och bakom knapparna "Hitta fler" / "Försök igen" på väljarskärmen.


## Flödet

1. **Uppladdningen.** Webben frågar servern `GET /api/serpapi/status`. Är svaret `enabled: true` lägger den in bryggen `web/src/lib/serpApiBridge.ts` (som annars bara Electron-skalet ger via `window.loopaApp`) och märker jobbet som externt. Skickbedömningen (video, skador) och identifieringen körs parallellt, som förut.
2. **Bilden.** Omslagsbilden läggs ut på `/api/serpapi/img/<24 slumpbyte>.jpg` i en halvtimme; SerpApi hämtar den därifrån (`image_url`). Innan en betald fråga går iväg hämtar servern adressen själv (upp till fem försök) och avbryter om den inte går att nå.
3. **Frågorna** står i `server/src/serpapi/prompts.ts`, en genererad fil: den är ett mekaniskt utdrag ur skalets `main.js` (lokalt verktyg), så att frågorna är ord för ord samma som där. `tests/serpapi.test.ts` jämför dem med `main.js` när den filen finns och hoppar annars över jämförelsen. Fråga 1 med bilden, högst två "fler förslag" i samma samtal så länge färre än fyra namngetts, måttfrågan **efter att säljaren valt modell** (samma samtal, två försök).
4. **Korten** byggs av servern ur svaret (samma kod som för skalet: `applyExternalIdentification`). Väljarskärmen väntar i laddningsskärmen tills bilderna är klara (tak 90 s).
5. **Referensbilderna** (`server/src/referensbild.ts`), kedjan **A → C → B**:
   - **A** (gratis): produktlänken AI-läget gav för modellen, bara om den är en riktig produktsida (modellens namn i sökvägen; inte startsida, kategori, kollektion, annons, prisjämförare, tillbehör eller annan typ). Sidans bilder (JSON-LD, og:image, twitter:image) hämtas och ett jämförande Gemini-val tar den bästa.
   - **C**: Googles bildsök via SerpApi ("märke modell typ produktbild framifrån"). Regler först (märket på raden, ingen prisjämförare, ingen annons, rätt typ), därefter ett jämförande Gemini-val bland högst fem.
   - **B** sist: Gemini med webbsök (≈0,3 kr per modell), bara för modeller som fortfarande saknar bild när appens slutgiltiga lista kommit; upp till tre alternativ i ett anrop; tas bara emot om märket OCH modellen står i bildens eller sidans adress. Annars **"Ingen bild"** — hellre ingen bild än fel bild.
   - Registret (`register.v5.json`, nyckel `märke|modell|g:<undertyp|typ>`) slås upp först och fylls på med bilder som klarat kontrollerna. UI:t säger att bilderna visar modellen, inte exakt den variant som väljs i nästa steg.

## När flödet är på

`serpApiEnabled()` (`server/src/serpapi/session.ts`) avgör, och webben frågar vid **varje** uppladdning. Flödet är på när **alla** stämmer:

- `SERPAPI_API_KEY` är satt,
- en publik adress för bilden går att få fram (`SERPAPI_PUBLIC_URL`, annars `LOOPA_PUBLIC_URL`; `https://loopa.nu` översätts till `https://app.loopa.nu`, eftersom servern nås där och `/api/serpapi/img/` inte är en av Workerns rutter),
- `LOOPA_SERPAPI` inte är `0` (avstängning utan att ta bort nyckeln),
- dygnstaket (`SERPAPI_DAILY_CAP`) inte är nått.

Annars tar uppladdningen den vanliga vägen och säljaren märker ingenting: en saknad nyckel, ett nått tak eller `LOOPA_SERPAPI=0` ger aldrig ett felmeddelande. Orsaken står som en rad `[serpapi] flödet är av: …` i serverloggen.

Faller SerpApi-flödet **mitt i** en körning (SerpApi nere, tunnel/adress onåbar, taket nått under flödet) får säljaren väljarskärmens ärliga tomma läge med "Hitta fler" (som kör den äldre identifieringen), "Försök igen" och möjligheten att skriva modellnamnet själv.

## Sätta på i drift (Oracle)

I `server/.env` på servern:

```
SERPAPI_API_KEY=…                      # SerpApis nyckel. Aldrig i chatten, aldrig i webbläsaren.
GEMINI_API_KEY=…                       # finns redan; behövs för bildvalet (A, C) och steg B
SERPAPI_PUBLIC_URL=https://app.loopa.nu   # valfritt om LOOPA_PUBLIC_URL=https://loopa.nu (översätts), men tydligare
SERPAPI_DAILY_CAP=…                    # sökningar per dygn och serverprocess (förval 200). Sätt efter planen, se Kostnad.
```

Starta om tjänsten (`rulla-ut.sh`). Kontrollera i loggen att en uppladdning ger rader `[serpapi] prepare: bilden ligger på https://app.loopa.nu/api/serpapi/img/…` och `[serpapi] samtal … slut: … sökningar`. **Provkör en uppladdning efter utrullningen**: det som inte går att prova från en utvecklingsdator är om SerpApi når `app.loopa.nu`. Blockerar Cloudflare (bot-skydd/WAF) SerpApis hämtning av bilden svarar AI-läget utan bild; undanta då sökvägen `/api/serpapi/img/*` från bot-skyddet.

## Kostnad

- **SerpApi:** 1 kredit per sökning, AI-läget också. En identifiering med fyra namngivna förslag = 1 fråga + 4–5 bildsökningar + 1 måttfråga ≈ **7 krediter** (upp till ~10 om "fler förslag" behövs eller måttfrågan görs om). Gratisplanen har 250 per månad ≈ 35 identifieringar; en betald plan behövs för drift. Kontrollera aktuell prislista hos SerpApi och räkna om `SERPAPI_DAILY_CAP` efter den.
- **Gemini:** bildvalet är ett anrop per modell (≈0,02 kr), steg B ≈ 0,3 kr per modell som saknar bild (medianen två sökfrågor), översättningen av AI-lägets svar ett anrop. Posterna går in i jobbets kostnadsbok som förut. **SerpApis sökningar ligger INTE i kostnadsboken** (den styr Geminis sökbudget och ska inte påverkas): de räknas per samtal i serverloggen (`[serpapi] samtal … slut`).
- **Taken:** per samtal 12 frågor / 30 bildsökningar (`SERPAPI_MAX_AI_PER_SESSION`, `SERPAPI_MAX_IMAGES_PER_SESSION`), per konto och dygn 30 samtal (`SERPAPI_MAX_SESSIONS_PER_USER`), per server och dygn `SERPAPI_DAILY_CAP`. Räknarna ligger i minnet och nollas vid omstart.

## Miljövariabler

| Variabel | Förval | Betydelse |
|---|---|---|
| `SERPAPI_API_KEY` | – | Nyckeln. Utan den är flödet av. |
| `SERPAPI_PUBLIC_URL` | `LOOPA_PUBLIC_URL` (loopa.nu → app.loopa.nu) | Adressen SerpApi hämtar bilden från. Lokalt: tunneladressen. |
| `LOOPA_SERPAPI` | på | `0` stänger av flödet (webben tar den vanliga vägen). |
| `SERPAPI_DAILY_CAP` | 200 | Sökningar per dygn och serverprocess. |
| `SERPAPI_MAX_SESSIONS_PER_USER` | 30 | Samtal per konto och dygn. |
| `SERPAPI_MAX_AI_PER_SESSION` / `SERPAPI_MAX_IMAGES_PER_SESSION` | 12 / 30 | Tak per samtal. |
| `SERPAPI_NO_CACHE` | på | `0` låter SerpApi svara ur sin timcache (inte en ny körning). |
| `SERPAPI_AI_LOCATION` | ingen | Plats för AI-läget. **Sätt den inte**: se nedan, den gav fel modell. |
| `SERPAPI_LOCATION` | `Stockholm, Sweden` | Plats för bildsökningarna (`none` = ingen). |
| `SERPAPI_FOLLOWUP_IMAGE` | av | `1` skickar bilden även med uppföljningsfrågorna (behövs inte: samtalet minns den). |
| `LOOPA_SERPAPI_LOG` / `LOOPA_SERPAPI_LOG_DIR` | av | Sparar varje sökning och svar som JSON (utan nyckeln); 10–70 kB per svar, därför av i drift. |
| `LOOPA_REFERENCE_CHAIN` | på | `0` stänger av kedjan A → C → B (då gäller skalets bildsökning med andra försök). |
| `LOOPA_REFERENS_A_MS` / `LOOPA_REFERENS_MAX_SOK` | 20 000 / 3 | Tak för steg A (ms) och sökfrågor i steg B. |
| `SERPAPI_ENDPOINT`, `SERPAPI_SKIP_REACHABILITY` | – | Bara för test (låtsas-SerpApi; hoppa över bildkontrollen). |

## Mätt mot riktiga svar

- **Bilden som URL fungerar** (2026-11-07, IKEA SÖDERHAMN, 10 sökningar). Ett foto av en SÖDERHAMN-soffa gav SÖDERHAMN som förslag 1 (ca 90–95 %) i tre körningar av tre. Uppföljningen minns bilden: fråga 2 och måttfrågan går med `subsequent_request_token` utan ny bild.
- **Plats (VIKTIGT):** AI-läget får `hl=sv` och `gl=se` men **ingen `location`**. Med `location=Stockholm, Sweden` (SerpApi kodar den till en `uule`) kom Sits Impulse i 0 av 7 körningar på samma foto och samma fråga, och källorna var ofta brittiska. Utan `location` kom Impulse i 5 av 5, som på webben. Bildsökningarna (`google_images`) behåller `location`. Utan `location` saknas `references` i svaret; länkarna hämtas då ur `text_blocks` (`snippet_links`).
- **Svarets form** skiljer från sidans text och normaliseras i `render.ts` (`markdownToText`): markdown-escapes, källhänvisningar `[0]`, punktmarkörer och SerpApis "References"-lista bort. Utan det hittade namnläsningen 0 förslag. Prov mot tre sparade riktiga svar: `tests/fixtures/serpapi/`.
- **Namnläsningen** läste raden "Hur säker är jag:" som ett modellnamn ("Hur"); "Hur" ligger nu i skip-listan i `main.js` (rad 101).
- **Måttfrågan** svarade 3 av 4 gånger; en gång svarade Google "Det verkar inte finnas något svar för den här sökningen" (samma beteende som skalet). Flödet försöker två gånger och faller sedan tillbaka på Loopas egen specsökning.
- **Referensbilder:** mätt på 10 modeller var Googles förstabild fel typ/märke/begagnad i 7, därför väljer reglerna och det jämförande valet i stället för förstabilden. Skarpt testat på två möbler (2026-11-09): NORDVIKEN fick rätt bild (via B), Brandon fick ingen i det testet (C hade inget att välja bland, B:s enda förslag gick inte att hämta; B tar sedan dess upp till tre alternativ — **inte omkört skarpt**).

## Vad som inte är mätt

1. **Hela flödet från start till annons:** identifieringen med bildkedjan är provkörd skarpt, men bara i testläget (`onlyIdentifySpecs`: ingen skickbedömning, inget pris). Skickbedömning, pris och annons efter identifieringen är den befintliga koden och rörs inte, och jobb märkta som externa gick den vägen redan i skalet — men helheten med den här bryggen är **inte provkörd**. Gör en uppladdning från start till annons före utrullning till användare.
2. **Andra möbeltyper** än fåtöljer, soffor och barstolar (bord, skåp) är inte provade; steg A–C har bara körts mot Sits och IKEA.
3. **Steg A från Oracles IP** kan få fler 403 från butikssidor än från en hemadress.
4. **SerpApis tolkning** av Googles svar är inte sidans text; samma bild ger olika förslag 2–4 från körning till körning (det gör skalet också).
5. **Bildrättigheter:** referensbilderna hämtas från märkenas och återförsäljarnas sidor och visas bara för säljaren i väljaren (inte i annonsen).

## Prova

SerpApi hämtar omslagsbilden från serverns publika adress, så flödet kan inte köras mot en server som bara nås på localhost. Lokalt behövs en tunnel som släpper igenom enbart `/api/serpapi/img/<nyckel>` (inte hela servern) och en `SERPAPI_PUBLIC_URL` som pekar på den; utan det avbryter servern innan en betald fråga går iväg med "Bilden går inte att nå utifrån". Verktygen för en sådan lokal provinstans ligger inte i repot.

Servern skriver `[serpapi]`, `[referens]` och `[bild]` i konsolen (vilket steg som gav varje bild, vad varje samtal kostade i sökningar). `LOOPA_SERPAPI_LOG=1` sparar dessutom varje sökning och svar som JSON under `server/data/serpapi-log/`.

I webben: öppna sidan med `?serpapi=1` en gång så visas granskningspanelen "AI-lägets samtal" nere till vänster (frågor, svar, SerpApi-sökningens id och Googles adress); `?serpapi=0` stänger av den. Säljare ser den aldrig.

`npx tsx --test tests/serpapi.test.ts tests/referensbild.test.ts` kör proven utan nät.

# Loopa Condition

Besiktningsmotor för begagnade möbler: `ConditionInput -> ConditionResult`. Bilder in, ett A–F-betyg ut
tillsammans med en lista skador, var och en med typ, allvarlighetsgrad, påverkan och en markerad
bildruta som bevis.

Utbruten ur `vips-buy-sell-hub` (`experiments/condition-grading/`). Modulen var självständig redan där
— inga importer lämnade mappen — så inget behövde skrivas om vid flytten.

## Kör lokalt

```bash
npm run install:all          # rot + server + web

cp server/.env.example server/.env    # fyll i GEMINI_API_KEY
npm run server:dev           # backend på http://localhost:8799
npm run web:dev              # frontend på https://localhost:5190
```

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
bildrutor  ->  inspect    ett Gemini-anrop, hela möbeln, delsvep + skadelista
           ->  verify     andra besiktaren: granskar fynden och letar efter det som missades
           ->  dedup      lokalt skyddsnät mot dubbelrapportering
           ->  grade      deterministisk A-F, noll LLM
```

Betyget är det sämre av två oberoende spår: de bekräftade skadorna, och en holistisk slitagebedömning.
Ingetdera kan förbättra det andra. A–F mappas till fyra publika strängar: Nyskick, Mycket bra skick,
Bra skick, Okej skick.

## API

`POST /v1/condition` och `GET /v1/condition/:id`, autentiserade med `x-api-key`. Samma pipeline som
appen — båda går genom samma funktion, så de kan inte glida isär.

```bash
curl -X POST http://localhost:8799/v1/condition \
  -H "x-api-key: $CONDITION_API_KEY" -H "Content-Type: application/json" \
  -d '{"images":[{"dataUrl":"data:image/jpeg;base64,...","source":"video"}]}'
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
  -d '{"images":[{"dataUrl":"data:image/jpeg;base64,...","source":"video"}]}'
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
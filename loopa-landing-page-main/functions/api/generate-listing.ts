// Cloudflare Pages Function: POST /api/generate-listing
//
// Real, server-side Gemini-backed listing generator for professional
// secondhand operators. Two modes:
//
//   furniture — brand + model are known (required). Stage 1 does grounded web
//     research (Google Search tool) WITH the seller's photos attached, so the
//     search is steered and verified by what is actually photographed; stage 2
//     turns that research + the photos into the structured listing, judging
//     condition ONLY from the seller's photos, never from reference images.
//
//   fashion — all text inputs optional (brand, style code, size). Stage 1 is
//     the same grounded-research-with-images call: Gemini reads the garment +
//     any label/care-tag photos as evidence (style code ≫ product name ≫
//     brand+labels ≫ brand+images) and researches the product on the web.
//     Stage 2 is the vision structured call. Never invents an exact
//     product/model without clear evidence.
//
// The grounded-call shape (images + prompt + googleSearch in ONE request,
// serviceTier "priority", thinkingLevel "low", 60s per-attempt timeout) is
// ported from the verified reference implementation — Lovable project
// "Listing Genie" (VIPS 2.0 lovable, fc2b61c4-e026-42d8-8708-295d33d9950f),
// whose production listing quality this pipeline replicates. Its code
// documents that grounded searches with images regularly take 30-60s and a
// 25s cap "aborted every healthy request" — hence the split timeouts below.
//
// Grounding + structured JSON output are still requested as two separate
// Gemini calls (stage 1 free-text grounded research, stage 2 structured JSON)
// — combining Google Search grounding with a JSON response schema in one call
// is unreliable (Listing Genie avoids responseSchema entirely and hand-parses
// JSON from free text; Loopa keeps the stricter schema stage instead). Source
// URLs in `sources[]` are taken directly from stage 1's groundingMetadata,
// never re-typed by the model; per-attribute `sourceUrl` links are model-cited
// research URLs, https-validated server-side.
//
// Reliability policy per logical call (research call, structuring call):
// try the primary model first; fall back to the secondary model ONLY on
// 429, 5xx, timeout or network failure; a jittered 0.5-1.5s pause before the
// fallback; at most 2 attempts per call; no retry loops; same prompt/schema
// for both attempts.
//
// Failure policy per STAGE (confirmed against a real production outage):
//   - The grounded research stage (and the website-structure ask merged into
//     it) is BEST-EFFORT: if both models fail it, generation continues with
//     empty research — the structuring prompt already handles that case
//     explicitly ("ingen research hittades … gissa aldrig"). Grounded
//     googleSearch calls are by far the flakiest call type (observed live:
//     primary 503 UNAVAILABLE + fallback 25s timeout, both models, sustained
//     minutes), and a degraded-but-honest listing beats a dead endpoint.
//   - Only the structuring stage is fatal — it IS the listing.
//   - Controlled error responses use HTTP 500, NEVER 502/504: Cloudflare's
//     edge replaces Worker-returned 502/504 responses with its own error
//     page (a bare "error code: 502" body), which destroys the JSON error
//     body and leaves the client showing a generic "unexpected response"
//     message instead of the real one. Confirmed live via tail: the function
//     completed "Ok" and returned its JSON 502, but clients received
//     Cloudflare's 16-byte substitute body.
//
// Env vars (see .env.example):
//   GEMINI_API_KEY - required. Server-side only, never sent to the client.
//   AI_GATEWAY_URL - optional, same Cloudflare AI Gateway pass-through as /api/chat.
// Model selection (gemini-3.7-flash primary, gemini-3.6-flash fallback,
// serviceTier "priority" for both) is centralized in ./_shared/gemini.ts, not
// env-driven — see that file's header.

import {
  LISTING_RESPONSE_SCHEMA,
  type ConditionAssessment,
  type GenerateListingRequest,
  type GeneratedListingResult,
  type GenerationMode,
  type PricingAssessment,
  type ProductAttribute,
  type ProductIdentity,
  type SourceRef,
  type UploadedImage,
  type WebsiteAdaptation,
} from '../../src/features/generator/schema'
import { callGeminiWithFallback, extractText, type GeminiEnv } from './_shared/gemini'
// Deterministic guardrails live in ./_shared/listing-guards.ts so the rules
// that protect trust (marketplace prices are never nypris evidence, price
// plausibility bounds, source tiers) are defined once and cannot drift between
// this professional pipeline and the consumer seller pipeline.
import {
  extractSources,
  isPlausibleRetailPriceSek,
  isSecondhandMarketplaceUrl,
  numOrNull,
  slugify,
} from './_shared/listing-guards'

type Env = GeminiEnv

// Grounded search with images needs 30-60s to complete healthily (measured in
// the Listing Genie reference); the structured no-tools call stays fast.
const GROUNDED_TIMEOUT_MS = 60_000
const STRUCTURE_TIMEOUT_MS = 25_000
/** Cap on the whole research stage (primary + jitter + fallback) so a slow primary can't starve the fallback or the structuring stage. */
const RESEARCH_BUDGET_MS = 90_000
const MAX_IMAGES = 10
const MAX_BODY_BYTES = 26 * 1024 * 1024

function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() })
}

// ─── Deterministic guardrails ────────────────────────────────────────────
//
// The domain/price/source rules themselves now live in
// ./_shared/listing-guards.ts (imported above) — shared with the seller
// pipeline. What stays here is the furniture-specific variant check, which
// has no seller-mode equivalent.

/** Seat-count / footstool variant tokens — deliberately narrow. Returns null when no discriminating token is found in either string (nothing to compare, not a conflict). */
function extractVariantTokens(text: string): { seatCount: number | null; hasFootstool: boolean | null } {
  const lower = text.toLowerCase()
  const seatMatch = lower.match(/\b([2-6])[\s-]?sits\b/)
  const seatCount = seatMatch ? Number(seatMatch[1]) : null
  let hasFootstool: boolean | null = null
  if (/\b(utan|ej|exkl\.?|exklusive)\s+(matchande\s+)?(fot\s*pall|fotpall|ottoman)\b/.test(lower)) hasFootstool = false
  else if (/\b(med|inkl\.?|inklusive)\s+(matchande\s+)?(fot\s*pall|fotpall|ottoman)\b/.test(lower)) hasFootstool = true
  else if (/\b(fot\s*pall|fotpall|ottoman)\b/.test(lower) && /\bfåtölj|fatolj\b/.test(lower)) hasFootstool = true
  return { seatCount, hasFootstool }
}

/** Deterministic conflict check between what the seller typed and what the research actually found — server-side, cannot be talked out of it by the structuring call. A conflict forces identity.uncertain regardless of what the model reports. */
function checkVariantConsistency(sellerProductName: string, researchText: string): string | null {
  if (!sellerProductName || !researchText) return null
  const claimed = extractVariantTokens(sellerProductName)
  const found = extractVariantTokens(researchText)
  if (claimed.seatCount !== null && found.seatCount !== null && claimed.seatCount !== found.seatCount) {
    return `Uppgiven variant nämner ${claimed.seatCount}-sits, men researchen pekar på ${found.seatCount}-sits — kontrollera mot bilderna.`
  }
  if (claimed.hasFootstool !== null && found.hasFootstool !== null && claimed.hasFootstool !== found.hasFootstool) {
    return claimed.hasFootstool
      ? 'Uppgiven variant nämner fotpall, men researchen pekar på en variant utan fotpall — kontrollera mot bilderna.'
      : 'Uppgiven variant nämner ingen fotpall, men researchen pekar på en variant med fotpall — kontrollera mot bilderna.'
  }
  return null
}

// ─── Prompts ─────────────────────────────────────────────────────────────

/**
 * Website-structure research instructions, shared verbatim between furniture's
 * merged research call and fashion's dedicated one. Deliberately scoped tight
 * (one product page, ~60 words, explicit "don't dig deeper" instruction):
 * measured latency showed an open-ended, multi-facet version of this ask
 * (structure + condition + pricing + category + SEO conventions, unbounded
 * search) reliably pushed the combined furniture call past the 25s per-model
 * budget under real load — both primary and fallback timed out. This is a
 * scope fix, not a change to the timeout or model routing.
 */
function websiteProfileInstructions(websiteUrl: string): string {
  return `Gör EN snabb sökning på webbplatsen ${websiteUrl} (en e-handels-/secondhand-webbplats) — titta på högst en produktsida, gräv inte vidare. Sammanfatta i ett eget avsnitt med rubriken "WEBBPLATSSTRUKTUR:", i max 60 ord: vilka produktfält de visar (t.ex. titel, märke, mått, material, skick), hur skick och pris presenteras, samt kategorinamn.
Basera detta ENDAST på vad du hittar. Kopiera aldrig deras produkttexter ordagrant. Om webbplatsen inte går att hitta snabbt, skriv "Ingen webbplatsstruktur kunde fastställas." i avsnittet och gå vidare — lägg inte mer tid på sökningen.`
}

function buildFurnitureResearchPrompt(brand: string, model: string, websiteUrl?: string): string {
  return `Du är en produktresearcher för secondhand-möbler på Loopa, en svensk marknadsplats för secondhand-möbler.

Säljarens egna produktbilder är bifogade. Säljaren uppger att produkten är:
Märke: ${brand}
Modell: ${model}

Använd Google Search för att researcha exakt denna produkt. Använd BILDERNA för att styra och verifiera sökningen: kontrollera att det du hittar faktiskt ser ut som produkten på bilderna (form, variant, antal sitsplatser, underrede, färg/utförande) och researcha i så fall rätt variant. Om bilderna tydligt talar emot uppgivet märke/modell, skriv det rakt ut i din redovisning istället för att researcha fel produkt vidare.

Prioritera källor i denna ordning:
1. Tillverkarens/varumärkets egen webbplats
2. Officiella produkt-PDF:er och kataloger
3. Auktoriserade återförsäljare med gott rykte
4. Andra trovärdiga källor endast om nödvändigt

Ta reda på och redovisa (endast det du hittar belägg för):
- Exakt produktnamn/variant och kategori (t.ex. fåtölj, soffa, matbord, skänk)
- Mått i cm: bredd, djup, höjd, längd, diameter (där relevant)
- För sittmöbler: sitthöjd, sittdjup, sittbredd i cm
- Material och ytbehandling
- Formgivare/designer
- Tillverkningsperiod / lanseringsår
- Ungefärligt ORIGINALPRIS (nypris) i SEK om det går att hitta
- Andra relevanta specifikationer (t.ex. vikt, stomme, fjädring, klädsel)

Sök därefter även upp ANDRAHANDSMARKNADEN: leta efter faktiska begagnatpriser för samma modell på den svenska begagnatmarknaden (t.ex. Blocket, Tradera, designåterförsäljare av begagnat). Redovisa observerade begagnatpriser i ett eget avsnitt med rubriken "ANDRAHANDSPRISER:". Dessa källor gäller ENDAST andrahandsvärde — använd dem aldrig som belägg för nypris.

Regler:
- Ange endast fakta du faktiskt hittar i sökresultaten. Hitta ALDRIG på mått, pris eller andra uppgifter.
- Om något inte går att bekräfta, utelämna det helt eller skriv tydligt att det är okänt. Ofullständig research är INTE ett fel.
- Ange källans URL direkt efter varje faktauppgift, inom parentes, t.ex. "(källa: https://…)". Skriv endast URL:er du faktiskt sett i sökresultaten — hitta ALDRIG på en URL.
- Svara på svenska, i löptext, redo att användas som underlag av en annan process.

${websiteUrl ? websiteProfileInstructions(websiteUrl) : ''}`
}

/** Fashion research — same grounded-with-images call shape. The model reads label/care-tag photos as evidence first, then searches; identifier weighting per the reference implementation: style code ≫ exact product name ≫ brand + label info ≫ brand + images. */
function buildFashionResearchPrompt(brand: string, styleCode: string, size: string, websiteUrl?: string): string {
  return `Du är en produktresearcher för secondhand-plagg på Loopa, en svensk marknadsplats för secondhand-mode.

Säljarens egna bilder är bifogade: produktbilder och eventuellt bilder på etiketter/tvättlappar. Läs av all synlig text på etiketterna (varumärke, artikelnummer/stilkod, materialsammansättning, storlek, tillverkningsland) och använd den som bevis.

Säljaren har dessutom uppgett (dessa uppgifter är sanning och får ALDRIG ersättas av svagare AI-gissningar):
- Varumärke: ${brand ? `"${brand}"` : 'okänt'}
- Stilkod/artikelnummer: ${styleCode ? `"${styleCode}"` : 'okänt'}
- Storlek: ${size ? `"${size}"` : 'okänd'}

Använd Google Search för att identifiera och researcha exakt denna produkt. Vikta identifierare i denna ordning:
1. Stilkod/artikelnummer (sök hårt på denna – den identifierar ofta exakt originalprodukt)
2. Exakt känt produkt-/modellnamn
3. Varumärke + information från etiketterna
4. Varumärke + produktbilderna

Prioritera källor i denna ordning: 1) varumärkets officiella webbplats, 2) officiella/arkiverade produktsidor och kataloger, 3) auktoriserade återförsäljare med gott rykte, 4) andra trovärdiga källor endast om nödvändigt.

Ta reda på och redovisa (endast det du hittar belägg för):
- Exakt produktnamn/modell och plaggtyp
- Materialsammansättning (med procent om tillgängligt)
- Färgnamn, passform, kollektion/säsong
- Stilkod/artikelnummer
- Ungefärligt ORIGINALPRIS (nypris) i SEK om det går att hitta
- Skötselråd och andra relevanta attribut

Sök därefter även upp ANDRAHANDSMARKNADEN: faktiska begagnatpriser för samma eller närmast jämförbara produkt (t.ex. Sellpy, Tradera, Plick, Vestiaire). Redovisa observerade priser i ett eget avsnitt med rubriken "ANDRAHANDSPRISER:". Dessa källor gäller ENDAST andrahandsvärde — aldrig nypris.

Regler:
- Gissa ALDRIG exakt produktidentitet om bevisen är svaga – skriv då tydligt att den inte kunde fastställas. Ofullständig research är INTE ett fel.
- Ange endast fakta du faktiskt hittar. Hitta ALDRIG på uppgifter eller URL:er.
- Ange källans URL direkt efter varje faktauppgift, inom parentes, t.ex. "(källa: https://…)".
- Svara på svenska, i löptext, redo att användas som underlag av en annan process.

${websiteUrl ? websiteProfileInstructions(websiteUrl) : ''}`
}

function buildFurnitureStructuringPrompt(
  brand: string,
  model: string,
  research: string,
  hasWebsiteProfile: boolean,
  variantConflictNote: string | null,
): string {
  return `Du hjälper till att skapa en professionell secondhand-produktlisting för Loopa (svensk marknadsplats för secondhand-möbler, riktad mot professionella secondhand-aktörer).

PRODUKT (uppgiven av säljaren): ${brand} ${model}

RESEARCH FRÅN WEBBKÄLLOR (använd ENDAST detta för identity, attributes och pricing.retailPriceSek — hitta aldrig på egna mått eller priser som inte nämns här). Prioritera i första hand tillverkarens/märkets egen webbplats om researchen innehåller den; använd etablerade svenska möbelåterförsäljare i andra hand. Använd ALDRIG en secondhand- eller auktionssida (t.ex. Tradera, Blocket, Sellpy, Vinted, eBay, Lauritz, Bukowskis, Barnebys, Auctionet, Catawiki) som källa för nypris — dessa visar andrahandspriser, inte nypris, och ska ignoreras för pricing.retailPriceSek även om de nämns i researchen:
"""
${research || '(ingen research hittades — lämna okända fält null eller tomma, gissa aldrig)'}
"""

SÄLJARENS EGNA BILDER är bifogade. Använd ENDAST dessa bilder (inte research-texten ovan) för att bedöma produktens SKICK: leta efter repor, fläckar, nagg, slitage, missfärgning, skador. Sätt condition.uncertain=true om bilderna inte räcker för en säker bedömning, och förklara kort varför i uncertaintyNote.

identity: anta INTE per automatik att det uppgivna märket/modellen stämmer bara för att säljaren skrev det, och anta aldrig ett vanligt/välkänt märke bara för att det är vanligt. Kontrollera om bilderna och researchen ovan är TROVÄRDIGT FÖRENLIGA med "${brand} ${model}" (t.ex. form, antal sitsplatser, synliga detaljer). Sätt identity.confidence till "high" endast om både bilder och research stämmer väl överens med det uppgivna märket/modellen/varianten, "medium" om det mesta stämmer men något är osäkert, "low" om du inte kan bekräfta det uppgivna märket/modellen mot bilderna. Sätt identity.uncertain=true och skriv en kort, konkret uncertaintyNote (vad som inte stämmer eller inte kunde bekräftas) om något tydligt talar emot den uppgivna identiteten — hitta aldrig på ett annat märke/modell istället, lämna bara osäkerheten synlig.
${variantConflictNote ? `VIKTIGT: en automatisk kontroll upptäckte en möjlig motsägelse mellan säljarens uppgifter och researchen: "${variantConflictNote}" Ta ställning till detta utifrån bilderna och sätt identity.uncertain=true med en uncertaintyNote om motsägelsen kvarstår.\n` : ''}

Fyll i "attributes" med ALLA relevanta specifikationer som stöds av researchen ovan (mått, material, sitthöjd/sittdjup/sittbredd om tillämpligt, formgivare, tillverkningsperiod, o.s.v.). Hoppa aldrig över ett relevant fält, men hitta heller aldrig på ett värde som inte finns i researchen. Varje attribut ska ha en kort "key" (t.ex. "seat_height_cm"), en läsbar svensk "label" (t.ex. "Sitthöjd (cm)") och ett "value". Sätt "sourceUrl" till den käll-URL som researchen anger för just det värdet — ENDAST URL:er som ordagrant står i researchen ovan, annars null. Skriv aldrig en egen URL.

pricing.suggestedPriceSek: föreslå ett rimligt andrahandspris. Utgå i första hand från researchens avsnitt "ANDRAHANDSPRISER:" (faktiskt observerade begagnatpriser för samma modell), i andra hand från nypris, och väg in det bedömda skicket. Sätt priceRangeMinSek/priceRangeMaxSek till ett rimligt intervall och förklara kort i rationale hur värderingen gjorts (observerade begagnatpriser, nypris, skick, efterfrågan). Om varken observerade andrahandspriser eller nypris gick att hitta finns inte tillräckligt underlag — sätt då pricing.available=false och lämna prisfälten null. Hitta aldrig på ett pris utan underlag.

listing: skriv en professionell svensk produkttitel, en saklig men säljande beskrivning, och en kort, ärlig skicktext. Nivån ska passa en seriös secondhand-webshop, inte en vardaglig marknadsplatsannons.

seo: skriv en metaTitle (max ca 60 tecken), metaDescription (max ca 155 tecken) och en beskrivande alt-text för produktbilden — baserat ENDAST på fastställda fakta ovan. Aldrig keyword-stuffing.

${hasWebsiteProfile ? 'Researchen ovan innehåller ett avsnitt "WEBBPLATSSTRUKTUR:" som beskriver hur kundens webbplats strukturerar sina produktsidor. Organisera "attributes", "listing" och "seo" så att de i möjligaste mån följer samma fältnamn, struktur, kategorisering och tonalitet som beskrivs där. Du får och bör ändå lägga till ytterligare verifierade, användbara specifikationer från researchen ovan även om webbplatsen normalt inte visar dem — matcha strukturen, förbättra sedan med fler fakta. Kopiera aldrig deras texter ordagrant.\n\n' : ''}missingNotes: lista kort vilka viktiga fält som saknas eller är osäkra.`
}

function buildFashionPrompt(
  research: string,
  user: { brand: string; styleCode: string; size: string },
  hasWebsiteProfile: boolean,
): string {
  const userLines = [
    user.brand ? `- Varumärke: "${user.brand}"` : '',
    user.styleCode ? `- Stilkod/artikelnummer: "${user.styleCode}"` : '',
    user.size ? `- Storlek: "${user.size}"` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return `Du hjälper till att skapa en professionell secondhand-produktlisting för Loopa (svensk marknadsplats för secondhand-plagg, riktad mot professionella secondhand-aktörer).

${
  userLines
    ? `SÄLJARENS EGNA UPPGIFTER (dessa är sanning och får ALDRIG ersättas av svagare AI-gissningar):
${userLines}

`
    : ''
}RESEARCH FRÅN WEBBKÄLLOR (använd ENDAST detta för researchade fakta som exakt produktnamn, materialsammansättning, nypris och observerade andrahandspriser — hitta aldrig på uppgifter som inte nämns här). Använd ALDRIG en secondhand- eller auktionssida som källa för nypris:
"""
${research || '(ingen research hittades — basera allt på bilderna och säljarens uppgifter, gissa aldrig)'}
"""

Bilderna som bifogas visar ett plagg, och där möjligt även etikett/tvättråd. Identifiera så mycket som säkert går att fastställa direkt från bilderna:
- Sannolikt märke — ENDAST om det syns tydligt på en etikett/logotyp, gissa aldrig från stil
- Produkttyp (t.ex. skjorta, jacka, klänning, byxor, tröja)
- Färg
- Materialsammansättning — läs av tvättråd/innerlappar om de är fotograferade
- Storlek — läs av etikett om den är fotograferad
- Passform/stil
- Ev. artikelnummer/kod på etikett
- Andra relevanta attribut (t.ex. mönster, ärmlängd, krage, knapptyp, säsong om tydligt märkt)

Hitta ALDRIG på en exakt produktmodell om det inte finns tydligt belägg i bilderna eller researchen — sätt då identity.exactProduct till null och notera osäkerheten i missingNotes. Detsamma gäller märke: om säljaren inte uppgett något märke och inget märke syns, sätt identity.brand till null. Anta aldrig ett vanligt/välkänt märke bara för att det är vanligt — en identifiering ska alltid kunna knytas till en specifik detalj (etikett, logotyp, stilkod) i bilderna, säljarens uppgifter eller researchen.

identity.confidence: sätt "high" endast om märket är bekräftat (säljarens uppgift eller tydlig etikett/logotyp) OCH produkttyp/attribut är entydiga, "medium" om produkttypen är säker men den exakta identiteten är en rimlig men inte helt säker läsning, "low" om märket eller produkttypen är oklar. Sätt identity.uncertain=true med en kort, konkret uncertaintyNote när något i identiteten inte kunde bekräftas tydligt — hitta aldrig på ett alternativt märke istället. Om bilderna uppenbart INTE visar den identifierade produkten (fel produkttyp, motsägande detaljer) MÅSTE identity.uncertain=true och confidence högst "low", oavsett hur säkra säljarens uppgifter är.

Bedöm SKICKET utifrån bilderna: nagg, nopprighet, fläckar, hål, slitage vid kanter/sömmar/manschetter. Sätt condition.uncertain=true om bilderna inte räcker för en säker bedömning.

pricing.suggestedPriceSek: föreslå ett rimligt andrahandspris. Utgå i första hand från researchens avsnitt "ANDRAHANDSPRISER:" (faktiskt observerade begagnatpriser), i andra hand från nypris, och väg in det bedömda skicket. Sätt priceRangeMinSek/priceRangeMaxSek till ett rimligt intervall och förklara kort i rationale hur värderingen gjorts. Saknas underlag helt — sätt pricing.available=false och lämna prisfälten null. Hitta aldrig på ett pris utan underlag.

Fyll i "attributes" med alla relevanta, faktiskt stödda attribut. Varje attribut ska ha en kort "key", en läsbar svensk "label" och ett "value". Sätt "sourceUrl" till den käll-URL som researchen anger för just det värdet — ENDAST URL:er som ordagrant står i researchen ovan, annars null (värden lästa direkt från bilderna har sourceUrl null). Hitta aldrig på värden utan stöd i bilderna, säljarens uppgifter eller researchen.

listing: skriv en professionell svensk produkttitel och en saklig, säljande men ärlig beskrivning. Nivån ska passa en seriös secondhand-webshop.

seo: skriv metaTitle (max ca 60 tecken), metaDescription (max ca 155 tecken) och alt-text — baserat endast på fastställda fakta.

${
  hasWebsiteProfile
    ? 'Researchen ovan innehåller ett avsnitt "WEBBPLATSSTRUKTUR:" som beskriver hur kundens webbplats strukturerar sina produktsidor. Organisera "attributes", "listing" och "seo" så att de i möjligaste mån följer samma fältnamn, struktur, kategorisering och tonalitet som beskrivs där. Du får och bör ändå lägga till ytterligare verifierade, användbara attribut även om webbplatsen normalt inte visar dem. Kopiera aldrig deras texter ordagrant och hitta aldrig på uppgifter för att efterlikna stilen.\n\n'
    : ''
}missingNotes: lista kort vad som är osäkert eller saknas (t.ex. "exakt märke okänt", "storlek ej synlig på bild"). Producera ändå en så användbar generisk listing som möjligt även om exakt produkt inte kan fastställas.`
}

// ─── Request builders ────────────────────────────────────────────────────

/**
 * The grounded-call shape verified in the Listing Genie reference: the
 * seller's images and the research prompt travel in the SAME googleSearch-
 * grounded request (images first, prompt last), low thinking so the 30-60s
 * call stays as fast as it can be. serviceTier "priority" is applied
 * centrally to every call in ./_shared/gemini.ts, not set here.
 */
function buildGroundedResearchBody(promptText: string, images: UploadedImage[]) {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = images.map((img) => ({
    inlineData: { mimeType: img.mimeType, data: img.dataBase64 },
  }))
  parts.push({ text: promptText })
  return {
    contents: [{ role: 'user', parts }],
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } },
  }
}

/** Best-effort hostname parse for the "Anpassad för X" badge — deterministic, never generated by Gemini. Invalid input is treated the same as no URL given (personalization silently skipped, generation proceeds normally). */
function extractDomain(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    const host = u.hostname.replace(/^www\./i, '')
    return host.includes('.') ? host : null
  } catch {
    return null
  }
}

function buildStructuredBody(promptText: string, images: UploadedImage[], schema: typeof LISTING_RESPONSE_SCHEMA) {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: promptText }]
  for (const img of images) parts.push({ inlineData: { mimeType: img.mimeType, data: img.dataBase64 } })
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      // This single call carries both identity/attribute extraction (wants
      // low variance) and listing-copy generation (wants some room). 0.15 is
      // a compromise that favors identification accuracy without making the
      // listing prose robotic (the reference implementation runs 0.2).
      temperature: 0.15,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  }
}

// ─── Result shaping (defensive normalization + deterministic SEO derivation) ──

function buildJsonLd(
  identity: ProductIdentity,
  attributes: ProductAttribute[],
  pricing: PricingAssessment,
  listing: { title: string; description: string },
  slug: string,
): Record<string, unknown> | null {
  if (!identity.brand && !identity.exactProduct) return null
  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: listing.title,
    description: listing.description || undefined,
    brand: identity.brand ? { '@type': 'Brand', name: identity.brand } : undefined,
    category: identity.category || undefined,
    url: `/produkt/${slug}`,
    additionalProperty: attributes.length
      ? attributes.map((a) => ({ '@type': 'PropertyValue', name: a.label, value: a.value }))
      : undefined,
  }
  if (pricing.available && pricing.suggestedPriceSek) {
    jsonLd.offers = {
      '@type': 'Offer',
      priceCurrency: 'SEK',
      price: pricing.suggestedPriceSek,
      itemCondition: 'https://schema.org/UsedCondition',
      availability: 'https://schema.org/InStock',
    }
  }
  return JSON.parse(JSON.stringify(jsonLd))
}

function shapeResult(
  mode: GenerationMode,
  parsed: any,
  sources: SourceRef[],
  websiteAdaptation: WebsiteAdaptation | null,
  /** Set when the deterministic checkVariantConsistency() check found a conflict — forces identity.uncertain regardless of what the model reported, since a code-level check can't be talked out of it. */
  variantConflictNote: string | null,
): GeneratedListingResult {
  const modelConfidence = parsed?.identity?.confidence
  const modelUncertaintyNote =
    typeof parsed?.identity?.uncertaintyNote === 'string' && parsed.identity.uncertaintyNote ? parsed.identity.uncertaintyNote : null

  const identity: ProductIdentity = {
    brand: typeof parsed?.identity?.brand === 'string' && parsed.identity.brand ? parsed.identity.brand : null,
    exactProduct: typeof parsed?.identity?.exactProduct === 'string' && parsed.identity.exactProduct ? parsed.identity.exactProduct : null,
    variant: typeof parsed?.identity?.variant === 'string' && parsed.identity.variant ? parsed.identity.variant : null,
    category: typeof parsed?.identity?.category === 'string' && parsed.identity.category ? parsed.identity.category : null,
    confidence: modelConfidence === 'high' || modelConfidence === 'medium' || modelConfidence === 'low' ? modelConfidence : 'low',
    uncertain: !!parsed?.identity?.uncertain || !!variantConflictNote,
    uncertaintyNote: variantConflictNote
      ? [modelUncertaintyNote, variantConflictNote].filter(Boolean).join(' ')
      : modelUncertaintyNote,
  }

  const attributes: ProductAttribute[] = Array.isArray(parsed?.attributes)
    ? parsed.attributes
        .filter(
          (a: any): a is ProductAttribute => a && typeof a.key === 'string' && typeof a.label === 'string' && typeof a.value === 'string' && a.value.trim() !== '',
        )
        .map((a: ProductAttribute & { sourceUrl?: unknown }) => ({
          key: a.key,
          label: a.label,
          value: a.value,
          // Model-cited research URL — accepted only when it's a real https(s) URL (mirrors the reference implementation's URL filtering); anything else becomes null.
          sourceUrl: typeof a.sourceUrl === 'string' && /^https?:\/\/\S+$/i.test(a.sourceUrl.trim()) ? a.sourceUrl.trim() : null,
        }))
    : []

  const condition: ConditionAssessment = {
    grade: typeof parsed?.condition?.grade === 'string' && parsed.condition.grade ? parsed.condition.grade : null,
    label: typeof parsed?.condition?.label === 'string' && parsed.condition.label ? parsed.condition.label : null,
    defects: Array.isArray(parsed?.condition?.defects) ? parsed.condition.defects.filter((d: unknown) => typeof d === 'string') : [],
    reasoning: typeof parsed?.condition?.reasoning === 'string' ? parsed.condition.reasoning : '',
    uncertain: !!parsed?.condition?.uncertain,
    uncertaintyNote: typeof parsed?.condition?.uncertaintyNote === 'string' && parsed.condition.uncertaintyNote ? parsed.condition.uncertaintyNote : null,
  }

  let retailPriceSek = numOrNull(parsed?.pricing?.retailPriceSek)
  let suggestedPriceSek = numOrNull(parsed?.pricing?.suggestedPriceSek)
  let pricingAvailable = !!parsed?.pricing?.available
  const priceGuardNotes: string[] = []

  // Deterministic guardrails — see "Deterministic guardrails" section above.
  // A hallucinating model can't be prompted out of these; the check just runs.
  if (!isPlausibleRetailPriceSek(retailPriceSek)) {
    priceGuardNotes.push('Ett orimligt nypris upptäcktes och ignorerades.')
    retailPriceSek = null
  }
  if (!isPlausibleRetailPriceSek(suggestedPriceSek)) {
    priceGuardNotes.push('Ett orimligt föreslaget pris upptäcktes och ignorerades.')
    suggestedPriceSek = null
    pricingAvailable = false
  }
  if (retailPriceSek !== null && sources.length > 0 && sources.every((s) => isSecondhandMarketplaceUrl(s.url, s.title))) {
    priceGuardNotes.push('Nypris kunde inte bekräftas från en tillförlitlig källa (endast andrahandsmarknader hittades) och ignorerades.')
    retailPriceSek = null
  }

  const pricing: PricingAssessment = {
    available: pricingAvailable,
    retailPriceSek,
    suggestedPriceSek,
    priceRangeMinSek: numOrNull(parsed?.pricing?.priceRangeMinSek),
    priceRangeMaxSek: numOrNull(parsed?.pricing?.priceRangeMaxSek),
    rationale: typeof parsed?.pricing?.rationale === 'string' && parsed.pricing.rationale ? parsed.pricing.rationale : null,
  }

  const fallbackTitle = [identity.brand, identity.exactProduct || identity.category].filter(Boolean).join(' ').trim() || 'Produkt'
  const listing = {
    title: (typeof parsed?.listing?.title === 'string' && parsed.listing.title) || fallbackTitle,
    description: (typeof parsed?.listing?.description === 'string' && parsed.listing.description) || '',
    conditionText: (typeof parsed?.listing?.conditionText === 'string' && parsed.listing.conditionText) || '',
  }

  const seo = {
    metaTitle: (typeof parsed?.seo?.metaTitle === 'string' && parsed.seo.metaTitle) || listing.title,
    metaDescription: (typeof parsed?.seo?.metaDescription === 'string' && parsed.seo.metaDescription) || listing.description.slice(0, 155),
    imageAlt: (typeof parsed?.seo?.imageAlt === 'string' && parsed.seo.imageAlt) || listing.title,
  }

  const missingNotes: string[] = [
    ...(Array.isArray(parsed?.missingNotes) ? parsed.missingNotes.filter((m: unknown) => typeof m === 'string') : []),
    ...priceGuardNotes,
  ]

  const slug = slugify(fallbackTitle)
  const jsonLd = buildJsonLd(identity, attributes, pricing, listing, slug)

  return { mode, identity, attributes, condition, pricing, listing, seo, sources, missingNotes, slug, jsonLd, websiteAdaptation }
}

// ─── Request validation ──────────────────────────────────────────────────

function validateImages(raw: unknown): UploadedImage[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_IMAGES) return null
  const images: UploadedImage[] = []
  for (const img of raw) {
    if (typeof img !== 'object' || img === null) return null
    const r = img as Record<string, unknown>
    if (typeof r.mimeType !== 'string' || !r.mimeType.startsWith('image/')) return null
    if (typeof r.dataBase64 !== 'string' || !r.dataBase64) return null
    images.push({ mimeType: r.mimeType, dataBase64: r.dataBase64 })
  }
  return images
}

// ─── Handler ─────────────────────────────────────────────────────────────

export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const { request, env } = context

  const contentLength = Number(request.headers.get('content-length') || 0)
  if (contentLength > MAX_BODY_BYTES) return json({ ok: false, error: 'Requesten är för stor.' }, 413)

  let body: GenerateListingRequest
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400)
  }

  // Seller mode is NOT handled here — the consumer seller product has its own
  // latency-bounded endpoint (functions/api/seller/generate.ts). This endpoint
  // is the professional /secondhand pipeline only, and keeps its richer
  // research/SEO behavior unchanged.
  if (body.mode !== 'furniture' && body.mode !== 'fashion') {
    return json({ ok: false, error: 'mode must be "furniture" or "fashion" (seller mode uses /api/seller/generate)' }, 400)
  }

  const images = validateImages(body.images)
  if (!images) return json({ ok: false, error: `images must be an array of 1-${MAX_IMAGES} {mimeType, dataBase64} objects` }, 400)

  const brand = (body.brand || '').trim().slice(0, 120)
  const model = (body.model || '').trim().slice(0, 120)
  const styleCode = (body.styleCode || '').trim().slice(0, 80)
  const size = (body.size || '').trim().slice(0, 40)
  if (body.mode === 'furniture' && (!brand || !model)) {
    return json({ ok: false, error: 'brand and model are required for furniture' }, 400)
  }

  // Optional, best-effort. An unparseable URL is silently treated as "no URL" —
  // personalization is a bonus, never a reason to fail or complicate the request.
  const websiteUrlRaw = (body.websiteUrl || '').trim().slice(0, 300)
  const websiteDomain = websiteUrlRaw ? extractDomain(websiteUrlRaw) : null

  if (!env.GEMINI_API_KEY) {
    return json({ ok: false, error: 'AI-tjänsten är inte konfigurerad. Kontakta Loopa.' }, 503)
  }

  const startedAt = Date.now()

  try {
    let researchText = ''
    let sources: SourceRef[] = []
    let websiteAdaptation: WebsiteAdaptation | null = null
    let researchSucceeded = false

    // Grounded research stage — BOTH modes, and always WITH the seller's
    // images attached (the single call shape verified in the Listing Genie
    // reference: images steer and verify the search). Website-structure lookup
    // is merged into this same grounded call — zero extra Gemini calls.
    // BEST-EFFORT (see failure policy in file header): if both models fail
    // this grounded call, generation continues with empty research instead of
    // failing the whole request — confirmed live that treating this stage as
    // fatal turned a temporary Gemini grounded-search outage into a hard-down
    // endpoint. websiteAdaptation is only claimed if the call that actually
    // performs the lookup succeeded.
    const researchPrompt =
      body.mode === 'furniture'
        ? buildFurnitureResearchPrompt(brand, model, websiteDomain ? websiteUrlRaw : undefined)
        : buildFashionResearchPrompt(brand, styleCode, size, websiteDomain ? websiteUrlRaw : undefined)
    try {
      const researchRes = await callGeminiWithFallback(env, buildGroundedResearchBody(researchPrompt, images), GROUNDED_TIMEOUT_MS, RESEARCH_BUDGET_MS)
      researchText = extractText(researchRes)
      sources = extractSources(researchRes)
      researchSucceeded = true
      if (websiteDomain) websiteAdaptation = { domain: websiteDomain, adapted: true }
      console.log(
        `[generate-listing] stage=research mode=${body.mode} action=ok chars=${researchText.length} sources=${sources.length} website=${websiteDomain ?? 'none'} elapsed_ms=${Date.now() - startedAt}`,
      )
    } catch (err) {
      console.error(
        `[generate-listing] stage=research mode=${body.mode} action=failed continuing_without_research=true elapsed_ms=${Date.now() - startedAt} error=${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
      )
    }

    // Deterministic check, not a model call: does the seller's typed
    // brand/model contradict a variant detail (seat count, footstool) the
    // research actually found? Feeds the structuring prompt AND is re-applied
    // server-side after generation (see shapeResult) so it can't be argued
    // away by the model.
    const variantConflictNote = body.mode === 'furniture' ? checkVariantConsistency(`${brand} ${model}`, researchText) : null

    const hasWebsiteProfile = researchSucceeded && !!websiteDomain
    const structuredPrompt =
      body.mode === 'furniture'
        ? buildFurnitureStructuringPrompt(brand, model, researchText, hasWebsiteProfile, variantConflictNote)
        : buildFashionPrompt(researchText, { brand, styleCode, size }, hasWebsiteProfile)

    const structuredRes = await callGeminiWithFallback(env, buildStructuredBody(structuredPrompt, images, LISTING_RESPONSE_SCHEMA), STRUCTURE_TIMEOUT_MS)
    const rawText = extractText(structuredRes)

    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch {
      throw new Error('AI-svaret kunde inte tolkas som JSON')
    }

    const result = shapeResult(body.mode, parsed, sources, websiteAdaptation, variantConflictNote)
    console.log(
      `[generate-listing] stage=done mode=${body.mode} research_ok=${body.mode !== 'furniture' || researchSucceeded} images=${images.length} total_elapsed_ms=${Date.now() - startedAt}`,
    )
    return json({ ok: true, result }, 200)
  } catch (err) {
    console.error(`[generate-listing] stage=done action=failed total_elapsed_ms=${Date.now() - startedAt} error=`, err)
    // 500, NOT 502: Cloudflare's edge substitutes its own error page for
    // Worker-returned 502/504, destroying this JSON body (see file header).
    return json({ ok: false, error: 'Vi kunde inte generera produkten just nu. Försök igen om en liten stund.' }, 500)
  }
}

export const onRequestGet = async () => json({ ok: false, error: 'method_not_allowed' }, 405)

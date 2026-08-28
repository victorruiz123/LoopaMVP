# Seller MVP architecture

The consumer seller product at `loopa.nu/` — built on the Listing Genie-derived
research core documented in `docs/LOVABLE_VS_LOOPA_LISTING_ANALYSIS.md`. This
doc covers what's new tonight: route separation, the seller flow's domain
model, the two new lightweight AI endpoints, and the engine seams left for
Isac's dedicated condition/pricing engines.

## 1. Seller / B2B route separation

Two products, one deploy, deliberately isolated — no shared chrome, no
cross-links:

| Route | Product | Shell |
|---|---|---|
| `/` (and any unmatched path) | Consumer seller product | `SellerHeader` + `SellerFlow` + `SellerFooter` (`src/pages/SellerPage.tsx`) — Loopa wordmark only, no nav |
| `/company` | Existing B2B homepage | `Nav` + `Footer` (unchanged) |
| `/brands` | Existing brand page | `Nav` + `Footer` (unchanged) |
| `/secondhand` | Existing professional generator | `Nav` + `Footer` (unchanged) |

`src/App.tsx` picks the shell with one `B2B_ROUTES` set check — everything
else falls through to `SellerPage`. `Nav`/`Footer`/B2B pages are untouched;
they already pointed "Home" at `/company` from an earlier session, so no
B2B-side link needed to change. The seller shell has no `LanguageProvider`
(Swedish-only, see §7) and imports nothing from the B2B component tree.

## 2. Two pipelines, deliberately separated

> **Superseded in part.** Seller mode originally shared
> `functions/api/generate-listing.ts` with the professional modes. That is no
> longer true: sharing the professional pipeline's timeouts made seller
> generation take 129–141s and fail with a generic error. Seller generation
> now has its own latency-bounded endpoint. The full measurement, root-cause
> arithmetic and model benchmarks are in
> **`docs/SELLER_GENERATION_PERFORMANCE.md`** — read that before changing
> anything in the seller generation path.

| endpoint | modes | models | shape |
|---|---|---|---|
| `POST /api/generate-listing` | `furniture`, `fashion` (professional, `/secondhand`) | `gemini-3.7-flash` → `gemini-3.6-flash` | grounded research → structuring, with primary→fallback model chains, SEO + JSON-LD |
| `POST /api/seller/generate` | consumer seller (`/`) | `gemini-3.5-flash-lite` | grounded research → structuring, one overall 26s deadline, no fallback chains, **no SEO** |

Why the split rather than a shared pipeline with different constants:

- The heavy research models cannot meet the seller product's 30s ceiling —
  measured `gemini-3.7-flash` + `googleSearch` + 3 images exceeded 90s.
- The seller contract is fundamentally different: a valid submission always
  returns HTTP 200 with a degraded-but-usable result (`status` /
  `missingFields`), never an error. The professional endpoint keeps its
  fatal-structuring behavior.

What is still shared, so it cannot drift:
- `functions/api/_shared/gemini.ts` — call plumbing, timeout/abort handling.
- `functions/api/_shared/listing-guards.ts` — the deterministic guardrails
  (secondhand-domain price exclusion, price plausibility bounds, source
  quality tiers, grounding-chunk source extraction, slug).
- `src/features/generator/schema.ts` — the result contract.

`LISTING_RESPONSE_SCHEMA_SELLER` is still `LISTING_RESPONSE_SCHEMA` with the
`seo` object removed entirely, so the seller structuring call never spends
output tokens on SEO fields the consumer product doesn't use.

## 3. Two new lightweight endpoints

Both are single, small, non-grounded Gemini vision calls (no Google Search
tool) — cheap and fast by design, separate from the heavier shared
research/structuring core.

### `POST /api/seller/review-photo` — ImageReviewEngine

Input: one image + the shot's title/instruction/purpose. Output
(`ImageReviewResult`, `src/features/seller/types.ts`):
```
{ accepted, reason, suggestion, detectedView, confidence }
```
Deliberately lenient prompt (see file header) — rejects only when a photo
would genuinely hurt identification/condition/usefulness, never for
ordinary phone-photo imperfections. **Fails open**: any parse failure,
network error, or endpoint exception returns `accepted: true` rather than
blocking the seller — a broken AI review must never be the reason someone
can't finish selling something.

### `POST /api/seller/shot-plan` — adaptive ShotPlan

Input: the accepted frontal photo + brand + optional note. Output
(`ShotPlan`): `productHint` + `additionalShots` (4-7 shots, clamped
server-side). Combined with the fixed, hardcoded frontal shot
(`src/features/seller/fixedShots.ts` — never AI-planned, a hard product
rule), total guided shots is always 5-8. **Fails open** to a generic,
still-useful fallback plan (angle/detail/label/back-view) on any failure —
verified live: this fallback fired correctly during testing when Gemini
3.7-flash was experiencing a real capacity outage, and the seller flow
continued uninterrupted.

Both share `functions/tsconfig.json` (a project reference the root
`tsconfig.json` doesn't include) — **`functions/` was never actually
type-checked by `npm run build` before this session**; `npm run
check:functions` now covers it, and both should run before considering
either endpoint done.

## 4. SellerSession — client-side state machine

`src/features/seller/SellerFlow.tsx` drives `SellerSessionState`
(`src/features/seller/types.ts`):

```
draft → brand_entered → capturing → analyzing → review → ready_for_marketplace
        (future: → approved → publishing → live → sold → shipping → completed)
```

Only `draft` through `ready_for_marketplace` are implemented tonight — the
full future union is typed now so later stages (Tradera publish, shipping)
are additive, not a rewrite. There is **no server-side session persistence**
yet — the whole flow is client-side React state; a real backend session
would be introduced alongside the Tradera integration (roadmap step 2).

`capturing` internally cycles through `shots: ShotPlanShot[]` (starts as
`[FRONTAL_SHOT]`, extended with the fetched `ShotPlan.additionalShots` after
shot 1 is accepted) — see `CaptureScreen.tsx` for the per-shot
capture → review → accept/reject loop.

## 5. Condition/Pricing engine seams

> Still accurate, with one addition: `PricingResult` now carries a `basis`
> field (`comparables` | `retail` | `estimate` | `none`). A real
> `PricingEngine` must report it honestly — a heuristic number must never be
> presented as if it came from observed comparables.


`src/features/seller/engines.ts` defines `ConditionEngine`/`ConditionResult`
and `PricingEngine`/`PricingResult` **as interfaces**, per the brief. Tonight
there is no separate condition or pricing AI call — both are already produced
as fields inside the single shared structuring call (`result.condition` /
`result.pricing`), so `conditionResultFromGeneratedListing` /
`pricingResultFromGeneratedListing` are thin adapters over that existing
output, not new engines. **This is the honest state of things, not a design
gap**: rebuilding them as separate calls tonight would only multiply Gemini
calls for output the pipeline already produces for free.

When Isac's dedicated engines land, they implement `ConditionEngine`/
`PricingEngine` directly (real service calls) and `SellerFlow`/`ResultScreen`
swap the adapter call for a real engine call. `ConditionResult`/
`PricingResult` — what the UI actually consumes — do not change either way;
`ResultScreen.tsx` never touches `GeneratedListingResult.condition`/`.pricing`
directly.

## 6. MarketplaceListing

`src/features/seller/types.ts`'s `MarketplaceListing` (title, description,
priceSek, conditionLabel, images, attributes) is the thin, stable shape a
future publisher (Tradera, Loopa's own marketplace) will consume.
`marketplaceListingFromGeneratedListing` (`engines.ts`) maps the internal AI
result into it at the `ready_for_marketplace` transition — a publisher
integration is written against this contract, never against the internal
pipeline result type.

## 7. Known scope decisions (read before extending)

- **Swedish-only.** Every seller-facing string is a plain hardcoded Swedish
  string, not routed through the bilingual `Dictionary` (unlike the rest of
  the site). All of the brief's own example copy is Swedish, and the volume
  of new UI text made full EN parity a bad time trade for tonight. Add it as
  a real i18n pass later if the consumer product needs English.
- **Camera capture uses the OS camera app**, not a live `getUserMedia`
  preview — `<input type=file capture=environment>` plus a plain gallery
  picker fallback. Far more reliable across mobile Safari/Chrome than a
  custom camera view; the trade-off is a static framing guide instead of a
  live AR overlay.
- **No server-side SellerSession persistence.** Refreshing mid-flow loses
  progress. Fine for tonight's review build; add persistence alongside real
  publishing.
- **Photo removal is a truncate, not a precise edit.** Removing accepted
  photo *i* discards photos after it too and re-opens shot *i* — simple,
  avoids edge-case bookkeeping bugs, acceptable for an MVP.
- **Dev-only mock mode** (`?mock=1`, `import.meta.env.DEV`-gated, dead-code
  in production builds) lets every screen state be verified without spending
  Gemini calls — see `SellerFlow.tsx`'s `MOCK_MODE` block and
  `src/features/seller/fixtures.ts`.

## 8. Approximate AI-call budget per guided seller session

| Stage | Calls | Notes |
|---|---|---|
| Frontal photo review | 1 | `/api/seller/review-photo`, small non-grounded call |
| Adaptive shot plan | 1 | `/api/seller/shot-plan`, small non-grounded call, right after shot 1 |
| Remaining shot reviews | 3-6 | one per additional shot (plan is sized 4-7 shots) |
| Retakes | 0-N | one extra review call per rejected attempt — the lenient prompt keeps this rare |
| Final analysis | 2 | grounded research + structuring (`seller/generate.ts`); a 3rd only on a structuring failure |
| **Total (typical 5-photo session)** | **~8 calls** | |
| **Total (max 8-photo session, no retakes)** | **~11 calls** | |

Final analysis is measured at **~10s end-to-end** (research ~6.6s +
structuring ~3.5s), bounded by a single 26s request deadline — see
`docs/SELLER_GENERATION_PERFORMANCE.md`. The two small review/plan calls are
designed to feel near-instant (single image, no search tool, low thinking
level, ~15-20s timeout ceiling).

## 9. Real-AI validation notes

Tested live against `/api/seller/review-photo`, `/api/seller/shot-plan`, and
`/api/generate-listing` (mode=seller) via `wrangler pages dev`, using a real
photo from the read-only `IKEA SÖDERHAMN` asset folder (read-only, never
modified):

- **review-photo**: real accept, 95% confidence, ~8s.
- **shot-plan**: real adaptive plan referencing sofa-specific shots (fabric
  close-up, underside-of-cushions, back view, label) — genuinely tailored to
  the photographed product, not generic.
- **generate-listing (seller mode)**: confirmed via a direct, isolated Gemini
  call using the exact same prompt/schema — correctly identified "IKEA
  SÖDERHAMN 3-sits soffa" from **brand="IKEA" + free-text note only, zero
  model field** (the core seller-mode promise), with a real correct retail
  price, sensible suggested price, and no SEO fields requested or returned.
- **A live Gemini 3.7-flash capacity outage** ("high demand" 503, confirmed
  via direct API calls outside this codebase) was active during part of
  testing. It affected the pre-existing furniture mode identically (tested
  side-by-side), confirming this was an upstream, transient issue — not a
  regression introduced by seller mode. The existing primary→fallback
  design absorbed single-model failures correctly throughout (shot-plan's
  fail-open fallback fired exactly as designed); the rare case of *both*
  models failing within one request surfaces as the documented fatal-
  structuring-stage error, unchanged from the already-shipped pipeline.

## 10. Future roadmap boundaries (not built tonight, but fit naturally)

1. Real `ConditionEngine`/`PricingEngine` implementations (Isac) — swap
   behind the existing interfaces in `engines.ts`.
2. Tradera publishing — `ready_for_marketplace` → `publishing` → `live`;
   consumes `MarketplaceListing`.
3. Server-side `SellerSession` persistence — needed once refresh-survival or
   buyer-facing state matters.
4. Truth Card / AI chat / price rationale UI — layers on top of the existing
   `ConditionResult`/`PricingResult` without changing the pipeline.
5. Automated buyer/seller communication, Loopa marketplace, Moova API, brand
   integrations — all downstream of `ready_for_marketplace`, out of scope
   for the contracts defined here.

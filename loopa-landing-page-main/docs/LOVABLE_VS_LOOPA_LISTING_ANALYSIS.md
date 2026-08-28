# Listing Genie (Lovable) vs Loopa — AI listing-generation analysis

Reference Lovable project:
Workspace: VIPS 2.0 lovable
Project: Listing Genie
Project ID: fc2b61c4-e026-42d8-8708-295d33d9950f

Verified via Lovable MCP (`get_project`): display name "Listing Genie", internal name
`furnish-ai-gen`, workspace `OuP2brw6aeIkQLEFmsL7` ("VIPS 2.0 lovable"), latest commit
`5bc68aeb1f42f397394e72a7ab4312f6e5a77aec`. All Listing Genie facts below were read
from that project's actual source via MCP (`src/lib/listing.functions.ts`,
`src/routes/index.tsx`) — no local checkout, no other Lovable project.

> **Supersedes the previous version of this document entirely.** The prior analysis
> compared Loopa against the WRONG Lovable project ("Vips", vips-buy-sell-hub, a
> multi-vendor SerpAPI/Perplexity/GPT-4o pipeline). Every conclusion in that document
> is discarded as evidence. The code changes it motivated are re-judged in §5 against
> the correct reference.

---

## 1. Listing Genie pipeline — as actually implemented

### Client (`src/routes/index.tsx`)
- Images are **downscaled client-side before upload**: `createImageBitmap` → canvas,
  max edge 1024 px, re-encoded as JPEG quality 0.82 (`canvas.toDataURL("image/jpeg", 0.82)`).
  1–6 product images; fashion additionally 0–4 label/care-tag images.
- Seller inputs — furniture: brand (required), model (optional). Fashion: brand
  (required), product name/model, style code/article number, size (all optional),
  plus the label images.
- Two server functions: optional `findProductCandidates` (a "Hitta produkt" search
  that renders a **top-4 candidate picker UI**), then `generateListing` (optionally
  carrying the picked candidate as `selectedProduct` confirmed identity).

### Server (`src/lib/listing.functions.ts`)
- **One grounded Gemini call does everything**: all images inline (`inlineData`
  base64) + one long Swedish prompt, `tools: [{ google_search: {} }]`,
  `serviceTier: "priority"`, `generationConfig: { temperature: 0.2,
  thinkingConfig: { thinkingLevel: "low" } }`.
- Models: `gemini-3.7-flash` primary → `gemini-3.6-flash` fallback. Fallback ONLY on
  429/5xx/timeout/network; jittered 0.5–1.5 s pause before the fallback attempt;
  identical body both attempts.
- **Timeouts: 60 s per attempt, 115 s total budget.** An in-code comment records the
  operational lesson verbatim: *"Grounded searches with images regularly take
  30-60s, so a 25s cap aborted every healthy request and burned the budget before
  the fallback could run."*
- Output is **JSON-in-free-text** (no `responseSchema` — grounding + schema in one
  call is avoided there too): code-fence stripping + first-`{`/last-`}` extraction +
  `JSON.parse`, then per-field `str()` normalization to a `"Not found"` sentinel.
- Prompt behaviors (furniture):
  - Ranked source priority: 1) manufacturer/brand website, 2) **official product
    PDFs/catalogues**, 3) reputable authorized retailers, 4) other credible sources
    only if necessary.
  - "Hitta ALDRIG på specifikationer" — missing fields set to `"Not found"`;
    *"ofullständig research är INTE ett fel"*.
  - MUST always return a professional title + usable Swedish description even if all
    research fails (then based on images + brand/model only, never asserting
    uncertain specs).
  - **Resale-value estimation is a grounded research task**: search actual Swedish
    secondhand prices for the same model (Blocket, Tradera, used-design dealers),
    weigh new price + demand + observed used prices, return a point value
    (`resaleValue`), a range (`resaleRange`) and a 1–2 sentence rationale
    (`resaleRationale`).
  - **`fieldSources`**: a per-field map `{ field: source URL }` so the UI can show
    where each researched value came from.
- Prompt behaviors (fashion): identical skeleton, plus: user-confirmed inputs are
  truth and "får ALDRIG ersättas av svagare AI-gissningar"; label images are read as
  evidence (brand, article number, composition, size, country); identifier weighting
  **style code ≫ exact product name ≫ brand+label info ≫ brand+images**.
- Sources returned = model-listed `sources[]` merged + deduped with real
  `groundingMetadata.groundingChunks` URLs.
- Candidate search stage (`findProductCandidates`): same call shape, returns ≤4
  candidates each with a real source URL; candidates whose domain actually appears
  in the grounding chunks are marked `verified` and sorted first; the UI renders
  them as pick-one cards. **This multi-choice UX is explicitly NOT ported** (see §7).

### What Listing Genie does NOT have
- No SEO output of any kind (no meta title/description, no alt text, no JSON-LD, no
  slug). Loopa's SEO layer is an advantage to preserve, not something to reconcile.
- No condition assessment (its listings don't grade skick from photos).
- No response schema, no server-side numeric plausibility checks, no domain
  blocklists — its structural rigor lives in the prompt + `str()`/URL filtering.

---

## 2. Loopa pipeline — current (`functions/api/generate-listing.ts`)

- Client sends **raw, un-resized images** as base64 (`filesToUploadedImages`), body
  cap 26 MB.
- Furniture: **two calls.** Stage 1 = grounded research (googleSearch tool) that is
  **text-only — the images are NOT attached**, temperature 0.1, no thinking config,
  no service tier, **25 s timeout per attempt**. Stage 2 = structuring call with the
  images + `responseSchema` (temperature 0.15), which judges condition from photos
  and cross-checks the seller's claimed identity (confidence/uncertain idiom).
- Fashion: **zero grounded research** — one vision-only structured call.
- Research is best-effort (continues with empty research when both models fail);
  structuring is fatal. Primary→fallback on 429/5xx/timeout, no jitter, no total
  budget.
- Deterministic post-processing: secondhand-marketplace domains never trusted for
  nypris, retail-price plausibility bounds, variant-token consistency check, source
  quality tiers, slug + JSON-LD + full SEO block.

---

## 3. Exact differences (comparison matrix)

| # | Dimension | Listing Genie | Loopa (before this port) |
|---|---|---|---|
| 1 | Models | gemini-3.7-flash → gemini-3.6-flash | identical |
| 2 | Gemini calls | 1 (+1 optional candidate search) | furniture 2; fashion 1 (+1 optional site profile) |
| 3 | Call order | single grounded do-everything call | research → structure |
| 4 | Identify vs generate stages | merged in one grounded call | split; fashion never researches |
| 5 | Grounding | `google_search` on the ONE call that also sees the images | furniture research only, images NOT attached; fashion none |
| 6 | Search instructions | ranked source priority incl. official PDFs; resale comps search | source priority partial, no PDF tier, no comps search |
| 7 | System prompt | none (all in user prompt, Swedish) | same pattern |
| 8 | User prompts | research+listing+valuation in one | split research / structuring prompts |
| 9 | Seller context | brand required; fashion styleCode/size/label images, "user values are truth" | furniture brand+model required; fashion NO text inputs |
| 10 | Image count | 1–6 (+4 labels fashion) | 2–6 furniture / 2–8 (+4 labels) fashion |
| 11 | Image order | product images then labels, prompt last | prompt first, then images (structuring only) |
| 12 | Image resizing | client-side ≤1024 px JPEG q0.82 | none — raw upload |
| 13 | MIME | always image/jpeg after re-encode | original file MIME passthrough |
| 14 | Identification instructions | grounded search steered by what the photos show | text-only search; photo check only at structuring |
| 15 | Exact-variant logic | candidate picker + confirmed-identity injection | deterministic variant-token conflict check |
| 16 | Confidence handling | candidate confidence 0–100 (picker stage only) | identity.confidence high/medium/low + uncertain flag |
| 17 | Anti-hallucination | "Hitta ALDRIG på", Not found sentinel, always-produce-listing | same spirit + schema + deterministic guards |
| 18 | Source requirements | model sources ∪ grounding chunks, deduped; candidate URLs must parse | grounding chunks only, never model-retyped |
| 19 | Spec extraction | fixed field list per category | flexible attributes[] array |
| 20 | Structured output | JSON-in-text + manual extraction | responseMimeType + responseSchema |
| 21/22 | Generation config / temperature | 0.2, priority tier | 0.1 research / 0.15 structure, no tier |
| 23 | Thinking | thinkingLevel "low" explicitly | unset (model default) |
| 24 | Output limits | none set | none set |
| 25 | Timeouts | **60 s/attempt, 115 s budget** | **25 s/attempt** |
| 26 | Retry/fallback | 1 fallback, 0.5–1.5 s jitter, budget-capped | 1 fallback, immediate |
| 27 | Research → generation | same call | research text pasted into structuring prompt |
| 28 | Parsing | fence-strip + brace-extract | strict JSON.parse of schema output |
| 29 | Validation | str() sentinel, URL regex, user-values-win | type guards, plausibility bounds, domain checks |
| 30 | Post-processing | source dedupe, fieldSources | + SEO, JSON-LD, slug, price guards |

---

## 4. Top quality-critical differences & why Listing Genie performs better

1. **The grounded research sees the photos.** Listing Genie's only call gets images
   + Google Search together, so the search is steered and verified by what is
   actually photographed (variant, base, colour, label text). Loopa's research call
   was blind text ("brand + model"), so a wrong/ambiguous seller claim researched
   the wrong thing and the photos couldn't correct it until it was too late.
2. **Timeout reality.** Listing Genie's code documents that grounded search with
   images takes 30–60 s and that a 25 s cap "aborted every healthy request". Loopa's
   grounded call ran under exactly that 25 s cap — and because research is
   best-effort, timeouts didn't error, they **silently produced research-free,
   spec-poor listings**. This is the most likely single biggest driver of the
   observed quality gap.
3. **Fashion had no research at all** in Loopa. Listing Genie researches garments
   with the style code as the dominant identifier and reads label photos as
   evidence — that is where its fashion listings get real product names,
   compositions and nypris from.
4. **Latency config that makes long grounded calls viable**: `serviceTier:
   "priority"` + `thinkingConfig: { thinkingLevel: "low" }`. Loopa set neither, so
   its grounded calls were both slower and more timeout-prone.
5. **Grounded resale valuation + per-field sources.** Listing Genie searches actual
   secondhand comps (Blocket/Tradera/dealers) and returns value + range + rationale,
   plus a `fieldSources` map that makes each fact auditable. Loopa priced only from
   nypris + condition with no market evidence, and had only an undifferentiated
   source list.
6. **Raw image upload** in Loopa (vs ≤1024 px JPEG) inflates payloads and Gemini
   latency for zero quality benefit at these resolutions.

Not a factor: model choice (identical), fallback model (identical), schema use
(Loopa's is stricter and fine), SEO (Listing Genie has none).

---

## 5. Previous wrong-project code changes — verdict per change

These were added to Loopa based on the wrong reference. Judged now against Listing
Genie and on their own merits:

**Kept (independently useful, consistent with Listing Genie's behavior):**
- `identity.confidence` / `identity.uncertain` / `uncertaintyNote` + the photo-
  corroboration instruction — this is exactly how Loopa satisfies "single best-
  supported product, show uncertainty gracefully" without a candidate picker.
- Secondhand-marketplace domain exclusion **for nypris** — matches Listing Genie's
  own split (manufacturer sources for nypris; marketplaces only for resale value).
- Retail-price plausibility bounds (`isPlausibleRetailPriceSek`) — cheap, harmless
  nonsense catcher.
- `sourceQualityTier` on sources — additive trust signal, analogous to Listing
  Genie's `verified` grounding-domain flag.
- `checkVariantConsistency` deterministic variant cross-check — not in Listing
  Genie, but deterministic, zero-cost and only ever raises uncertainty.
- Structuring temperature 0.15 — within the same band as Listing Genie's 0.2;
  not quality-critical either way.

**Removed/replaced:**
- All code comments attributing these mechanisms to the "sibling product's
  (Lovable-built) pipeline" / SerpAPI / Perplexity / GPT-4o — rewritten, since that
  evidence chain was from the wrong project. The mechanisms stand on their own and
  on Listing Genie-verified behavior.
- The previous document's conclusions (reverse-image search as "the biggest
  driver", multi-vendor architecture as the advantage, SerpAPI recommendation) —
  **discarded**. The correct reference achieves its quality with a single
  well-configured grounded Gemini call.

**Irrelevant (no action):** none of the wrong-project changes conflict with
Listing Genie behavior; nothing had to be functionally reverted.

---

## 6. What was ported (this session)

All behavior, no Lovable infrastructure:

1. **Images attached to the furniture grounded research call** (Listing Genie call
   shape: images + prompt + google_search in one request), with the prompt told to
   use the photos to steer/verify the search.
2. **Grounded research added for fashion** — same call shape; reads label photos as
   evidence, weights style code ≫ product name ≫ brand+labels ≫ brand+images.
3. **60 s grounded-call timeout** (structuring stays 25 s), jittered 0.5–1.5 s
   pause before fallback, total research budget cap — Listing Genie's documented
   timeout lesson.
4. **`serviceTier: "priority"` + `thinkingConfig: { thinkingLevel: "low" }`** on
   grounded calls.
5. **Ranked source priority incl. official product PDFs/catalogues** in research
   prompts.
6. **Grounded resale-market valuation**: research prompt searches Swedish
   secondhand comps; structuring bases `suggestedPriceSek`/range/rationale on them
   (marketplaces stay banned for nypris).
7. **Per-field source attribution** (Listing Genie's `fieldSources`, adapted):
   attributes may carry a `sourceUrl` taken from research-cited URLs, https-
   validated server-side, rendered as a small source link.
8. **Client-side image downscale** to ≤1024 px JPEG q0.82 (with raw-file fallback
   if decoding fails).
9. **Optional fashion inputs** (brand, style code, size) + label-image evidence
   flow; user-typed values win over weaker AI guesses (Listing Genie's
   "user values are truth" rule, kept compatible with Loopa's uncertainty idiom).

**Deliberately NOT copied:**
- The candidate search stage + "Är det någon av dessa?" top-4 picker UI and the
  `selectedProduct` confirmed-identity round-trip (multi-choice product UX —
  excluded by requirement; Loopa returns the single best-supported product and
  flags uncertainty inline instead).
- JSON-in-free-text parsing for the final result (Loopa's responseSchema
  structuring is stricter; kept).
- TanStack server functions / Lovable runtime, shadcn styling, its result-page
  design, its "Not found" sentinel string convention (Loopa uses null/omission).
- Dropping condition assessment or SEO to match Listing Genie's narrower output —
  Loopa keeps both.

---

## 7. UX — adapted vs rejected

**Adapted (rebranded into Loopa's existing visual language):**
- Fashion "what you know" inputs (brand/style code/size) with clear optional
  labeling — Listing Genie demonstrates these materially improve identification.
- Long-run loading honesty: after ~65 s the loading note switches to a "still
  working — research is taking a little longer" message (adaptation of Listing
  Genie's `fallbackPhase` message), instead of cycling the same steps silently.
- Per-fact source links next to researched values (fieldSources idea) in Loopa's
  existing link styling.

**Deliberately rejected:**
- The top-4 product-candidate picker ("Välj denna" cards, confidence %, candidate
  images) — excluded by requirement. **No multi-choice product UX was added.**
- "Fortsätt utan exakt match"/"Ingen av dessa" branching — same reason.
- Listing Genie's page design, typography, rounded-none aesthetic, result layout —
  Loopa's /secondhand design is kept unchanged.
- Its every-field-inline-editable result editor — Loopa's result view already
  communicates editability (`redigerbar` hints) in its own design; a full editor
  rebuild is out of scope and not quality-critical to the listing itself.

## 8. Post-port validation (local wrangler dev, real Gemini)

- Deterministic: `npm run build` + `tsc -b` clean; oxlint = pre-existing warnings
  only; five validation-path requests (bad mode, no images, missing brand,
  invalid JSON, non-image MIME) all returned 400 before any Gemini call.
- Furniture live run (3 compressed IKEA Söderhamn photos, brand+model typed):
  43.9 s total. The grounded-research-with-images stage identified the exact
  **variant from the photos** ("3-sits sektion, utan armstöd" — the armless
  section, not the generic sofa), confidence high, 10/10 attributes populated,
  **all 10 with real source URLs** (ikea.com product pages, retailers), pricing
  based on observed secondhand comps with range + rationale
  ("observerade andrahandspriser 1 000–3 000 SEK … nypris 4 095–5 095 SEK"),
  full SEO block intact. This is exactly the Listing Genie behavior profile.
- Fashion live run (deliberate mismatch: sofa photo + typed "Acne Studios",
  style code B90371-900, size M — no garment photos exist in the repo):
  55.3 s. The new grounded fashion research resolved the style code to the real
  product, priced from observed comps (900–2 000 SEK), honored user-typed size,
  and honestly flagged the photo mismatch ("Bilden … föreställer en soffa och
  inte plagget") with condition unverifiable. One tightening was made after
  this run: the fashion prompt now forces `identity.uncertain=true` +
  confidence "low" when the photos clearly do not show the identified product.

## 9. Explicit confirmations

- **SEO stays**: metaTitle, metaDescription, imageAlt, JSON-LD, slug, structured
  attributes — all preserved and still produced (Listing Genie has no SEO layer at
  all; nothing was removed to match it).
- **Multi-choice product UX will NOT be added** — confirmed; Loopa returns one
  best-supported product and shows uncertainty gracefully via the existing
  identity-uncertain badge.
- **Loopa's visual identity and /secondhand design are unchanged**; only the small
  UX adaptations listed in §7.
- `/brands`, `functions/api/brand-preview.ts` and the contact flow are untouched.

# Seller generation — latency & reliability rebuild

Scope: the consumer seller product's FINAL generation step only
(`loopa.nu/` → accepted photos → listing). The professional `/secondhand`
pipeline (`functions/api/generate-listing.ts`) keeps its richer research and
SEO behavior unchanged — see §7.

Product requirements this work is measured against:

1. **Speed** — submit → usable listing in **under 15s**; a valid submission
   must **never** sit generating for more than **30s**.
2. **Always return something useful** — once a valid seller session reaches
   generation, the seller must never land on a generic error screen.

---

## 1. Baseline — the failure, reproduced and measured

Reproduced locally via `wrangler pages dev dist` against the real endpoint
with 5 real seller photos (`IKEA SÖDERHAMN/`, 1024px/q82, 0.92 MB base64
payload), using `scripts/bench-seller.mjs`:

| run | submit → result | outcome |
|---|---|---|
| A | **129.1s** | HTTP 200, succeeded |
| B | **141.4s** | **HTTP 500 — "Vi kunde inte generera produkten just nu."** |

Run B is the exact failure that triggered this work.

### Root cause (arithmetic, not inference)

Seller mode reused the professional pipeline: two sequential AI stages, each
with its own sequential primary→fallback **model chain**.

| step | config | worst case |
|---|---|---|
| grounded research, primary `gemini-3.7-flash` | `GROUNDED_TIMEOUT_MS` 60s | 60.0s |
| jittered pause before fallback | 0.5–1.5s | 1.5s |
| grounded research, fallback `gemini-3.6-flash` | capped by `RESEARCH_BUDGET_MS` 90s | 28.5s |
| structuring, primary `gemini-3.7-flash` | `STRUCTURE_TIMEOUT_MS` 25s | 25.0s |
| jittered pause before fallback | 0.5–1.5s | 1.5s |
| structuring, fallback `gemini-3.6-flash` | 25s | 25.0s |
| **total** | | **141.5s** |

Measured run B was **141.4s** — within 0.1s of the theoretical maximum, i.e.
all four Gemini attempts ran to their full timeout and the seller then got a
generic error. Two separate defects:

- **Latency**: four chained attempts with timeouts sized for a professional
  research workflow, not a consumer flow.
- **Reliability**: the structuring stage was fatal → HTTP 500 → dead end.

Client preprocessing was never the problem: 0.6–1.3s to resize 5 photos, and
the upload payload was already only 0.92 MB (the client already downscales to
1024px/q82).

---

## 2. Model benchmark — why the heavy models cannot be used here

Grounded (`googleSearch`) latency measured per model and image count against
the same real photos (`scripts/bench-gemini-matrix.mjs`,
`bench-gemini-matrix2.mjs`):

| model | images | latency | found dims | found price | identified SÖDERHAMN |
|---|---|---|---|---|---|
| `gemini-3.7-flash` | 5 | **>120s** (aborted) | — | — | — |
| `gemini-3.7-flash` | 3 | **>90s** (aborted) | — | — | — |
| `gemini-3.6-flash` | 3 | 48.7s | yes | yes | yes |
| `gemini-3.6-flash` | 2 | 19.4s | yes | yes | — |
| `gemini-3.5-flash-lite` | 5 | **8.0s** | yes | yes | yes |
| `gemini-3.5-flash-lite` | 3 | **6.2s** | yes | yes | yes |
| `gemini-3.5-flash-lite` | 2 | **3.6s** | yes | yes | yes |

Two conclusions:

- The intended research models (`gemini-3.7-flash` → `gemini-3.6-flash`)
  **cannot** meet a 30s ceiling for this task today. Keeping them on the
  seller path would guarantee the failure this work exists to remove.
- **Grounded latency scales steeply with image payload** — hence the research
  call is capped at 3 images (`RESEARCH_IMAGE_CAP`).

`gemini-3.5-flash-lite` identified the exact model with real dimensions, a
real retail price and real grounding chunks — the same identification quality
the 129s pipeline produced.

---

## 3. Why the single-call "Listing Genie" shape does NOT work here

The one-grounded-call architecture (one call that searches AND returns the
structured result) was implemented and benchmarked **first**. It does not
survive contact with this model.

Measured across three prompt shapes
(`scripts/bench-grounding-activation.mjs`, `bench-grounding-hybrid.mjs`), all
`gemini-3.5-flash-lite` + `googleSearch` + the same 5 images:

| prompt shape | groundingChunks | search queries | result |
|---|---|---|---|
| free-text research prompt | 2–5 | 2 real queries | genuine research |
| JSON-contract prompt | **0** | **0** | answered from memory |
| research-first, JSON appended at end | **0** | **0** | every field `null` |

Asking for JSON output **suppresses the search tool entirely**. Worse than
slow: with the JSON prompt the model invented a *different* retail price on
each run — **4095 / 5495 / 6395 kr** — while still populating `sourceUrl`
fields with URLs it had never seen.

A pipeline whose "research" is fabricated recall with fabricated citations is
not acceptable, so the research stage stays a **separate free-text grounded
call**. That second call was never what made the old pipeline slow — the
sequential model fallback chains were (§1). At flash-lite speed the two calls
together land at ~10s.

---

## 4. New seller pipeline

`functions/api/seller/generate.ts` — `POST /api/seller/generate`.

```
ONE overall deadline (AbortController), OVERALL_DEADLINE_MS = 26s

t=0     RESEARCH   grounded free-text, googleSearch, ≤3 images
                   gemini-3.5-flash-lite, budget 9s
                   BEST EFFORT — failure just empties the research text
                   and never blocks

        ↳ if it returned text but ZERO grounding chunks (recall, not
          research): discard it and retry ONCE, budget 7s, only while
          ≥15s of deadline remains. A hard failure is NOT retried — it
          already burned its budget, and that time belongs to structuring.

t≈6s    STRUCTURE  no tools, strict responseSchema, ≤6 images
                   gemini-3.5-flash-lite, budget 10s
                   identity + specs + condition + pricing + listing
                   condition judged ONLY from the seller's photos

fail    RETRY      one bounded retry, ≤2 images, budget 5s,
                   only if the deadline allows

fail    EMERGENCY  deterministic result from SellerSession data

always  HTTP 200, ok:true
```

Worst case by construction: research 9s + research retry 7s + structuring 10s
= **26s**, hard-stopped at the deadline (the structuring call is clamped to
whatever time is left, so it cannot overrun). Every call is additionally bound
to the overall `AbortSignal`, so nothing in flight can outlive the deadline.
End-to-end that is ~27s including client preprocessing — under the 30s limit,
and no code path waits deliberately beyond it.

**What was removed:** both sequential primary→fallback *model* chains (4
attempts → at most 3, normally 2), the 60s/25s professional timeouts, and the
90s research budget.

**Gemini calls per normal seller generation: 2** (1 grounded + 1 structured) —
the same count as before, but bounded and on a model that answers in seconds.
A 3rd call occurs only on a degraded run: an ungrounded research result, or a
failed structuring attempt.

---

## 5. Result contract — partial success IS success

A valid submission (brand + 1–10 images) always returns **HTTP 200 /
`ok: true`**. HTTP 4xx/5xx is reserved for invalid requests and an
unconfigured API key.

```ts
status: 'full' | 'partial' | 'fallback'
missingFields: ('dimensions'|'material'|'newPrice'|'model'|'variant'|'price'|'condition')[]
warnings: string[]
researchUnavailable: boolean
pricing.basis: 'comparables' | 'retail' | 'estimate' | 'none'
```

- `full` — research landed and every important spec came back.
- `partial` — research landed, some important specs unverified.
- `fallback` — no usable grounded research; identity/specs limited to what the
  photos and the seller's own input support.

`missingFields` is derived **in plain code** from the assembled result, never
taken from the model's own account of what it was missing — a model that
hallucinated a dimension would also leave it off its own list.

### Anti-hallucination guards (deterministic, server-side)

- `sourceUrl` is kept only when that exact URL appears in the research text.
  Necessary, not paranoid: with no research to draw on the model was observed
  inventing plausible source URLs.
- A retail price is dropped when research did not run at all, and when every
  source is a secondhand marketplace (a marketplace shows resale value, never
  nypris).
- Retail-price plausibility bounds (50–300 000 kr).
- `pricing.basis` is re-derived server-side, so a run with no research cannot
  label its own guess `comparables`.

These live in `functions/api/_shared/listing-guards.ts`, shared with the
professional pipeline so the rules cannot drift apart.

### Graceful degradation of each stage

| stage | if it fails |
|---|---|
| research | empty research text; structuring proceeds; `researchUnavailable: true` |
| condition | truthful minimal wording — "Begagnat skick", never an invented defect |
| pricing | `basis: 'estimate'` from brand + type + visible condition; `'none'` only with no defensible basis |
| listing | title/description synthesized from brand + category + seller note |
| structuring | one bounded retry, then the deterministic emergency result |

**No SEO is generated in seller mode.** No model is asked for
metaTitle/metaDescription/JSON-LD. The `seo` fields required by the shared
result type are derived from the listing text at zero token cost, and
`jsonLd` is always `null`.

---

## 6. Results

### Real end-to-end benchmark (live Gemini, 5 photos)

Eleven real runs, `submit → result` including client preprocessing:

```
8.4  8.8  8.9  9.1  9.2  10.4  10.9  12.0  15.6  17.3  17.6   (seconds)
median 10.4s   |   8 of 11 under 15s   |   max 17.6s   |   0 failures
```

Representative fast run:

```
client preprocess:      630 ms
upload + server + down: 8 315 ms
TOTAL submit → result:  8 945 ms
server: research 5 599 ms | structure 2 566 ms | total 8 171 ms
gemini calls: 2 (1 grounded) | payload 0.92 MB
```

| | before | after |
|---|---|---|
| submit → result | 129.1s / **141.4s (failed)** | **median 10.4s** |
| worst observed | 141.4s (error) | 17.6s (complete result) |
| worst case by construction | 141.5s | **26s server / ~27s end-to-end** |
| generic error possible after valid submit | **yes** | **no** |

**The <15s target is met on the median (10.4s) and in 8 of 11 runs, but not
universally — and the remaining variance is external.** What is under our
control is fixed: call count, image payload, per-call budgets, and one hard
deadline. What is not: Gemini's own per-call latency, measured across these
runs at **4.3–8.2s for research** and **2.5–6.7s for structuring**, plus
whether `googleSearch` fires at all on a given call.

The three runs over 15s break down as:

- **15.6s** — no retry, purely upstream latency (research 8.2s + structuring
  6.7s, both inside their budgets).
- **17.6s** — first research came back ungrounded, retry fired and grounded
  properly, turning what would have been a generic "IKEA soffa" into a
  complete `full` result with dimensions and a comparables-based price.
- **17.3s** — retry fired and the second attempt was ungrounded too, so the
  result still degraded to `fallback` (with an estimate price).

The research retry is therefore a real trade: it costs ~7s when it fires and
recovered a full result in roughly half the observed cases. It is kept because
specs and price are the core value of the flow, and even the worst case stays
far inside the 30s limit. Removing it would put every run under ~12s at the
cost of shipping spec-less listings more often — a one-line change
(`RESEARCH_RETRY_BUDGET_MS` / the `canRetry` guard) if that trade is ever
judged differently.

Identification itself also varies run to run (SÖDERHAMN in most runs, a
different IKEA sofa model in one) — that is model variance on a genuinely
ambiguous product, surfaced through `identity.confidence`/`uncertain` rather
than hidden.

Typical product output (`status: full`): *IKEA SÖDERHAMN 3-sitssoffa*, bredd
186 cm / djup 99 cm / höjd 83 cm (source-linked), material, nypris 4 095 kr,
recommended 2 000 kr (range 1 500–3 000, basis `comparables`), condition "Fint
begagnat skick", `missingFields: []`.

### Grounding fires as a RATE, not a guarantee

Across real runs, the research call sometimes returns prose with **zero**
grounding chunks — the model answering from memory. The endpoint discards that
text (it is exactly what invents dimensions and prices) and retries research
once when the budget allows. Measured prompt reliability
(`scripts/bench-research-reliability.mjs`, 3 runs each): both the soft
"Använd Google Search…" phrasing and the adopted "SÖK FÖRST / your memory is
not a source" phrasing grounded 3/3, but the adopted one identified the exact
model 3/3 vs 2/3 and averaged 5.8s vs 6.1s.

### Degradation tests

`scripts/test-seller-degradation.mjs` drives the real endpoint through
wrangler while `scripts/mock-gemini.mjs` impersonates the upstream via
`AI_GATEWAY_URL` — real timeouts, real retry, real assembly, **zero Gemini
spend**. All checks pass:

| test | scenario | result |
|---|---|---|
| A | good research | `full`, specs + comparables price, 2 calls |
| B | specs unavailable | `partial`, missingFields listed, no invented dims |
| C | research times out | `fallback` at 9.1s, structuring still ran, estimate price |
| C2 | research ungrounded (recall) | discarded, retried, recovered to `full` with real dims |
| D | research 5xx | `fallback` in 0.13s, no invented nypris |
| D2 | structuring fails once | bounded retry recovered a real listing |
| E | everything fails | emergency listing from brand + seller note, no invented specs |

Plus: invalid requests still return 400.

---

## 7. `/secondhand` is unchanged

Seller mode was **removed** from `functions/api/generate-listing.ts`, which is
now the professional pipeline only (`furniture` | `fashion`). Its models
(`gemini-3.7-flash` → `gemini-3.6-flash`, serviceTier `priority`), timeouts,
research→structuring flow, SEO block, JSON-LD and slug derivation are all
untouched. The only change beyond deleting the seller branches: the shared
deterministic guards moved to `_shared/listing-guards.ts` (a pure extraction,
same behavior).

Verified with `scripts/smoke-secondhand.mjs`:

- furniture run completed in 130.9s, HTTP 200, with **metaTitle,
  metaDescription, imageAlt, slug and jsonLd all generated** — SEO preserved.
- seller mode is now correctly rejected here (400, pointing at the new
  endpoint); furniture's brand+model validation is unchanged.

A later identical run returned the pipeline's controlled 500 after 136.3s.
**That is pre-existing upstream behavior, not a regression from this work**:
it is exactly the four-timeout arithmetic in §1, driven by the heavy-model
grounded latency measured in §2 (`gemini-3.7-flash` + `googleSearch` > 90s).
The professional pipeline is intermittently affected by the same upstream
condition that made it unusable for the seller flow. Fixing that is out of
scope here — `/secondhand` was explicitly not to be redesigned — but it is
the obvious next candidate for the same treatment.

---

## 8. Scripts

| script | purpose |
|---|---|
| `bench-seller.mjs` | end-to-end submit → result latency + result summary |
| `bench-gemini-direct.mjs` | isolated call-shape latency (grounded vs fast) |
| `bench-gemini-matrix.mjs` / `-matrix2.mjs` | grounded latency by model × image count |
| `bench-grounding-activation.mjs` | does the prompt shape actually trigger search |
| `bench-grounding-hybrid.mjs` | can one call both search and emit JSON (no) |
| `mock-gemini.mjs` | scenario-driven fake upstream for failure tests |
| `test-seller-degradation.mjs` | TEST A–E degradation suite |
| `smoke-secondhand.mjs` | `/secondhand` regression check |

To run the degradation suite, point `AI_GATEWAY_URL` in `.dev.vars` at
`http://127.0.0.1:8799`, start `mock-gemini.mjs` and `wrangler pages dev
dist`, then run the suite — and restore `.dev.vars` afterwards.

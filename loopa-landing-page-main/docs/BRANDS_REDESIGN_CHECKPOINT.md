# /brands Redesign Checkpoint

> Status: **DIRECTION APPROVED — NOT YET IMPLEMENTED.**
> This file captures the complete creative-direction / conversion audit of `/brands`
> so a fresh session can implement it without rerunning the audit.
> Scope: frontend only (`src/pages/BrandsPage.tsx`, `src/i18n/dictionary.ts` → `brandsPage`,
> `src/index.css`, assets). Backend (`functions/api/brand-preview.ts`) is working and out of scope.

---

## 0. Context a fresh session needs

- `/brands` today is 11 stacked sections in `src/pages/BrandsPage.tsx`:
  `HeroAndStory` → `LostOpportunity` → `PersonalizationInput` → `InteractiveExperience` →
  `TwoMockups` → `SellerLoop` → `WhyDifferent` → `FlexibleImplementation` → `CommercialValue` →
  `BuyerTrust` (+ `Triangle`) → `FinalCta`.
- All copy lives in `src/i18n/dictionary.ts` under `brandsPage` (both `sv` and `en` must be edited together).
- The personalized preview backend (`POST /api/brand-preview`) works in production and returns
  `{ companyName, tone, resaleTermStyle, category, products[] }` with ≥6 verified same-brand
  products, or `result: null` (frontend then shows the illustrative fallback). Known-good demo
  domains (verified live): `deadwoodstudios.com` (fashion), `houseofdagmar.com` (fashion),
  `mio.se` (furniture), `swedese.se` (furniture), `iittala.com` (interior).
- Design tokens in `src/index.css`: cream `#faf7f1`, ink `#14110d`, accent orange `#e4572e`,
  Inter, `.container-loopa` max-w 1200px.
- **KNOWN CSS BUG (P0, also affects redesign):** `index.css` declares
  `h1,h2,h3,h4 { color: var(--color-ink) }` as *unlayered* CSS. In Tailwind v4, unlayered author
  CSS beats layered utilities, so `text-white` on any h1–h4 silently loses → `FinalCta`'s first
  heading line renders ink-on-ink (invisible) in production. Fix by moving the base heading rule
  into `@layer base` (or removing the color from it). Spans are unaffected, which is why accent
  spans inside headings still show.

## 1. The 5-second positioning

The page must communicate, in order, within seconds:

**"Era produkter säljs redan vidare — utan er → äg kanalen själva → det ger intäkter, återvändande kunder och data → Loopa sköter den svåra delen → skriv in er URL och se ER egen secondhandbutik."**

Products are already being resold → the brand should own that channel → owning it = revenue +
returning customers + data → Loopa runs the hard technology/automation part. The live personalized
preview (your URL → your storefront in ~10s) is the unfair advantage vs Trove/Archive — neither can
demo the prospect's own store instantly. Today it is buried; it becomes the centerpiece.

## 2. New page hierarchy (11 sections → 7)

| # | Section | ONE message | Dominant element | Text budget |
|---|---------|-------------|------------------|-------------|
| 1 | **Hero** | Your products are already resold; own it | Headline at ~72px display | ~35 words |
| 2 | **Value wall** | This is a growth channel (revenue/customers/data) | 3–4 huge display numerals (80–96px), market-level stats with sources | 1 line per stat |
| 3 | **Personalized preview stage** | This is YOUR resale channel | The storefront mockup (60–70% viewport), transforming in place | Input + status + 1 disclaimer |
| 4 | **Own it or lose it** | Customer resells either way; only question is where | Today-vs-with-Loopa contrast, no cards | ~50 words |
| 5 | **Loopa runs the hard part** | Store is easy; automation is the moat | AI condition-assessment proof card | 4 static steps + 1 pipeline line |
| 6 | **Your model, your setup** | Starts small, fits existing stack, no mega-project | 3 route cards (single appearance) | Routes + 2–3 integration lines |
| 7 | **Final CTA** | Talk to us | 56–72px heading on ink (bug fixed) | Heading + 1 line + 1 CTA |

## 3. Delete / merge list

- **DELETE `SellerLoop`** — its one idea (store credit → return visit) becomes a value pillar in §2.
- **DELETE `FlexibleImplementation`** — duplicates the route cards; keep only
  "Loopa anpassas efter er verksamhet, inte tvärtom" + start-small idea, folded into section 6.
- **DELETE the `TwoMockups` mode tabs** (`På produktsidan`/`Egen butik`/`Båda`) — show both, always.
- **DELETE the "Fysiskt verifierad" toggle** in `BuyerTrust` (internal edge case as UI).
- **DELETE the dashed SVG `Triangle`** — replace with 3 short text lines if kept at all.
- **DELETE the secondary "Se Loopa för secondhandaktörer" link in `FinalCta`** (no exit ramp at close).
- **MERGE `PersonalizationInput` + `InteractiveExperience` (before/after) + `TwoMockups`** into the
  single preview stage (section 3). They already share `featuredProduct()` data.
- **MERGE `WhyDifferent` into how-it-works** (section 5) — its headline
  "En secondhandbutik är den enkla delen." is the best line on the page; opens the section.
- **MERGE `LostOpportunity`'s 3 value columns into the value wall** (§2); keep its today/with-Loopa
  contrast as section 4, stripped of card chrome.
- **Consolidate hedge labels** ("Illustrativt exempel", "(exempel)", "Illustrativ integration"…)
  from ~9 occurrences to one elegant convention, max once per mockup.

## 4. Art direction

- **Typography:** display 72–96px clamp (hero, stat numerals, final CTA); H2 48–56px; lead 18px;
  body 15px; kill 10–11px except true legal. Optionally one characterful display face (editorial
  serif à la Archive's stats, or a tighter grotesk) used ONLY for hero + numerals; Inter keeps UI.
- **Spacing:** desktop section padding 120–160px (from today's 64–80). 8pt rhythm.
- **Section rhythm:** replace every `border-t` seam with deliberate background alternation
  cream → white → tinted → cream → ink.
- **Cards:** max two card-objects per viewport. Browser mockups earn elevation (bigger soft
  shadows, slight overlap/offset composition, Trove-collage style). Informational content gets
  NO box — headline + text on open background.
- **Accent discipline:** orange reserved for primary CTA, one emphasized word/number per section,
  and the live "found your products" state. Everything else ink + warm greys.
- **Imagery:** clean product-only packshots on light studio backgrounds.
  **Remove the Kånken pile photo** (`/assets/brand-examples/kanken-product-crop.webp` usage in hero).
  The real fetched product images in the preview are the best imagery — frame generously.
- **Motion:** REMOVE the autoplaying `SellerStoryCard` (3.2s interval). Whole-page motion budget =
  the preview transformation (skeleton → products cascading in). Steps in section 5 may
  scroll-reveal; nothing autoplays.
- **CTA treatment:** one primary per screen; the preview-success CTA and final CTA are the two
  conversion points.

## 5. Value story (copy direction)

Feature copy currently holds the big-type positions; value copy the small ones. Invert.

- Hero headline (keep): "Era produkter säljs redan igen. / Gör ert varumärke till en del av nästa
  försäljning." New value-led subtitle: *"En egen secondhandkanal som skapar nya intäkter, tar
  kunder tillbaka — och där Loopa sköter det svåra."*
- Value wall pillars (promoted from the old `CommercialValue` 14px grid):
  **Behåll kunden. Skapa intäkter. Äg er data.**
- **ADD missing message — new-customer acquisition:** *"Secondhandköparen är ofta en ny kund —
  till en lägre prispunkt."* (currently absent from the page entirely).
- **ADD missing message — integration:** *"In i er befintliga webshop. Inte ett nytt IT-projekt."*
  (section 6 headline material).
- Promote: *"En secondhandbutik är den enkla delen. Loopa automatiserar det som gör recommerce
  svårt."* to 48px+ section opener (section 5).
- Data pillar gets specifics: resale value per model, demand, lifetime, condition over time.
- No customer metrics exist yet → value-wall numbers use market-level facts with sources
  (Archive's pattern: industry stats, giant numerals).

## 6. Preview experience spec (section 3, the crown jewel)

1. **One stage:** URL input + category toggle as one control bar; storefront mockup directly
   beneath, always visible; the input transforms it in place (no results rendered elsewhere).
2. **Guaranteed wow:** suggestion chips under the input — "Testa: deadwoodstudios.com ·
   swedese.se · iittala.com" (domains verified to return ≥6 products) so first-click magic is
   guaranteed and the fallback is never a visitor's first impression.
3. **Loading as theater:** staged narration ("Hittar era produkter… Bygger er butik…") + shimmer
   skeleton product cards inside the storefront frame. 5–15s becomes anticipation.
4. **Payoff at display scale:** on success, a display-type personalized headline —
   *"Så här kan {companyName}s secondhandbutik se ut"* — product count as a proof badge, the 6
   products cascading into the frame with real names + estimated resale prices.
5. **CTA at peak intent:** directly under the personalized result:
   *"Det här är en preview. Vill ni ha den på riktigt? → Prata med oss."*
   (Today the hottest moment has no CTA within ~2000px.)
6. **One honesty line total:** "Preview byggd från era publika produktsidor. Priser är
   uppskattningar."
7. **Category toggle lives here** and re-personalizes the same stage (per-category cache already
   exists in `BrandsPage` state — reuse `cache`/`fetchCategory`).
8. Product-page-integration mockup (old `ProductPageMock`) demoted to a secondary view/thumbnail
   within this stage.

## 7. Prioritized implementation sequence

1. **Fix the invisible `FinalCta` heading** — move `h1–h4` color rule into `@layer base` in
   `index.css` (minutes; P0).
2. **Unify the preview stage** + result-adjacent CTA + suggestion chips (biggest conversion win;
   mostly recomposition of existing components/state).
3. **Delete `SellerLoop` + `FlexibleImplementation`; fold `WhyDifferent` into how-it-works**
   (page stops feeling like documentation).
4. **Insert the value wall** after the hero (display numerals, market stats, 3 pillars + new
   acquisition message).
5. **Typography/spacing pass:** hero ~72px, H2 ~52px, 120px+ sections, kill `border-t`, accent
   discipline.
6. **Hero cleanup:** remove animated card + Kånken photo; one static premium visual (e.g.
   `/assets/fashion-demo/overshirt-packshot.webp`); value-led subtitle.
7. **Final polish:** hedge-label consolidation, triangle removal, verified-toggle removal.

Steps 1–4 deliver the intended 5 seconds; 5–7 deliver the premium look.

## Reference principles (Trove / Archive — principles, not copying)

- Archive: giant serif stat numerals on full-bleed tinted band ("30% · 2.7X · 50% · 3X"),
  "resale = growth engine" framing, client-logo wall, large uppercase display type.
- Trove: value-led benefit headers ("Grow Revenue", "Attract New Customers & Boost LTV"),
  elegant overlapping product-mockup collages, one dominant message per viewport.
- Shared: one message per screen, huge type, whitespace as hierarchy, commercial outcomes
  impossible to miss, progression why → value → how → proof/CTA.

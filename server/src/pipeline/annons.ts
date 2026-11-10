/**
 * Fas 2: annonsen för en BEKRÄFTAD modell.
 *
 * Två motorer, i den här ordningen:
 *
 *   1. Produktforskningen (server/src/research) söker upp ALLA dokumenterade mått och material för
 *      modellen, med bilderna som variantkontroll, och verifierar påståendena mot källsidorna. Resultatet
 *      är ett enda `ProductFacts`-objekt (research/productFacts.ts) som bär alla varianter.
 *   2. Annonsgeneratorn i loopa-landing-page-main bygger titel, beskrivning, skickbeskrivning och
 *      prisresonemang — men ur VÅR research (`researchMode: "prior_only"`), inte ur en egen sökning
 *      med den svagare modellen.
 *
 * Alla rader annonsen visar är en VY av ProductFacts för den variant som gäller. Generatorns egna rader
 * får bara fylla luckor — en färg, ett årtal — aldrig ersätta ett mått eller material som forskningen
 * har, och aldrig fylla i ett mått som forskningen medvetet höll tillbaka (variantberoende eller
 * motsägelsefullt). Annonstexten kontrolleras sist mot raderna: en mening som anger ett mått utan stöd
 * tas bort. Faller forskningen (ingen nyckel, kvot, timeout) går anropet den gamla vägen oförändrat.
 */

import path from "node:path";
import type { SourceRef } from "../candidateImages.js";
import { callSellerGenerate, type Resolution, type SellerCall } from "../listing.js";
import { classifyAttribute, withKinds } from "../research/attributeKinds.js";
import { allowanceFor, costOf, currentCostScope } from "../cost/jobCost.js";
import { canSpend } from "../cost/ledger.js";
import { researchEnabled, SPEC_MAX_START_PAGES } from "../research/config.js";
import { isMarketplace, isRedirectUrl, sourceTier } from "../research/normalize.js";
import { externalSpecRunner, prepareImages, researchSpecs, specFromFacts, toSourceRefs } from "../research/pipeline.js";
import { getJobSync } from "../jobStore.js";
import { specHasFacts, waitForExternalSpecs } from "../externalIdentify.js";
import { slugKey } from "../research/normalize.js";
import { checkListingText, checkMaterialClaims, toAttributes, viewForVariant, type FactsView } from "../research/productFacts.js";
import type { FactIssue, ProductFacts, SpecOk } from "../research/types.js";
import { rowsCovered } from "../specHarvest.js";
import type { CapturedImage, FurnitureIdentity, GeneratedListing, ListingAttribute, ListingResult } from "../types.js";

const MATERIAL_LABEL = /(material|tyg|klädsel|träslag|läder|metall|fabric|ytbehandling|stomme|stoppning)/i;
const DIMENSION_LABEL = /(mått|bredd|djup|höjd|längd|diameter|dimension|sitthöjd|sittdjup|vikt|size|storlek)/i;
const norm = (s: string) => s.trim().toLowerCase();

/**
 * Forskningens rader först; generatorns bara där de inte krockar.
 *
 * Krock = samma kanoniska rad (rowsCovered: "Mått: 81 x 92 x 82" täcker bredd/djup/höjd), samma
 * etikett, ett material när vi redan har material per komponent, eller en uppskattning när vi har
 * riktiga mått. Dessutom: en rad av en måttyp som forskningen HÖLL TILLBAKA (`blockTypes`) släpps inte
 * in — då hade generatorns gissning fyllt precis det hål som fanns för att två sanningar inte fick visas.
 * Säljarens egna rättelser rörs inte här — de återställs av behallSaljarensRattelser.
 */
export function mergeResearchAttributes(
  research: ListingAttribute[],
  legacy: ListingAttribute[],
  opts: { blockTypes?: Set<string> } = {},
): ListingAttribute[] {
  if (research.length === 0 && !opts.blockTypes?.size) return legacy;
  const taken = new Set(research.flatMap(rowsCovered));
  const labels = new Set(research.map((a) => norm(a.label)));
  const hasMaterial = research.some((a) => a.kind === "material");
  const hasDimension = research.some((a) => a.kind === "dimension");
  const kept = legacy.filter((a) => {
    if (a.sellerEdited) return true;
    if (labels.has(norm(a.label))) return false;
    if (rowsCovered(a).some((row) => taken.has(row))) return false;
    if (hasMaterial && MATERIAL_LABEL.test(`${a.key} ${a.label}`)) return false;
    if (hasDimension && (a.estimated || a.fromSellers) && DIMENSION_LABEL.test(`${a.key} ${a.label}`)) return false;
    if (opts.blockTypes?.size) {
      const k = classifyAttribute(a);
      if (k.kind === "dimension" && k.type && opts.blockTypes.has(k.type)) return false;
    }
    return true;
  });
  return [...research, ...kept];
}

function mergeSources(first: SourceRef[], second: Array<{ title: string; url: string; qualityTier?: 1 | 2 | 3 }>): GeneratedListing["sources"] {
  const seen = new Set<string>();
  const out: GeneratedListing["sources"] = [];
  for (const s of [...first, ...second]) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ title: s.title, url: s.url, qualityTier: s.qualityTier });
  }
  return out.slice(0, 12);
}

function researchSummary(spec: SpecOk): NonNullable<GeneratedListing["research"]> {
  return {
    ...(spec.provisional ? { provisional: true } : {}),
    engine: "gemini3",
    model: spec.trace.model,
    latencyMs: spec.trace.latencyMs,
    searchQueries: spec.trace.usage.searchQueries,
    fetchedPages: spec.trace.fetchedUrls.length,
    // Hela specsökningens kostnad, aborterade försök och säkringar inräknade — inte bara det sista spårets.
    estimatedCostUsd: spec.summary.costUsd,
    fromCache: spec.fromCache === true ? true : undefined,
    attempts: spec.summary.attempts,
    toolCalls: spec.summary.toolCalls,
    stoppedBy: spec.summary.stoppedBy,
    dimensions: spec.dimensions.length,
    verifiedDimensions: spec.dimensions.filter((d) => d.verified).length,
    materials: spec.materials.length,
    verifiedMaterials: spec.materials.filter((m) => m.verified).length,
    conflicts: spec.conflicts,
    missing: spec.missing,
    rejected: spec.rejected.length,
    matchesPhotos: spec.identity.matchesPhotos,
  };
}

/** Hur uppgifterna hänger ihop, som skärmen läser det. Härlett ur vyn — räknas aldrig om i klienten. */
export function factCheckOf(view: FactsView, extra: FactIssue[] = []): NonNullable<GeneratedListing["factCheck"]> {
  return {
    variant: view.variant,
    ambiguous: view.ambiguous,
    options: view.options.map((v) => v.label),
    ...(view.needsResearch ? { needsResearch: true } : {}),
    heldBack: view.heldBack,
    issues: [...view.issues, ...extra].map((i) => ({ code: i.code, severity: i.severity, message: i.message, ...(i.keys ? { keys: i.keys } : {}) })),
  };
}

/** När generatorn inte svarade: en annons byggd på forskningen ensam. Hellre mått utan säljtext än tvärtom. */
function listingFromResearchOnly(
  identity: FurnitureIdentity,
  spec: SpecOk,
  attributes: ListingAttribute[],
  view: FactsView,
  reason: string,
  startedAt: number,
): ListingResult {
  const title = [identity.brand, identity.model].filter(Boolean).join(" ").trim();
  const missing: string[] = [];
  if (!attributes.some((a) => a.kind === "dimension")) missing.push("dimensions");
  if (!attributes.some((a) => a.kind === "material")) missing.push("material");
  if (!spec.retailPrice) missing.push("newPrice");
  missing.push("price", "condition");
  return {
    status: "ok",
    unavailableReason: null,
    result: {
      identity: {
        brand: identity.brand,
        exactProduct: identity.model,
        variant: view.variant ?? spec.identity.variant,
        category: spec.identity.category,
        confidence: spec.identity.confidence,
        uncertain: spec.identity.matchesPhotos === false,
        uncertaintyNote: spec.identity.matchesPhotos === false ? spec.identity.note ?? "Den dokumenterade produkten stämmer inte uppenbart med bilderna." : null,
      },
      attributes,
      pricing: { retailPriceSek: spec.retailPrice?.valueSek ?? null, suggestedPriceSek: null, priceRangeMinSek: null, priceRangeMaxSek: null, rationale: null, retailPriceSourceUrl: spec.retailPrice?.sourceUrl ?? null },
      listing: {
        title,
        description: `${title} säljes i begagnat skick. Se bilderna för skick och detaljer.`,
        conditionText: "Begagnat skick. Se bilder för detaljer.",
      },
      sources: mergeSources(toSourceRefs(spec.sources), []),
      status: "partial",
      missingFields: missing,
      missingNotes: [`Annonstexten kunde inte skrivas just nu (${reason}). Måtten och materialen är hämtade och belagda.`],
      warnings: ["structure_failed"],
      factCheck: factCheckOf(view),
      research: researchSummary(spec),
    },
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Ett kort utan forskning: bara det säljaren och identifieringen faktiskt vet (märke, modell). Inga mått, inget material, inget pris — varken gissat
 * eller hämtat — och en rad som säger det. Används när specsökningen föll och omgångens budget inte rymmer ett nytt sökande anrop: hellre ett kort
 * märkt ofullständigt som säljaren kan komplettera än inget kort alls. Kostar inget.
 */
export function listingWithoutResearch(identity: FurnitureIdentity, reason: string): SellerCall {
  const title = [identity.brand, identity.model].filter(Boolean).join(" ").trim();
  return {
    kind: "ok",
    listing: {
      status: "ok",
      unavailableReason: null,
      result: {
        identity: { brand: identity.brand, exactProduct: identity.model || null, variant: null, category: null, confidence: "medium", uncertain: false, uncertaintyNote: null },
        attributes: [],
        pricing: { retailPriceSek: null, suggestedPriceSek: null, priceRangeMinSek: null, priceRangeMaxSek: null, rationale: null },
        listing: {
          title,
          description: `${title} säljes i begagnat skick. Se bilderna för skick och detaljer.`,
          conditionText: "Begagnat skick. Se bilder för detaljer.",
        },
        sources: [],
        status: "partial",
        missingFields: ["dimensions", "material", "newPrice", "price", "condition"],
        missingNotes: [
          `Mått och material kunde inte hämtas inom den här analysens ram (${reason.slice(0, 160)}). Inget är gissat — mät möbeln och skriv in måtten, eller starta en ny analys.`,
        ],
        warnings: ["research_failed"],
      },
      latencyMs: 0,
    },
  };
}

/**
 * Sidor identifieringen redan hittat för modellen, som startpunkt för specsökningen: kandidatens egen
 * produktsida först, sedan de bästa av identifieringens källor. Det sparar sökningar — specsökningen
 * hade annars gjort om upptäckten — men är en ledtråd och inte ett facit: prompten säger åt modellen
 * att kontrollera att sidan verkligen gäller modellen.
 *
 * Googles omdirigeringsadresser tas inte med (de går inte att öppna med URL-verktyget på ett
 * meningsfullt sätt), och en begagnatannons får vara med bara som kandidatens egen sida: den bär ofta
 * modellnamnet för en möbel som inte längre säljs, men är ingen källa för mått.
 */
export function startUrlsFor(candidateUrl: string | null, sources: SourceRef[], brand: string, max = 3): string[] {
  const out: string[] = [];
  const add = (u: string | null | undefined) => {
    if (!u || isRedirectUrl(u) || !/^https?:\/\//i.test(u) || out.includes(u)) return;
    out.push(u);
  };
  add(candidateUrl);
  for (const s of [...sources].sort((x, y) => sourceTier(x.url, brand) - sourceTier(y.url, brand))) {
    if (out.length >= max) break;
    if (isMarketplace(s.url)) continue;
    add(s.url);
  }
  return out.slice(0, max);
}

/**
 * Bygger annonsen ur ett färdigt SpecOk: raderna ur vyn för varianten, generatorn för texten, sedan
 * kontrollen av texten mot raderna.
 */
async function composeListing(args: {
  identity: FurnitureIdentity;
  images: CapturedImage[];
  dir: string;
  resolution: Resolution;
  prior?: { researchText: string; sources: SourceRef[] };
  spec: SpecOk;
  variant: string | null;
  startedAt: number;
}): Promise<SellerCall> {
  const { identity, images, dir, resolution, prior, spec, variant, startedAt } = args;
  const brand = identity.brand?.trim() || identity.model;
  const model = identity.model!.trim();
  const view = viewForVariant(spec.productFacts, variant);
  const attributes = toAttributes(view);
  const researchSources = toSourceRefs(spec.sources);
  const facts: Pick<SellerCall & { kind: "ok" }, "productFacts" | "specTrace"> = { productFacts: spec.productFacts, specTrace: spec.summary };

  // Generatorn får VÅR research som underlag och söker inte själv. Identifieringens källor läggs
  // efter forskningens, så struktureringen kan citera dem också.
  const legacy = await callSellerGenerate(
    identity,
    images,
    dir,
    resolution,
    { researchText: spec.researchText, sources: [...researchSources, ...(prior?.sources ?? [])].slice(0, 12) },
    [],
    [],
    { researchMode: "prior_only" },
  );

  if (legacy.kind !== "ok" || !legacy.listing.result) {
    const reason = legacy.kind === "unavailable" ? legacy.reason : "oväntat svar";
    console.warn(`[annons] generatorn föll (${reason}) — annonsen byggs på forskningen ensam`);
    return { kind: "ok", listing: listingFromResearchOnly(identity, spec, attributes, view, reason, startedAt), ...facts };
  }

  const result = legacy.listing.result;
  const blockTypes = new Set(view.heldBack.map((h) => h.type));
  const merged = withKinds(mergeResearchAttributes(attributes, result.attributes, { blockTypes }));

  // Texten får inte säga mer än raderna. Mått utan stöd och motsägande träslag tas bort ur beskrivningen.
  const dimCheck = checkListingText(result.listing.description, merged);
  const matCheck = checkMaterialClaims(dimCheck.text, view.materials);
  const textIssues = [...dimCheck.issues, ...matCheck.issues];
  if (textIssues.length > 0) {
    console.warn(`[annons] ${brand} ${model}: texten justerad mot uppgifterna — ${[...dimCheck.removed, ...matCheck.removed].map((r) => `"${r.slice(0, 70)}"`).join(" | ")}`);
  }

  // Nypriset forskningen belagt med en källa går före generatorns eget (som skriver utan sökning och kan minnas fel).
  const retail = spec.retailPrice?.valueSek ?? result.pricing.retailPriceSek ?? null;
  const missingFields = (result.missingFields ?? []).filter((f) => {
    if (f === "dimensions") return !merged.some((a) => a.kind === "dimension");
    if (f === "material") return !merged.some((a) => a.kind === "material");
    if (f === "newPrice") return retail === null;
    return true;
  });
  const status = result.status === "fallback" ? "partial" : result.status;
  const heldNote = view.heldBack.filter((h) => h.reason === "variant");
  const listing: ListingResult = {
    ...legacy.listing,
    result: {
      ...result,
      identity: {
        ...result.identity,
        exactProduct: result.identity.exactProduct ?? model,
        variant: view.variant ?? spec.identity.variant ?? result.identity.variant,
        category: result.identity.category ?? spec.identity.category,
        uncertain: result.identity.uncertain || spec.identity.matchesPhotos === false,
        uncertaintyNote:
          result.identity.uncertaintyNote ??
          (spec.identity.matchesPhotos === false ? spec.identity.note ?? "Den dokumenterade produkten stämmer inte uppenbart med bilderna." : null),
      },
      attributes: merged,
      listing: { ...result.listing, description: matCheck.text || result.listing.description },
      pricing: { ...result.pricing, retailPriceSek: retail, retailPriceSourceUrl: spec.retailPrice?.valueSek === retail ? spec.retailPrice?.sourceUrl ?? null : null },
      sources: mergeSources(researchSources, result.sources),
      status,
      missingFields,
      missingNotes: [
        ...(result.missingNotes ?? []).filter((n) => !/uppskatt/i.test(n) || !merged.some((a) => a.kind === "dimension")),
        ...(spec.conflicts.length ? [`Källorna skiljer sig åt: ${spec.conflicts.join(" | ")}`] : []),
        ...(heldNote.length ? [`${heldNote.map((h) => h.label).join(", ")} skiljer sig mellan utförandena och visas när du valt variant.`] : []),
      ],
      factCheck: factCheckOf(view, textIssues),
      research: researchSummary(spec),
    },
    latencyMs: Date.now() - startedAt,
  };
  console.info(
    `[annons] ${brand} ${model}${view.variant ? ` (${view.variant})` : ""}: mått=${merged.filter((a) => a.kind === "dimension").length} material=${merged.filter((a) => a.kind === "material").length}` +
      ` övriga=${merged.filter((a) => a.kind === "fact").length} tillbakahållna=${view.heldBack.length} variantval=${view.ambiguous ? "väntar" : "ej behövt"}` +
      ` källor=${listing.result?.sources.length ?? 0} ms=${Date.now() - startedAt}`,
  );
  return { kind: "ok", listing, ...facts };
}

/**
 * Vad ett reservförsök (generatorns EGEN grundade sökning, när forskningen föll) får kosta: det är ett andra betalt sökande för samma
 * modell, och bara värt att göra när omgångens budget rymmer det (cost/ledger.ts).
 */
const FALLBACK_RESEARCH_MIN_SEK = 0.8;

/**
 * Bygger annonsen för en avgjord identitet. Kastar aldrig.
 *
 * Specsökningen är ETT anrop, inom det söksutrymme jobbets kostnadsbok tillåter (`allowanceFor`). Är utrymmet noll läser den bara sidorna
 * identifieringen redan hittat. Faller forskningen går anropet bara den gamla vägen — generatorns egen grundade sökning, ett andra
 * betalt sökande — om budgeten rymmer det; annars blir svaret ett ärligt "inte tillgänglig" och kortet markeras ofullständigt.
 */
export async function byggAnnons(
  identity: FurnitureIdentity,
  images: CapturedImage[],
  dir: string,
  resolution: Resolution,
  prior?: { researchText: string; sources: SourceRef[] },
  opts: { skipCache?: boolean } = {},
): Promise<SellerCall> {
  const model = identity.model?.trim();
  if (!researchEnabled() || resolution.kind === "unknown" || !model) {
    return callSellerGenerate(identity, images, dir, resolution, prior);
  }
  const startedAt = Date.now();
  const brand = identity.brand?.trim() || model;
  const selected = resolution.kind === "seller_selected" ? resolution.selected : null;
  const variant = selected?.variant ?? null;
  const jobId = currentCostScope()?.jobId ?? null;

  let spec;
  try {
    const prepStart = Date.now();
    const researchImages = await prepareImages(images, dir);
    const prepareMs = Date.now() - prepStart;
    // Tillåtelsen läses FÖRST nu, när identifieringen är betald och bokförd. Utan jobb (ett mätskript) gäller miljöns förval.
    const allowance = jobId ? await allowanceFor(jobId, "specs") : null;
    // PROTOTYP: pekade AI-läget (appens webbvy) ut just den här modellen får dess mått och material gå genom den vanliga verifieringen i stället för en ny sökning.
    // Appens måttfråga kan fortfarande vara på väg (den ställs medan säljaren tittar på korten): väntas in en stund, sedan går specsteget vidare med det som finns.
    if (jobId && getJobSync(jobId)?.externalFacts?.specPending) await waitForExternalSpecs(jobId);
    const ext = jobId ? getJobSync(jobId)?.externalFacts : undefined;
    // En spec UTAN mått och material (måttfrågan gav inget svar) ersätter aldrig Loopas egen specsökning.
    const useExternal = !!ext && slugKey(ext.model) === slugKey(model) && specHasFacts(ext.spec);
    spec = await researchSpecs({
      brand,
      model,
      variant,
      productType: selected?.productType ?? null,
      images: researchImages,
      confirmedBy: "seller",
      // Högst SPEC_MAX_START_PAGES sidor: kostnaden i en specsökning är sidorna som läses (≈0,25 SEK per IKEA-sida), inte tänkandet.
      startUrls: startUrlsFor(selected?.sourceUrl ?? null, prior?.sources ?? [], brand, SPEC_MAX_START_PAGES),
      label: path.basename(dir).slice(0, 8),
      prepareMs,
      skipCache: opts.skipCache || useExternal,
      ...(allowance ? { maxSearchQueries: allowance.searchQueries } : {}),
    }, useExternal ? { run: externalSpecRunner(ext!.spec, path.basename(dir).slice(0, 8)) } : {});
  } catch (err) {
    spec = { kind: "unavailable" as const, reason: err instanceof Error ? err.message : String(err), trace: null };
  }
  if (spec.kind !== "ok") {
    const cost = jobId ? await costOf(jobId) : null;
    if (cost && !canSpend(cost, FALLBACK_RESEARCH_MIN_SEK)) {
      // Budgeten rymmer inget andra sökande anrop. Säljaren får ändå ett kort — med det som är känt (märke, modell) och ärligt märkt som utan mått och
      // material — i stället för inget alls: de går att skriva in på måttskärmen, och ingenting är gissat. Kostnaden är noll.
      console.warn(`[annons] forskningen föll (${spec.reason}) och budgeten rymmer inget reservförsök — "${brand} ${model}" får ett kort utan mått och material`);
      return listingWithoutResearch(identity, spec.reason);
    }
    console.warn(`[annons] forskningen föll (${spec.reason}) — går den gamla vägen för "${brand} ${model}"`);
    return callSellerGenerate(identity, images, dir, resolution, prior);
  }
  return composeListing({ identity, images, dir, resolution, prior, spec, variant, startedAt });
}

/**
 * Annonsen för en variant UR DE FAKTA JOBBET REDAN BÄR — ingen ny forskning.
 *
 * Mätt (2026-10-11): ett variantval körde om hela specsökningen. Det tog 103–108 s, avbröts i ett av
 * två fall mot sökgränsen, och lämnade annonsen utan ett enda mått. Faktan om alla varianter fanns
 * redan i första svaret; det som behövdes var att välja ut den rätta och skriva om texten (ett
 * generatoranrop, några sekunder).
 *
 * Returnerar null när fakta saknar mått för den valda varianten (`needsResearch`) — då får
 * anroparen göra ett riktat omtag med `byggAnnons`.
 */
export async function byggAnnonsFranFakta(
  identity: FurnitureIdentity,
  images: CapturedImage[],
  dir: string,
  resolution: Resolution,
  facts: ProductFacts,
  prior?: { researchText: string; sources: SourceRef[] },
): Promise<SellerCall | null> {
  const model = identity.model?.trim();
  if (!model || resolution.kind === "unknown") return null;
  const variant = resolution.kind === "seller_selected" ? resolution.selected.variant ?? null : null;
  if (viewForVariant(facts, variant).needsResearch) return null;
  const startedAt = Date.now();
  const spec = specFromFacts(facts, { variant, label: path.basename(dir).slice(0, 8), startedAt });
  return composeListing({ identity, images, dir, resolution, prior, spec, variant, startedAt });
}

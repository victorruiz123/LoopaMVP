/**
 * Produktforskningen, steg för steg.
 *
 *   identifyFurniture — bilder + märke → rankade kandidater med evidens, inom EN hård tidsgräns (research/deadline.ts).
 *                       Ett anrop; hinner det inte svara blir utfallet ärligt tomt, aldrig en gissning.
 *   researchSpecs     — bekräftad modell + bilder → ALLA dokumenterade mått och material (ett anrop),
 *                       följt av verifiering i kod mot källsidorna.
 *
 * Två steg och inte ett, därför att appen låter SÄLJAREN bekräfta modellen mellan dem — att göra
 * hela specsökningen på fyra kandidater vore fyra gånger kostnaden för tre svar som kastas. Varje
 * anrop får däremot forska färdigt: sök, hämta sidor, tänk, svara strukturerat i samma tur.
 *
 * Det här lagret översätter också till appens egna typer (ModelCandidate, ListingAttribute,
 * SourceRef), så att väljarskärm, annons, måttminne och sidskörd fortsätter fungera oförändrade.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { SourceRef } from "../candidateImages.js";
import type { CapturedImage, ListingAttribute, ModelCandidate } from "../types.js";
import {
  IDENTIFY_DEADLINE_MS,
  IDENTIFY_MAX_OUTPUT_TOKENS,
  IDENTIFY_MAX_QUERIES,
  IDENTIFY_MAX_ROUNDS,
  IDENTIFY_MIN_CALL_MS,
  IDENTIFY_RESERVE_MS,
  IDENTIFY_ROUND_QUERIES,
  IDENTIFY_THINKING,
  RESEARCH_IMAGE_MAX_SIDE,
  RESEARCH_IMAGE_QUALITY,
  RESEARCH_IMAGE_RESOLUTION,
  RESEARCH_MAX_IMAGES,
  ROUND_STRAY_QUERIES,
  SPEC_MAX_OUTPUT_TOKENS,
  SPEC_MAX_QUERIES,
  SPEC_SEARCH_BUDGET,
  SPEC_THINKING,
  SPEC_TIMEOUT_MS,
} from "./config.js";
import { Deadline, isDeadlineExceeded } from "./deadline.js";
import { InteractionError, runInteraction, type InteractionOutcome, type InteractionRequest, type InteractionRunner } from "./geminiInteractions.js";
import {
  buildSources,
  cleanUrl,
  isLengthType,
  isMarketplace,
  isRedirectUrl,
  normalizeDimension,
  normalizeFact,
  normalizeMaterial,
  normalizeVariant,
  slugKey,
} from "./normalize.js";
import { loadFacts, saveFacts } from "./factsCache.js";
import { buildProductFacts, toAttributes, viewForVariant, type FactsView } from "./productFacts.js";
import {
  buildIdentifyPrompt,
  buildSpecPrompt,
  identifySystemInstruction,
  specSystemInstruction,
} from "./prompts.js";
import { IDENTIFY_SCHEMA, SPEC_SCHEMA } from "./schema.js";
import type {
  DroppedCandidate,
  IdentifyOk,
  IdentifyOutcome,
  IdentityCandidate,
  ResearchFailure,
  ResearchImage,
  ResearchRunSummary,
  ResearchSource,
  ResearchTrace,
  ProductFacts,
  SpecIdentity,
  SpecOk,
  SpecOutcome,
  VerificationLevel,
} from "./types.js";
import { isImageAssetUrl, verifyClaims, type PageFetcher } from "./verify.js";
import { resolveGroundingRedirects, withResolvedUrls, type UrlResolver } from "./redirects.js";

export interface ResearchDeps {
  run?: InteractionRunner;
  fetchPage?: PageFetcher;
  /** Stäng av sidverifieringen (tester, mätning av enbart modellen). */
  verifyPages?: boolean;
  /**
   * Löser Googles omdirigeringsadresser till de riktiga sidorna efter varje anrop (research/redirects.ts). Förval: den riktiga lösaren när
   * anropet går mot Gemini, ingen alls när ett test mataren själv med ett falskt svar.
   */
  resolveUrls?: UrlResolver;
  model?: string;
  signal?: AbortSignal;
  /**
   * Identifieringens klocka (research/deadline.ts), när anroparen äger den — då räknas tiden från anroparens start, med bildförberedelsen
   * inräknad. Utan den skapar `identifyFurniture` en egen på IDENTIFY_DEADLINE_MS.
   */
  deadline?: Deadline;
}

/**
 * Krokar för tester som kör HELA vägen (pipeline/annons.ts → forskning → generator) utan nätverk:
 * sätts de används de i stället för Gemini och den riktiga sidhämtningen. Null i drift.
 */
export const testHooks: { run: InteractionRunner | null; fetchPage: PageFetcher | null } = { run: null, fetchPage: null };

function resolveDeps(deps: ResearchDeps): ResearchDeps {
  return {
    ...deps,
    run: deps.run ?? testHooks.run ?? undefined,
    fetchPage: deps.fetchPage ?? testHooks.fetchPage ?? undefined,
    resolveUrls: deps.resolveUrls ?? (deps.run || testHooks.run ? undefined : resolveGroundingRedirects),
  };
}

// ─── Bilder ─────────────────────────────────────────────────────────────────

/** `n` element med jämna mellanrum, ordningen bevarad. Omslaget tas alltid först, utanför spridningen. */
function spread<T>(list: T[], n: number): T[] {
  if (n <= 0) return [];
  if (list.length <= n) return list;
  if (n === 1) return [list[Math.floor(list.length / 2)]];
  const picked = new Set<number>();
  for (let i = 0; i < n; i++) picked.add(Math.round((i * (list.length - 1)) / (n - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => list[i]);
}

export function pickResearchFrames(images: CapturedImage[], max = RESEARCH_MAX_IMAGES): CapturedImage[] {
  const cover = images.find((i) => i.role === "cover");
  const rest = images.filter((i) => i !== cover);
  const chosen = spread(rest, max - (cover ? 1 : 0));
  return cover ? [cover, ...chosen] : chosen;
}

/**
 * Bilderna som de är, så långt det går. En JPEG inom storleksgränsen skickas byte för byte; en PNG
 * (tung, och utan vinst för en fotografisk bild) eller en för stor bild kodas om till JPEG med hög
 * kvalitet. Ingen beskärning, ingen onödig nedskalning — se RESEARCH_IMAGE_MAX_SIDE i config.ts.
 */
export async function prepareImages(images: CapturedImage[], jobDir: string, max = RESEARCH_MAX_IMAGES): Promise<ResearchImage[]> {
  const frames = pickResearchFrames(images, max);
  const out: ResearchImage[] = [];
  for (const img of frames) {
    const abs = path.join(jobDir, "originals", img.path);
    try {
      const buf = await readFile(abs);
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      const longest = Math.max(img.width || 0, img.height || 0);
      if (isJpeg && longest > 0 && longest <= RESEARCH_IMAGE_MAX_SIDE) {
        out.push({ mimeType: "image/jpeg", base64: buf.toString("base64"), resolution: RESEARCH_IMAGE_RESOLUTION });
        continue;
      }
      const encoded = await sharp(buf)
        .rotate()
        .resize({ width: RESEARCH_IMAGE_MAX_SIDE, height: RESEARCH_IMAGE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: RESEARCH_IMAGE_QUALITY })
        .toBuffer();
      out.push({ mimeType: "image/jpeg", base64: encoded.toString("base64"), resolution: RESEARCH_IMAGE_RESOLUTION });
    } catch (err) {
      console.warn(`[research] kunde inte läsa ${img.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// ─── Hjälpare ───────────────────────────────────────────────────────────────

const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const strList = (v: unknown, max = 8): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 200)).slice(0, max) : [];

function unavailable(reason: string, failKind: string | null, trace: ResearchTrace | null, summary: ResearchRunSummary | null = null) {
  return { kind: "unavailable" as const, reason, failKind, trace, summary };
}

/**
 * Vad säljaren och loggen får veta. Texten är avsiktligt grov mot säljaren — ett slut på krediter är
 * inte deras sak — men `failKind` på utfallet är exakt, och det är den som styr vad som händer härnäst.
 */
export function reasonOf(err: unknown): string {
  if (err instanceof InteractionError) {
    switch (err.kind) {
      case "billing":
        return "AI-tjänsten är inte tillgänglig (kontots förbetalda krediter är slut).";
      case "timeout":
        return "Sökningen hann inte klart.";
      case "tool_limit":
      case "tool_budget":
        return "Sökningen blev för omfattande och avbröts.";
      case "quota":
        return "AI-tjänstens kvot är slut för tillfället.";
      case "overloaded":
        return "AI-tjänsten är överbelastad just nu.";
      case "empty":
        return "AI-tjänsten svarade utan innehåll.";
      case "aborted":
        return "Sökningen avbröts.";
      default:
        return `AI-tjänsten svarade med fel: ${err.message.slice(0, 120)}`;
    }
  }
  return `Sökningen föll: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
}

const failKindOf = (err: unknown): string => (err instanceof InteractionError ? err.kind : "unknown");

/** Adresser anropet bevisligen besökte eller citerade — grunden för verifieringen. */
function toolConfirmedUrls(trace: ResearchTrace): Set<string> {
  const set = new Set<string>();
  for (const c of trace.citations) {
    const u = cleanUrl(c.url);
    if (u) set.add(u);
  }
  for (const f of trace.fetchedUrls) {
    const u = cleanUrl(f.url);
    if (u && /success|ok|completed|retrieved/i.test(f.status)) set.add(u);
  }
  return set;
}

/** Sammanfattningen av ett eller flera anrop — det som loggas, sparas på jobbet och visas i rapporter. */
export function summarize(
  purpose: ResearchRunSummary["purpose"],
  traces: ResearchTrace[],
  stages: ResearchRunSummary["stages"],
  passes: number,
): ResearchRunSummary {
  const last = traces[traces.length - 1];
  /**
   * Varje försök räknas EN gång. Ett försök som föll bär sin egen post i `failures` (runInteraction skriver in den i samma lista
   * som spåret pekar på), och listan delas av alla spår i ett anrop — utan det här räknades ett fallet försök två gånger när
   * dess spår låg med i sammanställningen (mätt: ≈0,77 USD rapporterat för en körning som kostade ≈0,57).
   */
  const counted = new Set(traces.map((t) => `${t.latencyMs}|${t.estimatedCostUsd}`));
  const failures = [...new Set(traces.flatMap((t) => t.failures))];
  const failureCost = failures.reduce((n, f) => n + (counted.has(`${f.ms}|${f.costUsd}`) ? 0 : (f.costUsd ?? 0)), 0);
  return {
    purpose,
    passes,
    attempts: traces.reduce((n, t) => n + t.attempts, 0),
    model: last?.model ?? "",
    totalMs: stages.totalMs,
    searchQueries: traces.reduce((n, t) => n + t.usage.searchQueries, 0),
    toolCalls: traces.reduce((n, t) => n + t.toolCalls, 0),
    fetchedPages: traces.reduce((n, t) => n + t.fetchedUrls.length, 0),
    // Försök som föll (avbrott mot sökgränsen, tidsgräns) kostade riktiga pengar fast deras spår inte är det
    // sista — de ingår, annars såg ett omförsök ut att kosta en tredjedel av vad det gjorde.
    costUsd: Math.round((traces.reduce((n, t) => n + t.estimatedCostUsd, 0) + failureCost) * 10_000) / 10_000,
    ...(traces.some((t) => t.usage.tokensEstimated) || failures.some((f) => f.costUsd !== undefined) ? { costIsLowerBound: true } : {}),
    stoppedBy: last?.stoppedBy ?? "error",
    failures: failures as ResearchFailure[],
    stages,
  };
}

const keyOf = (brand: string, model: string) => slugKey(`${brand} ${model}`);
const sameish = (a: string, b: string) => !!a && !!b && (a === b || a.startsWith(`${b}_`) || b.startsWith(`${a}_`));
const RANK = { strong: 3, likely: 2, possible: 1 } as const;

// ─── Identifiering ──────────────────────────────────────────────────────────

export interface IdentifyInput {
  brand: string;
  images: ResearchImage[];
  sellerNote?: string | null;
  excludeModels?: string[];
  alreadySuggested?: string[];
  /** Kort etikett (jobb-id) för loggar och spårfiler. */
  label?: string;
  /** Hur lång tid bildförberedelsen tog, så att den hamnar i samma sammanställning som resten. */
  prepareMs?: number;
  /**
   * Taket på sökfrågor, ur kostnadsboken (cost/ledger.ts). Det är det som håller omgången inom sitt kostnadstak: Googles sökavgift är
   * nästan hela kostnaden. Utelämnat = miljöns förval (mätskript och tester).
   */
  maxSearchQueries?: number;
}

interface ParsedIdentify {
  category: string | null;
  observations: string[];
  candidates: IdentityCandidate[];
  exactMatch: boolean;
  uncertaintyNote: string | null;
  summary: string | null;
}

/** Modellens JSON till kandidater: förbjudna bort, dubbletter ihopslagna, färger inte varianter. */
export function parseIdentify(json: unknown, input: { brand: string; excludeModels?: string[]; alreadySuggested?: string[] }): ParsedIdentify | null {
  const j = (json ?? {}) as Record<string, unknown>;
  if (!json || !Array.isArray(j.candidates)) return null;
  const blocked = [...(input.excludeModels ?? []), ...(input.alreadySuggested ?? [])].map((s) => slugKey(s));
  const candidates: IdentityCandidate[] = [];
  for (const raw of j.candidates as Array<Record<string, unknown>>) {
    const model = str(raw.model, 80);
    if (!model) continue;
    const brand = str(raw.brand, 80) ?? input.brand;
    const k = keyOf(brand, model);
    const kModelOnly = slugKey(model);
    if (blocked.some((b) => sameish(k, b) || sameish(kModelOnly, b))) continue;
    if (candidates.some((c) => keyOf(c.brand, c.model) === k)) continue;
    const confidence = raw.confidence === "strong" || raw.confidence === "likely" || raw.confidence === "possible" ? raw.confidence : "possible";
    const variant = str(raw.variant, 80);
    // Googles omdirigeringsadresser går inte att visa eller öppna som källa; en bildfil är ingen sida.
    const sourceUrl = cleanUrl(raw.sourceUrl);
    // Sidor med produktbilder: tillverkarens, återförsäljarens, katalogens — aldrig en begagnatannons,
    // som visar någon annans möbel i någon annans hem (se candidateImages.ts).
    const productPages = (Array.isArray(raw.productPages) ? raw.productPages : [])
      .map((u) => cleanUrl(u))
      .filter((u): u is string => !!u && !isRedirectUrl(u) && !isMarketplace(u) && !isImageAssetUrl(u))
      .slice(0, 3);
    candidates.push({
      brand,
      model,
      // En "variant" med snedstreck eller komma är en färgbeskrivning, inte en beteckning.
      variant: variant && !/[,/]/.test(variant) && variant.length <= 40 ? variant : null,
      productType: str(raw.productType, 60),
      confidence,
      evidence: strList(raw.evidence, 6),
      distinguishingDetail: str(raw.distinguishingDetail, 160),
      sourceUrl: sourceUrl && !isRedirectUrl(sourceUrl) && !isImageAssetUrl(sourceUrl) ? sourceUrl : null,
      productPages,
      discontinued: typeof raw.discontinued === "boolean" ? raw.discontinued : null,
    });
    if (candidates.length >= 4) break;
  }
  candidates.sort((a, b) => RANK[b.confidence] - RANK[a.confidence]);
  return {
    category: str(j.category, 60),
    observations: strList(j.observations, 10),
    candidates,
    exactMatch: j.exactMatch === true && candidates.length > 0 && candidates[0].confidence === "strong",
    uncertaintyNote: str(j.uncertaintyNote, 300),
    summary: str(j.summary, 4000),
  };
}

/**
 * Vad som får nå säljaren.
 *
 * Säljaren väljer; modellen FÖRESLÅR, med den säkerhet den faktiskt har — som Gemini på webben, som kan säga "troligen den här, och här är varför".
 * Ett förslag kräver därför inte nära full säkerhet. Det som hålls tillbaka är bara det som saknar skäl att visas:
 *
 *  - en kandidat utan en enda synlig detalj till sin fördel (`no_evidence`). Evidens är vad i bilderna som talar för just den här modellen;
 *    ett namn utan det är en gissning, och säljaren har inget att jämföra med.
 *
 * "Stark", "trolig" och "möjlig" visas ALLA, med evidensen under sig, och skärmen skiljer på dem (ModelSelectScreen): en "möjlig" modell
 * presenteras aldrig som en bekräftad identitet. Förut hölls "möjliga" tillbaka (2026-10-21) — det var en reaktion på att reservläget
 * fyllde skärmen med två Sits-modeller ur en lista modellen själv kallat trolig och möjlig, och det kostade i stället bort de förslag som
 * var rätt men ofullständigt belagda: en mätning visade 7 av 11 körningar utan ett enda förslag. Felet var reservläget och den falska
 * säkerheten i texten ("stämmer med bilderna"), inte att visa en möjlig modell med dess förbehåll.
 *
 * Noll kandidater är fortfarande ett fullgott svar när modellen inte hittar något som stöds av bilderna. "Exakt träff" gäller bara om den
 * kandidat modellen kallade exakt också är den som visas först.
 */
export function gateCandidates(parsed: Pick<ParsedIdentify, "candidates" | "exactMatch">): { shown: IdentityCandidate[]; exactMatch: boolean; dropped: DroppedCandidate[] } {
  const shown: IdentityCandidate[] = [];
  const dropped: DroppedCandidate[] = [];
  parsed.candidates.forEach((c, position) => {
    const why = c.evidence.length === 0 ? "no_evidence" : null;
    if (why) dropped.push({ brand: c.brand, model: c.model, confidence: c.confidence, position, reason: why });
    else shown.push(c);
  });
  const top = parsed.candidates[0];
  const exactMatch = parsed.exactMatch && !!top && shown[0] === top && top.confidence === "strong";
  return { shown, exactMatch, dropped };
}

/** Fel som går över av sig själva: ett andra försök på samma modell har en chans. Allt annat gör det meningslöst eller för dyrt. */
const TRANSIENT = new Set(["overloaded", "network"]);

/** Vilken omgång ett identifieringsanrop är, och vad den får göra. */
export interface RoundPlan {
  round: number;
  maxRounds: number;
  /** Frågorna i omgångens ENDA sökanrop. */
  queries: number;
  /** Fynden från de tidigare omgångarna, färdigskrivna för prompten. */
  earlierRounds?: string | null;
}

/**
 * En identifieringsomgång: ETT anrop, en modell, en inställning, med ETT sökanrop av högst `plan.queries` frågor (prompten säger det, strömmen verkställer
 * det med lite marginal). Svåra fall får flera omgångar i följd (`identifyWithin`), var och en med förra omgångens fynd i uppgiften.
 *
 * TIDEN KOMMER FRÅN KLOCKAN. Anropets budget är det som är kvar av identifieringens ENDA tidsgräns minus utrymmet för det som sker
 * efter anropet (IDENTIFY_RESERVE_MS), och dess signal avbryts av samma klocka. Inget omförsök, ingen säkring och ingen reservmodell
 * ligger inuti anropet: ett fall hanteras av `identifyFurniture`, under samma klocka. Se research/deadline.ts.
 */
export function identifyRequest(input: IdentifyInput, deps: ResearchDeps, plan?: RoundPlan): InteractionRequest {
  const deadline = deps.deadline;
  /** Säkerhetsbudgetens tillåtelse i sökfrågor för HELA identifieringen (cost/ledger.ts). Utan jobb (ett mätskript) gäller förvalen i config.ts. */
  const cap = input.maxSearchQueries;
  const queries = plan?.queries ?? Math.max(1, Math.min(IDENTIFY_ROUND_QUERIES, cap ?? IDENTIFY_ROUND_QUERIES));
  return {
    purpose: "identify",
    label: input.label,
    model: deps.model,
    systemInstruction: identifySystemInstruction({ searchBudget: queries, round: plan?.round ?? 1, maxRounds: plan?.maxRounds ?? IDENTIFY_MAX_ROUNDS }),
    prompt: buildIdentifyPrompt({
      brand: input.brand,
      sellerNote: input.sellerNote,
      excludeModels: input.excludeModels,
      alreadySuggested: input.alreadySuggested,
      imageCount: input.images.length,
      earlierRounds: plan?.earlierRounds,
    }),
    images: input.images,
    schema: IDENTIFY_SCHEMA,
    thinkingLevel: IDENTIFY_THINKING,
    timeoutMs: deadline ? deadline.budget(IDENTIFY_RESERVE_MS) : IDENTIFY_DEADLINE_MS - IDENTIFY_RESERVE_MS,
    // Skyddsnätet för EN omgång: ett sökanrop med `queries` frågor, och utrymme för att modellen ändå utfärdar ett till. Ett avbrutet anrop lämnar inget svar men
    // kostar ändå — men det kastar bara den omgången, aldrig de tidigare (identifyWithin).
    maxSearchQueries: Math.min(queries + ROUND_STRAY_QUERIES, cap ?? IDENTIFY_MAX_QUERIES, IDENTIFY_MAX_QUERIES),
    maxOutputTokens: IDENTIFY_MAX_OUTPUT_TOKENS,
    signal: deadline ? deadline.within(deps.signal) : deps.signal,
  };
}

/**
 * Fynden efter en omgång, som nästa omgång får i sin uppgift: vad som redan sökts (så att det inte sökas igen), vilka modeller som står kvar och varför,
 * vad som är öppet. Modellens egna ord, inget vi tolkat.
 */
export function renderFindings(rounds: Array<{ round: number; parsed: ParsedIdentify; queries: string[] }>): string {
  const lines = ["WHAT YOUR EARLIER ROUNDS ESTABLISHED (continue from this; do not start over):"];
  for (const r of rounds) {
    lines.push(`Round ${r.round}: ${r.queries.length} queries already run — do not repeat them or near-duplicates: ${r.queries.map((q) => `"${q}"`).join(" | ") || "(none)"}`);
  }
  const last = rounds[rounds.length - 1].parsed;
  if (last.observations.length) lines.push(`Details you noted on the photographs: ${last.observations.join(" ")}`);
  if (last.candidates.length) {
    lines.push("Candidates so far:");
    for (const c of last.candidates) {
      lines.push(
        `- ${c.brand} ${c.model}${c.variant ? ` (${c.variant})` : ""} — ${c.confidence}${c.discontinued ? ", discontinued" : ""}. Supports: ${c.evidence.join(" ") || "—"}` +
          `${c.distinguishingDetail ? ` Separating detail: ${c.distinguishingDetail}` : ""}${c.sourceUrl ? ` Source: ${c.sourceUrl}` : ""}`,
      );
    }
  } else lines.push("No candidate has been supported yet.");
  if (last.uncertaintyNote) lines.push(`Still open: ${last.uncertaintyNote}`);
  lines.push(
    "Test the open points and try to disprove the leading candidate. Return the COMPLETE updated list: keep the candidates that still stand (with updated confidence and evidence), remove the ones you have ruled out, and add new ones the new evidence supports.",
  );
  return lines.join("\n");
}

/** Allt som behövs för att göra ett IdentifyOk av en tolkad och sållad omgång. */
function finishIdentify(a: {
  input: IdentifyInput;
  parsed: ParsedIdentify;
  dropped: DroppedCandidate[];
  traces: ResearchTrace[];
  stages: ResearchRunSummary["stages"];
  geminiMs: number;
  parseMs: number;
  deadline: Deadline;
  /** Antal omgångar som gav ett svar. */
  passes: number;
  /** Spåret för omgången vars svar visas (inte nödvändigtvis det sista: en senare omgång kan ha fallit). */
  trace: ResearchTrace;
}): IdentifyOk {
  const { input, parsed, traces: allTraces, trace } = a;
  const { candidates, exactMatch } = parsed;
  const sources = buildSources(
    [
      ...allTraces.flatMap((t) => t.citations.map((c) => ({ url: c.url, title: c.title, cited: true }))),
      ...allTraces.flatMap((t) => t.fetchedUrls.map((f) => ({ url: f.url, title: null, retrieved: /success|ok|completed|retrieved/i.test(f.status) }))),
      ...candidates.filter((c) => c.sourceUrl).map((c) => ({ url: c.sourceUrl!, title: `${c.brand} ${c.model}`, cited: true })),
    ],
    input.brand,
  );

  const researchText = [
    `IDENTIFIERING (${trace.model}, ${allTraces.reduce((n, t) => n + t.searchQueries.length, 0)} sökfrågor, ${allTraces.reduce((n, t) => n + t.fetchedUrls.length, 0)} hämtade sidor)`,
    parsed.category ? `Produkttyp: ${parsed.category}` : null,
    parsed.observations.length ? `Observationer: ${parsed.observations.join("; ")}` : null,
    ...candidates.map(
      (c, i) =>
        `KANDIDAT ${i + 1}: ${c.brand} ${c.model}${c.variant ? ` (${c.variant})` : ""} — ${c.confidence}` +
        `${c.evidence.length ? `; evidens: ${c.evidence.join("; ")}` : ""}${c.sourceUrl ? ` (källa: ${c.sourceUrl})` : ""}`,
    ),
    exactMatch ? "Exakt träff: ja" : "Exakt träff: nej",
    parsed.uncertaintyNote ? `Osäkerhet: ${parsed.uncertaintyNote}` : null,
    parsed.summary ? `Sammanfattning: ${parsed.summary}` : null,
    sources.length ? `KÄLLOR:\n${sources.map((s) => `- ${s.title} ${s.url}`).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const summary = withDeadline(summarize("identify", allTraces, a.stages, a.passes), a.deadline, false);
  console.info(
    `[research] ${input.label ?? ""} identify klar: kandidater=${candidates.map((c) => `${c.model}(${c.confidence})`).join(",") || "inga"}` +
      `${a.dropped.length ? ` sållade=${a.dropped.map((d) => `${d.model}(${d.reason})`).join(",")}` : ""} exakt=${exactMatch} ` +
      `sökfrågor=${summary.searchQueries} verktyg=${summary.toolCalls} ms=${summary.totalMs}/${a.deadline.totalMs} (förberedelse ${input.prepareMs ?? 0}, gemini ${a.geminiMs}, tolkning ${a.parseMs}) cost${summary.costIsLowerBound ? "≥" : "≈"}$${summary.costUsd}`,
  );

  return {
    kind: "ok",
    category: parsed.category,
    observations: parsed.observations,
    candidates,
    exactMatch,
    uncertaintyNote: parsed.uncertaintyNote,
    sources,
    trace,
    traces: allTraces,
    summary,
    researchText,
    ...(a.dropped.length ? { dropped: a.dropped } : {}),
  };
}

/** Sammanfattningen med klockans utfall: hur mycket tid identifieringen fick, hur mycket den tog och om gränsen nåddes. */
function withDeadline(summary: ResearchRunSummary, deadline: Deadline, hit: boolean): ResearchRunSummary {
  return { ...summary, deadline: { limitMs: deadline.totalMs, elapsedMs: deadline.elapsed(), hit } };
}

/** Vad vakten ger sig själv på ovanpå tidsgränsen innan den ger upp på arbetet. Anropet stänger sig självt före gränsen och vaktens tid är värsta fallet. */
export const WATCHDOG_GRACE_MS = 500;

/**
 * Identifieringen. EN klocka för allt — modellanrop, sökning, verktyg, omförsök, tolkning och sållning — så att säljaren aldrig
 * väntar mer än 60 s (57 s här, plus pollning och ritning). Det finns ingen andra omgång, inget snabbspår, ingen säkring och ingen
 * reservmodell: allt det lades förut ovanpå varandra med var sin klocka, och en körning kunde ta 74–80 s.
 *
 *  - Anropet får tiden kvar minus IDENTIFY_RESERVE_MS och stänger själv sin ström när den tar slut; samma klocka avbryter signalen.
 *  - Ett tillfälligt fel (överbelastning, nätverk) får ETT omförsök med samma modell och inställning — men bara om tiden kvar
 *    räcker till ett helt anrop (IDENTIFY_MIN_CALL_MS). Arbete som inte hinner bli klart startas inte.
 *  - Vakten (WATCHDOG_GRACE_MS efter gränsen) ger ett ärligt "tidsgränsen nåddes" även om något mot förmodan hänger sig, och
 *    ingenting blir kvar i bakgrunden: klockans signal har då redan stängt strömmen.
 *  - Vid gränsen finns inget försvarbart svar. Det blir inga påhittade kandidater och inget gissat svar från en svagare modell:
 *    ett ärligt utfall utan kandidater, som låter säljaren lägga till bilder, försöka igen eller skriva modellnamnet.
 *
 * VARFÖR INGET SNABBARE LÄGE FINNS KVAR. Sparade körningar på samma bilder (server/data/research-traces): på INGEMAR och NORRNÄS-stolen
 * var det fulla anropet rätt 14 av 14 gånger det hann svara — men det hann bara i 11 av 13 försök på INGEMAR, 3 av 8 på NORRNÄS och 0 av 3
 * på Sits-fåtöljen. Det är INTE ofelbart på andra möbler: på tre människomärkta möbler (matbord, fåtölj) svarade det rätt 1 gång av 3.
 * Det reducerade läget hann alltid och hade rätt i 4 av 10 körningar med känt facit; de felen var "stark" och "exakt" (BÖRJE, NÄSINGE,
 * NORDVIKEN). Ett svar som tvingas fram under tidspress — avslutning ur anteckningar, en budgetprompt — gav lika säkra fel. Det är
 * bättre att säga "vi hann inte" än att visa ett fel som ser säkert ut. Se docs/identifiering-60s-2026-10-21.md.
 */
export async function identifyFurniture(input: IdentifyInput, rawDeps: ResearchDeps = {}): Promise<IdentifyOutcome> {
  const deps = resolveDeps(rawDeps);
  if (input.images.length === 0) return unavailable("Inga bildrutor att identifiera ur.", "no_images", null);

  // Anroparen kan äga klockan (då räknas tiden från dennes start, bildförberedelsen inräknad). Annars skapas den här.
  const own = !deps.deadline;
  const deadline = deps.deadline ?? new Deadline(IDENTIFY_DEADLINE_MS, { startedAt: Date.now() - (input.prepareMs ?? 0) });
  const progress: Progress = { traces: [], geminiMs: 0, parseMs: 0 };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const guard = new Promise<IdentifyOutcome>((resolve) => {
      watchdog = setTimeout(() => {
        console.warn(`[research] ${input.label ?? ""} identify: vakten slog till ${deadline.elapsed()} ms in — arbetet hade inte lämnat ifrån sig något`);
        resolve(deadlineHit(input, progress, deadline));
      }, deadline.remaining() + WATCHDOG_GRACE_MS);
    });
    const work = identifyWithin(input, { ...deps, deadline }, deadline, progress);
    // Ett arbete som blir klart EFTER att vakten vunnit kastas; det får inte bli ett obevakat löfte.
    work.catch(() => {});
    return await Promise.race([work, guard]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (own) deadline.dispose();
  }
}

interface Progress {
  traces: ResearchTrace[];
  geminiMs: number;
  parseMs: number;
}

const stagesOf = (input: IdentifyInput, p: Progress, deadline: Deadline): ResearchRunSummary["stages"] => ({
  prepareImagesMs: input.prepareMs,
  geminiMs: p.geminiMs,
  parseMs: p.parseMs,
  totalMs: deadline.elapsed(),
});

/** Tidsgränsen nåddes utan ett försvarbart svar. */
function deadlineHit(input: IdentifyInput, p: Progress, deadline: Deadline) {
  const trace = p.traces[p.traces.length - 1] ?? null;
  return unavailable("Sökningens livslängd gick ut.", "deadline", trace, withDeadline(summarize("identify", p.traces, stagesOf(input, p, deadline), 1), deadline, true));
}

/** Ett anrop som svarade, eller det utfall identifieringen slutar med när det inte gjorde det. */
type RoundCall = { ok: true; out: InteractionOutcome } | { ok: false; outcome: IdentifyOutcome };

/** Minsta antal sökfrågor som är värda att starta en ny omgång för. */
const MIN_ROUND_QUERIES = 2;

async function identifyWithin(input: IdentifyInput, deps: ResearchDeps & { deadline: Deadline }, deadline: Deadline, p: Progress): Promise<IdentifyOutcome> {
  const run = deps.run ?? runInteraction;
  const label = input.label ?? "";
  /** Sökfrågor för HELA identifieringen: tillåtelsen ur kostnadsboken, annars förvalet. Omgångarna delar på dem. */
  const total = input.maxSearchQueries ?? IDENTIFY_MAX_QUERIES;
  const queriesUsed = () => p.traces.reduce((n, t) => n + t.usage.searchQueries, 0);

  /** ETT modellanrop med omförsök för tillfälliga fel (överbelastning, nätverk) — inom samma klocka. */
  const callOnce = async (plan: RoundPlan): Promise<RoundCall> => {
    for (let attempt = 1; ; attempt++) {
      // Arbete som inte hinner bli klart startas inte: ett anrop utan tid kvar kostar pengar och ger ingenting.
      if (!deadline.canStart(IDENTIFY_MIN_CALL_MS)) {
        console.warn(`[research] ${label} identify: ${deadline.remaining()} ms kvar — för lite för ett helt anrop, startar inget`);
        return { ok: false, outcome: deadlineHit(input, p, deadline) };
      }
      const t = Date.now();
      try {
        let out = await run(identifyRequest(input, deps, plan));
        // Citaten och modellens egna adresser är Googles omdirigeringar: lös dem till sidorna de pekar på, så att bildletaren och källistan får dem.
        if (deps.resolveUrls) out = await withResolvedUrls(out, deps.resolveUrls);
        p.geminiMs += Date.now() - t;
        p.traces.push(out.trace);
        return { ok: true, out };
      } catch (err) {
        p.geminiMs += Date.now() - t;
        const trace = err instanceof InteractionError ? err.trace : null;
        if (trace) p.traces.push(trace);
        let kind = failKindOf(err);
        // En "timeout" långt FÖRE tidsgränsen är inte vår budget som tog slut utan en anslutning som tystnade: ett tillfälligt nätfel.
        const atDeadline = deadline.remaining() <= IDENTIFY_RESERVE_MS + 250;
        if (kind === "timeout" && !atDeadline) kind = "network";
        if (TRANSIENT.has(kind) && attempt < 2 && deadline.canStart(IDENTIFY_MIN_CALL_MS)) {
          console.warn(`[research] ${label} identify: ${kind} efter ${Date.now() - t} ms — ett omförsök på samma modell (${deadline.remaining()} ms kvar)`);
          continue;
        }
        // En avbruten signal med klockans orsak är tidsgränsen, inte ett avbrott beställt av anroparen.
        const hit = kind === "timeout" || (kind === "aborted" && isDeadlineExceeded(deadline.signal.reason));
        const summary = withDeadline(summarize("identify", p.traces, stagesOf(input, p, deadline), plan.round), deadline, hit);
        return { ok: false, outcome: unavailable(reasonOf(err), hit && kind === "aborted" ? "deadline" : kind, trace, summary) };
      }
    }
  };

  /** Omgångarna som gav ett svar, och det svar som visas (den senaste omgången med minst en kandidat — en tom senare omgång kastar inte de tidigare). */
  const rounds: Array<{ round: number; parsed: ParsedIdentify; queries: string[] }> = [];
  /** Hur lång tid varje omgång som gav ett svar tog. */
  const roundMs: number[] = [];
  let best: { parsed: ParsedIdentify; dropped: DroppedCandidate[]; trace: ResearchTrace } | null = null;

  for (let round = 1; round <= IDENTIFY_MAX_ROUNDS; round++) {
    const left = total - queriesUsed();
    if (round > 1) {
      if (left < MIN_ROUND_QUERIES) {
        console.info(`[research] ${label} identify: ${left} sökfrågor kvar i tillåtelsen — ingen ${round}:e omgång`);
        break;
      }
      // En ny omgång startas bara om tiden kvar täcker en omgång som den hittills längsta: mätt 2026-10-25 tog en omgång 53–73 s, och en tredje
      // som startade med 40 s kvar stoppades av livslängden efter fem sökfrågor (≈0,96 SEK) utan att ge något.
      const needMs = Math.max(IDENTIFY_MIN_CALL_MS, Math.round(0.9 * Math.max(...roundMs)));
      if (!deadline.canStart(needMs)) {
        console.info(`[research] ${label} identify: ${deadline.remaining()} ms kvar, en omgång tar ≈${Math.round(needMs / 1000)} s — ingen ${round}:e omgång`);
        break;
      }
    }
    const plan: RoundPlan = {
      round,
      maxRounds: IDENTIFY_MAX_ROUNDS,
      queries: Math.max(1, Math.min(IDENTIFY_ROUND_QUERIES, left)),
      earlierRounds: rounds.length ? renderFindings(rounds) : null,
    };
    const call = await callOnce(plan);
    if (!call.ok) {
      // Första omgången utan svar är ett ärligt utan-kandidater-utfall. En senare omgång som faller lämnar de tidigare kvar.
      if (!best) return call.outcome;
      console.warn(`[research] ${label} identify: omgång ${round} gav inget svar — behåller omgång ${rounds[rounds.length - 1].round}`);
      break;
    }
    const out = call.out;
    const tp = Date.now();
    const parsed = parseIdentify(out.json, input);
    p.parseMs += Date.now() - tp;
    if (!parsed) {
      if (!best) return unavailable("Svaret gick inte att tolka.", "unparseable", out.trace, withDeadline(summarize("identify", p.traces, stagesOf(input, p, deadline), round), deadline, false));
      console.warn(`[research] ${label} identify: omgång ${round} gick inte att tolka — behåller omgång ${rounds[rounds.length - 1].round}`);
      break;
    }
    const gate = gateCandidates(parsed);
    if (gate.dropped.length) {
      console.info(`[research] ${label} identify: ${gate.dropped.length} kandidat(er) visas inte — ${gate.dropped.map((d) => `${d.model} (${d.reason})`).join(", ")}`);
    }
    const shown: ParsedIdentify = { ...parsed, candidates: gate.shown, exactMatch: gate.exactMatch };
    rounds.push({ round, parsed: shown, queries: out.trace.searchQueries });
    roundMs.push(out.trace.latencyMs);
    if (!best || shown.candidates.length > 0) best = { parsed: shown, dropped: gate.dropped, trace: out.trace };
    console.info(
      `[research] ${label} identify: omgång ${round}/${IDENTIFY_MAX_ROUNDS} — ${out.trace.searchQueries.length} sökfrågor, kandidater: ${shown.candidates.map((c) => `${c.model}(${c.confidence})`).join(", ") || "inga"}`,
    );
    // En stark toppkandidat — modellen har jämfört dokumenterade drag med bilderna och uteslutit de närmaste — avslutar. Allt annat får en omgång till.
    if (shown.exactMatch) break;
  }

  return finishIdentify({
    input,
    parsed: best!.parsed,
    dropped: best!.dropped,
    traces: p.traces,
    stages: stagesOf(input, p, deadline),
    geminiMs: p.geminiMs,
    parseMs: p.parseMs,
    deadline,
    passes: rounds.length,
    trace: best!.trace,
  });
}

// ─── Specifikationer ────────────────────────────────────────────────────────

export interface SpecInput {
  brand: string;
  model: string;
  variant?: string | null;
  productType?: string | null;
  sellerNote?: string | null;
  images: ResearchImage[];
  confirmedBy: "seller" | "identification";
  /** Sidor identifieringen redan hittat för modellen — en startpunkt som sparar sökningar. */
  startUrls?: string[];
  label?: string;
  prepareMs?: number;
  /** Läs inte det verifierade faktaminnet (en mätning, eller ett riktat omtag efter ett variantval). */
  skipCache?: boolean;
  /**
   * Taket på sökfrågor i anropet, ur kostnadsboken (cost/ledger.ts). 0 = inget söksverktyg: anropet läser bara `startUrls`.
   * Utelämnat = miljöns förval (mätskript).
   */
  maxSearchQueries?: number;
}

/**
 * En körare som svarar med färdiga fakta utifrån (AI-lägets svar, översatt till specschemat) i stället för att anropa Gemini. Specsökningens VANLIGA tolkning och
 * verifiering körs efteråt på svaret: källsidorna hämtas av oss och varje mått och material märks bekräftat, citerat eller obekräftat. Noll kostnad, inget sökande.
 * Inga citeringar i spåret: länkarna har AI-läget angett, inte vi besökt, så de räknas som uppgivna (sourcesUsed) och aldrig som verktygsbekräftade.
 */
export function externalSpecRunner(spec: Record<string, unknown>, label?: string): InteractionRunner {
  return async () => ({
    json: spec,
    text: JSON.stringify(spec),
    trace: { ...cachedTrace(label), model: "aimode", finishStatus: "external" },
  });
}

/** Ett spår för ett svar som kom ur faktaminnet: inget anrop gjordes, så allt är noll. */
function cachedTrace(label: string | undefined): ResearchTrace {
  return {
    model: "cache",
    purpose: "specs",
    label: label ?? null,
    latencyMs: 0,
    attempts: 0,
    reduced: false,
    searchQueries: [],
    fetchedUrls: [],
    citations: [],
    usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0, searchQueries: 0 },
    estimatedCostUsd: 0,
    finishStatus: "cache",
    thoughtSummary: null,
    timeline: [],
    timings: { firstEventMs: null, totalMs: 0, searchMs: 0, urlFetchMs: 0, modelMs: 0 },
    toolCalls: 0,
    stoppedBy: "completed",
    error: null,
    settings: { thinkingLevel: "none", tools: [], structured: false, images: 0, imageKb: 0, maxSearchQueries: null },
    failures: [],
  };
}

/**
 * Ett SpecOk byggt av redan belagda fakta — utan nytt anrop. Används av faktaminnet och av
 * variantvalet (som filtrerar de fakta jobbet redan bär i stället för att söka om).
 */
export function specFromFacts(
  facts: ProductFacts,
  opts: { variant?: string | null; label?: string; prepareMs?: number; startedAt?: number; note?: string },
): SpecOk {
  const view = viewForVariant(facts, opts.variant);
  const trace = cachedTrace(opts.label);
  const totalMs = Date.now() - (opts.startedAt ?? Date.now());
  const identity: SpecIdentity = { ...facts.identity, matchesPhotos: null };
  const summary = summarize("specs", [trace], { prepareImagesMs: opts.prepareMs, geminiMs: 0, parseMs: 0, verifyMs: 0, totalMs }, 0);
  return {
    kind: "ok",
    identity,
    variants: facts.variants,
    productPages: facts.productPages ?? [],
    productFacts: facts,
    fromCache: true,
    dimensions: facts.dimensions,
    materials: facts.materials,
    facts: facts.facts,
    retailPrice: facts.retailPrice,
    conflicts: facts.conflicts,
    missing: facts.missing,
    rejected: [],
    sources: facts.sources,
    trace,
    summary,
    researchText: specResearchText({ identity, view, retailPrice: facts.retailPrice, conflicts: facts.conflicts, missing: facts.missing, summary: null, sources: facts.sources, trace }),
  };
}

/**
 * Svar ur faktaminnet, om det finns ett som gäller. Ett val av variant som minnet saknar mått för
 * ger ingen träff: då görs ett riktat omtag på den varianten.
 */
async function specsFromCache(input: SpecInput, startedAt: number): Promise<SpecOk | null> {
  if (input.skipCache) return null;
  const facts = await loadFacts(input.brand, input.model);
  if (!facts) return null;
  if (viewForVariant(facts, input.variant).needsResearch) return null;
  const spec = specFromFacts(facts, { variant: input.variant, label: input.label, prepareMs: input.prepareMs, startedAt });
  console.info(
    `[research] ${input.label ?? ""} specs ${input.brand} ${input.model}: ur faktaminnet — mått=${facts.dimensions.length} material=${facts.materials.length}` +
      ` varianter=${facts.variants.length} åldrad=${Math.round((Date.now() - facts.researchedAt) / 3_600_000)} h ms=${spec.summary.totalMs} cost≈$0`,
  );
  return spec;
}

// ─── Specsanropet ────────────────────────────────────────────────────────────

function specRequest(input: SpecInput, deps: ResearchDeps): InteractionRequest {
  const cap = input.maxSearchQueries;
  const urlOnly = cap === 0;
  return {
    purpose: "specs",
    label: input.label,
    model: deps.model,
    systemInstruction: specSystemInstruction({
      searchBudget: Math.max(1, Math.min(SPEC_SEARCH_BUDGET, cap ?? SPEC_SEARCH_BUDGET)),
      urlOnly,
    }),
    prompt: buildSpecPrompt({
      brand: input.brand,
      model: input.model,
      variant: input.variant,
      productType: input.productType,
      sellerNote: input.sellerNote,
      imageCount: input.images.length,
      confirmedBy: input.confirmedBy,
      startUrls: input.startUrls,
      urlOnly,
    }),
    images: input.images,
    schema: SPEC_SCHEMA,
    thinkingLevel: SPEC_THINKING,
    timeoutMs: SPEC_TIMEOUT_MS,
    // Utan söksbudget inget söksverktyg alls: URL-verktyget faktureras som tokens, sökfrågor som 0,15 SEK styck.
    ...(urlOnly ? { tools: ["url_context" as const] } : { maxSearchQueries: Math.min(SPEC_MAX_QUERIES, cap ?? SPEC_MAX_QUERIES) }),
    maxOutputTokens: SPEC_MAX_OUTPUT_TOKENS,
    // ETT anrop. Ett fall hanteras av researchSpecs (ett omförsök vid tillfälligt fel) och av säljaren — aldrig av en dold andra körning.
    signal: deps.signal,
  };
}

type SpecCalls =
  | { ok: true; json: Record<string, unknown> | null; trace: ResearchTrace; traces: ResearchTrace[]; recovered?: boolean }
  | { ok: false; err: unknown; trace: ResearchTrace | null; traces: ResearchTrace[] };

const traceOf = (err: unknown): ResearchTrace | null => (err instanceof InteractionError ? err.trace : null);

async function runSpecCalls(input: SpecInput, deps: ResearchDeps, run: InteractionRunner, shape: (req: InteractionRequest) => InteractionRequest = (r) => r): Promise<SpecCalls> {
  try {
    let out = await run(shape(specRequest(input, deps)));
    // Måttens källadresser är Googles omdirigeringar: lösta kan sidan hämtas och måttet bekräftas mot den, i stället för att för alltid vara "citerat".
    if (deps.resolveUrls) out = await withResolvedUrls(out, deps.resolveUrls);
    return { ok: true, json: (out.json ?? null) as Record<string, unknown> | null, trace: out.trace, traces: [out.trace], ...(out.recovered ? { recovered: true } : {}) };
  } catch (err) {
    const t = traceOf(err);
    return { ok: false, err, trace: t, traces: t ? [t] : [] };
  }
}

function failedSpecs(input: SpecInput, calls: Extract<SpecCalls, { ok: false }>, startedAt: number) {
  const geminiMs = Date.now() - startedAt;
  return unavailable(
    reasonOf(calls.err),
    failKindOf(calls.err),
    calls.trace,
    calls.traces.length ? summarize("specs", calls.traces, { prepareImagesMs: input.prepareMs, geminiMs, parseMs: 0, totalMs: geminiMs + (input.prepareMs ?? 0) }, 1) : null,
  );
}

/** Fel som går över av sig själva (överbelastning, nätverk): ett andra försök på samma modell har en chans, och ett anrop som föll fakturerades inte. */
const TRANSIENT_SPEC = new Set(["overloaded", "network"]);

/**
 * Specsökningen: ETT anrop, inom det som kostnadsbudgeten rymmer.
 *
 * Förut gick ett snabbspår (ett reducerat anrop bredvid det fulla), en säkring och ett reducerat omförsök bredvid eller efter det fulla
 * anropet — upp till tre betalda anrop för samma modell, och de visade ett preliminärt svar medan det fulla letade. Det var
 * latensarbete mot en klocka som inte längre finns: specsökningen körs numera i bakgrunden medan säljaren svarar på frågor och granskar
 * skicket, och granskningen av måtten ligger sist i flödet. Och kostnaden gick inte ihop — varje extra anrop är sökfrågor à 0,15 SEK mot ett
 * tak på 2,00 SEK för hela omgången (cost/ledger.ts).
 *
 * Kostnaden styrs av `input.maxSearchQueries` (tillåtelsen ur boken): med 0 körs anropet UTAN söksverktyg och läser bara de sidor
 * identifieringen redan hittat (`input.startUrls`) — URL-verktyget faktureras bara som tokens. Finns varken söksutrymme eller sidor att läsa
 * finns inget att göra, och svaret är ärligt: ingen specsökning.
 *
 * Faller anropet snabbt på ett tillfälligt fel görs ETT omförsök på samma modell; allt annat får säljaren (eller ett omtag) avgöra.
 */
export async function researchSpecs(input: SpecInput, rawDeps: ResearchDeps = {}): Promise<SpecOutcome> {
  const deps = resolveDeps(rawDeps);
  const run = deps.run ?? runInteraction;
  const startedAt = Date.now();
  const cached = await specsFromCache(input, startedAt);
  if (cached) return cached;
  if (input.maxSearchQueries === 0 && !input.startUrls?.length) {
    return unavailable("Kostnadstaket för omgången rymmer ingen sökning och det finns inga sidor att läsa.", "budget", null);
  }
  let calls = await runSpecCalls(input, deps, run);
  if (!calls.ok && TRANSIENT_SPEC.has(failKindOf(calls.err)) && Date.now() - startedAt < 15_000) {
    console.warn(`[research] ${input.label ?? ""} specs: ${failKindOf(calls.err)} efter ${Date.now() - startedAt} ms — ett omförsök på samma modell`);
    const again = await runSpecCalls(input, deps, run);
    calls = again.ok ? { ...again, traces: [...calls.traces, ...again.traces] } : { ...again, traces: [...calls.traces, ...again.traces] };
  }
  return calls.ok ? finishSpecs(input, deps, calls, { startedAt }) : failedSpecs(input, calls, startedAt);
}

async function finishSpecs(
  input: SpecInput,
  deps: ResearchDeps,
  calls: Extract<SpecCalls, { ok: true }>,
  ctx: { startedAt: number; extraTraces?: ResearchTrace[] },
): Promise<SpecOutcome> {
  const { startedAt } = ctx;
  const geminiMs = Date.now() - startedAt;
  const { json, trace } = calls;
  // Snabbspårets kostnad hör till svaret även när det avbröts — men det SISTA spåret är alltid det som gav svaret.
  const traces = [...(ctx.extraTraces ?? []), ...calls.traces];
  const j = (json ?? {}) as Record<string, unknown>;
  if (!json || typeof j !== "object") {
    return unavailable("Svaret gick inte att tolka.", "unparseable", trace, summarize("specs", traces, { prepareImagesMs: input.prepareMs, geminiMs, parseMs: 0, totalMs: geminiMs }, 1));
  }
  const parseStart = Date.now();

  const rawId = (j.identity ?? {}) as Record<string, unknown>;
  const identity: SpecOk["identity"] = {
    brand: str(rawId.brand, 80) ?? input.brand,
    model: str(rawId.model, 80) ?? input.model,
    variant: str(rawId.variant, 80),
    category: str(rawId.category, 60),
    confidence: rawId.confidence === "high" || rawId.confidence === "medium" || rawId.confidence === "low" ? rawId.confidence : "medium",
    matchesPhotos: typeof rawId.matchesPhotos === "boolean" ? rawId.matchesPhotos : null,
    note: str(rawId.note, 300),
    discontinued: typeof rawId.discontinued === "boolean" ? rawId.discontinued : null,
  };

  const dimsRaw = Array.isArray(j.dimensions) ? (j.dimensions as Array<Record<string, unknown>>) : [];
  const matsRaw = Array.isArray(j.materials) ? (j.materials as Array<Record<string, unknown>>) : [];
  const factsRaw = Array.isArray(j.otherFacts) ? (j.otherFacts as Array<Record<string, unknown>>) : [];
  const usedRaw = Array.isArray(j.sourcesUsed) ? (j.sourcesUsed as Array<Record<string, unknown>>) : [];
  const variantsRaw = Array.isArray(j.variants) ? (j.variants as Array<Record<string, unknown>>) : [];

  const dimensions0 = dimsRaw.map(normalizeDimension).filter((d): d is NonNullable<typeof d> => d !== null);
  const materials0 = matsRaw.map(normalizeMaterial).filter((m): m is NonNullable<typeof m> => m !== null);
  const facts0 = factsRaw.map(normalizeFact).filter((f): f is NonNullable<typeof f> => f !== null);
  const variants0 = variantsRaw.map(normalizeVariant).filter((v): v is NonNullable<typeof v> => v !== null).slice(0, 8);

  const knownUrls = toolConfirmedUrls(trace);
  const claimedUrls = new Set<string>();
  for (const s of usedRaw) {
    const u = cleanUrl(s.url);
    if (u) claimedUrls.add(u);
  }

  const parseMs = Date.now() - parseStart;
  const verifyStart = Date.now();
  const verified = await verifyClaims({
    brand: input.brand,
    model: identity.model || input.model,
    knownUrls,
    claimedUrls,
    dimensions: dimensions0,
    materials: materials0,
    facts: facts0,
    fetchPage: deps.fetchPage,
    enabled: deps.verifyPages,
  });
  const verifyMs = Date.now() - verifyStart;

  // Nypris: bara från en känd källa som inte är en begagnatsajt.
  let retailPrice: SpecOk["retailPrice"] = null;
  const priceUrl = cleanUrl(j.retailPriceSourceUrl);
  if (typeof j.retailPriceSek === "number" && Number.isFinite(j.retailPriceSek) && j.retailPriceSek >= 50 && j.retailPriceSek <= 300_000) {
    const known = !!priceUrl && (knownUrls.has(priceUrl) || claimedUrls.has(priceUrl)) && !isMarketplace(priceUrl);
    if (known) retailPrice = { valueSek: Math.round(j.retailPriceSek), sourceUrl: priceUrl, verification: knownUrls.has(priceUrl!) ? "cited" : "unverified" };
    else verified.rejected.push({ what: `nypris ${j.retailPriceSek} kr`, why: priceUrl ? `källan ${priceUrl} är okänd eller en begagnatsajt` : "ingen källa" });
  }

  // Källorna som visas: aldrig en död adress, en bildfil eller en omdirigering — de duger inte att klicka på.
  const unlinkable = new Set(verified.unlinkable);
  const linkable = (u: string) => !unlinkable.has(u) && !isImageAssetUrl(u);
  const sources = buildSources(
    [
      ...trace.citations.filter((c) => linkable(c.url)).map((c) => ({ url: c.url, title: c.title, cited: true })),
      ...trace.fetchedUrls.filter((f) => linkable(f.url)).map((f) => ({ url: f.url, title: null, retrieved: /success|ok|completed|retrieved/i.test(f.status) })),
      ...usedRaw.filter((s) => linkable(String(s.url ?? ""))).map((s) => ({ url: String(s.url ?? ""), title: str(s.title, 120), cited: true })),
      ...[...verified.dimensions, ...verified.materials].filter((x) => x.sourceUrl).map((x) => ({ url: x.sourceUrl!, title: null, cited: true })),
    ],
    input.brand,
  );

  const conflicts = strList(j.conflicts, 10);
  const missing = strList(j.missing, 20);
  // Ett avkortat svar lagades till det som hann bli komplett: säg det, så att det som saknas inte läses som "finns inte".
  if (calls.recovered) missing.push("Svaret avkortades av tjänsten — fler mått och material kan finnas dokumenterade än de som visas.");
  const summary = str(j.summary, 4000);
  const productPages = [...new Set(strList(j.productPages, 4).map((u) => cleanUrl(u)).filter((u): u is string => !!u && !isMarketplace(u) && !isRedirectUrl(u) && !isImageAssetUrl(u)))].slice(0, 3);

  // ── Den enda sanningen om produkten. Allt nedan — texten till generatorn, raderna, kortet — läser ur den. ──
  const productFacts = buildProductFacts({
    identity,
    variants: variants0,
    dimensions: verified.dimensions,
    materials: verified.materials,
    facts: verified.facts,
    retailPrice,
    sources,
    conflicts,
    missing,
    brand: input.brand,
    runOk: trace.stoppedBy === "completed",
    rejectedCount: verified.rejected.length,
    unlinkable: verified.unlinkable,
    productPages,
  });
  const view = viewForVariant(productFacts, input.variant);
  // Ett svar som inte var inriktat på en variant gäller hela produkten och får minnas. Ett riktat omtag
  // (variant satt) täcker bara en variant och skulle få nästa säljare att tro att resten saknas.
  // Inte heller AI-lägets svar (finishStatus "external"): det gäller EN variant, den som syntes på säljarens bilder, och skulle bli minnet för hela modellen åt nästa säljare.
  if (!input.variant && deps.verifyPages !== false && trace.finishStatus !== "external") void saveFacts(input.brand, input.model, productFacts);
  const dimensions = productFacts.dimensions;
  const materials = productFacts.materials;

  const researchText = specResearchText({ identity, view, retailPrice, conflicts, missing, summary, sources, trace });

  const runSummary = summarize(
    "specs",
    traces,
    { prepareImagesMs: input.prepareMs, geminiMs, parseMs, verifyMs, totalMs: Date.now() - startedAt + (input.prepareMs ?? 0) },
    1,
  );
  console.info(
    `[research] ${input.label ?? ""} specs ${input.brand} ${input.model}: mått=${dimensions.length} (bekräftade ${dimensions.filter((d) => d.verified).length})` +
      ` material=${materials.length} (bekräftade ${materials.filter((m) => m.verified).length}) varianter=${productFacts.variants.length}` +
      ` avvisade=${verified.rejected.length} olänkbara=${verified.unlinkable.length}` +
      ` sidor=${verified.pagesRead}/${verified.pagesTried} källor=${sources.length}` +
      ` ms=${runSummary.totalMs} (förberedelse ${input.prepareMs ?? 0}, gemini ${geminiMs}, tolkning ${parseMs}, verifiering ${verifyMs}) cost${runSummary.costIsLowerBound ? "≥" : "≈"}$${runSummary.costUsd}`,
  );

  return {
    kind: "ok",
    identity,
    variants: productFacts.variants,
    productPages,
    productFacts,
    dimensions,
    materials,
    facts: productFacts.facts,
    retailPrice,
    conflicts,
    missing,
    rejected: verified.rejected,
    sources,
    trace,
    summary: runSummary,
    researchText,
  };
}

const level =(v: VerificationLevel) => (v === "page_confirmed" ? " [bekräftad mot sidan]" : v === "cited" ? " [citerad]" : " [ej bekräftad]");

/**
 * Texten generatorn skriver annonsen ur — byggd av vyn för den variant som gäller, aldrig av alla
 * varianters mått på en gång. Är varianten ännu inte vald står det uttryckligen vilka mått som
 * hålls tillbaka, så att texten inte fyller i dem ur minnet.
 */
export function specResearchText(a: {
  identity: SpecIdentity;
  view: FactsView;
  retailPrice: SpecOk["retailPrice"];
  conflicts: string[];
  missing: string[];
  summary: string | null;
  sources: ResearchSource[];
  trace: ResearchTrace;
}): string {
  const { identity, view } = a;
  const lengths = view.dimensions.filter((d) => isLengthType(d.type));
  const others = view.dimensions.filter((d) => !isLengthType(d.type));
  return [
    `SPECIFIKATIONER för ${identity.brand} ${identity.model}${view.variant ? ` (${view.variant})` : identity.variant ? ` (${identity.variant})` : ""} (${a.trace.model}, ${a.trace.searchQueries.length} sökningar, ${a.trace.fetchedUrls.length} hämtade sidor)`,
    identity.category ? `Produkttyp: ${identity.category}` : null,
    identity.matchesPhotos === false ? "VARNING: den dokumenterade produkten stämmer inte uppenbart med bilderna." : null,
    identity.discontinued ? "Produkten är utgången ur sortimentet." : null,
    view.ambiguous
      ? `VARIANT EJ VALD: produkten finns i ${view.options.map((v) => v.label).join(" / ")} och måtten skiljer sig. Skriv INTE ut ${view.heldBack.map((h) => h.label.toLowerCase()).join(", ") || "variantberoende mått"} i texten, och gissa inte vilken variant det är.`
      : null,
    ...view.heldBack.filter((h) => h.reason === "contradiction").map((h) => `OSÄKERT, SKRIV INTE UT: ${h.label} (${h.values.join(", ")}) — uppgifterna höll inte ihop.`),
    lengths.length ? "MÅTT:" : "MÅTT: INGA",
    ...lengths.map((d) => `MÅTT: ${d.label} | ${d.display}${d.sourceUrl ? ` (källa: ${d.sourceUrl})` : ""}${level(d.verification)}`),
    ...view.materials.map((m) => `MATERIAL: ${m.component} | ${m.material}${m.detail ? ` — ${m.detail}` : ""}${m.sourceUrl ? ` (källa: ${m.sourceUrl})` : ""}${level(m.verification)}`),
    ...others.map((d) => `ÖVRIGT: ${d.label} | ${d.display}${d.sourceUrl ? ` (källa: ${d.sourceUrl})` : ""}`),
    ...view.facts.filter((f) => f.verification !== "unverified").map((f) => `ÖVRIGT: ${f.label} | ${f.value}${f.sourceUrl ? ` (källa: ${f.sourceUrl})` : ""}`),
    a.retailPrice ? `NYPRIS: ${a.retailPrice.valueSek} kr${a.retailPrice.sourceUrl ? ` (källa: ${a.retailPrice.sourceUrl})` : ""}` : "NYPRIS: kunde inte bekräftas",
    a.conflicts.length ? `MOTSTRIDIGA UPPGIFTER: ${a.conflicts.join(" | ")}` : null,
    a.missing.length ? `SAKNAS: ${a.missing.join("; ")}` : null,
    a.summary ? `Sammanfattning: ${a.summary}` : null,
    a.sources.length ? `KÄLLOR:\n${a.sources.map((s) => `- ${s.title} ${s.url}`).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Till appens typer ──────────────────────────────────────────────────────

export function toModelCandidates(outcome: IdentifyOutcome): ModelCandidate[] {
  if (outcome.kind !== "ok") return [];
  return outcome.candidates.map((c) => ({
    brand: c.brand,
    model: c.model,
    variant: c.variant,
    productType: c.productType,
    confidence: c.confidence,
    distinguishingDetail: c.distinguishingDetail ?? (c.evidence.length ? c.evidence.slice(0, 2).join(", ") : null),
    sourceUrl: c.sourceUrl,
    productPages: c.productPages ?? [],
    evidence: c.evidence,
  }));
}

export function toSourceRefs(sources: ResearchSource[]): SourceRef[] {
  return sources.filter((s) => !isRedirectUrl(s.url)).map((s) => ({ title: s.title, url: s.url, qualityTier: s.tier }));
}

/**
 * Mått, material och övriga fakta som annonsens attribut — en VY av produktens fakta för den variant
 * som gäller (se productFacts.ts). Etiketterna är rena; varianten, belägget och typen ligger i egna fält.
 */
export function toListingAttributes(spec: SpecOk, variant?: string | null): ListingAttribute[] {
  return toAttributes(viewForVariant(spec.productFacts, variant ?? null));
}

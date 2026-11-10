/**
 * Kostnadsbokföringen för EN genereringsomgång: en möbel, från bilder till färdigt kort.
 *
 * TVÅ TAL, OLIKA SAKER (2026-10-25). Det affärsmässiga MÅLET är ungefär 2,00 SEK per komplett omgång (`ATTEMPT_TARGET_SEK`): det mäts och
 * rapporteras, och spillet — sökningar som upprepar sig, dubbla anrop, spekulativ forskning — ska bort. Det är INTE ett tak: en svår, utgången
 * modell får kosta mer när mer tänkande och sökning faktiskt ger rätt svar, och kvaliteten sänks aldrig automatiskt för att tvinga en omgång under
 * målet. Det som SKYDDAR mot okontrollerade utgifter är en separat, inställbar säkerhetsbudget (`ATTEMPT_BUDGET_SEK`, förval 6,00 SEK): det är
 * den som tillåtelserna räknas mot, och den som stoppar betalt arbete som inte ryms.
 *
 * VARFÖR DEN FINNS. Googles sökavgift är 14 USD per 1 000 sökfrågor modellen väljer att köra (≈ 0,15 SEK per fråga) och sökrundor med
 * tänkande och öppnade produktsidor är det som ger rätt modell; utan bokföring syns inte vad kvalitet kostar.
 *
 * VAD DEN GÖR.
 *  - Varje betalt anrop skrivs in (`CostEntry`) med tokens, sökfrågor och uppskattad kostnad i USD — också de som föll eller avbröts. Sökfrågorna
 *    räknas som BETALDA: de 5 000 gratis i månaden är ingen affärsgrund (se SEARCH_USD_PER_QUERY).
 *  - Varje sökande steg får en TILLÅTELSE (`searchAllowance`): det som är kvar av säkerhetsbudgeten minus det som måste sparas åt steg som ännu
 *    inte körts. Tillåtelsen blir ett tak på antalet sökfrågor i anropet.
 *  - Är säkerhetsbudgeten slut startas inget mer betalt arbete (`canSpend`); det som redan finns levereras med en tydlig markering att omgången
 *    är ofullständig. Policyn nära gränsen: obligatoriskt arbete nedströms (skick, annonstext) har sin reserv och går före ett nytt
 *    modellförslag eller ett reservförsök.
 *
 * VAD SOM HÅLLS AV GOOGLE OCH VAD SOM INTE GÖR DET.
 *  - Utdata inklusive tänkande har ett tak per anrop (`generation_config.max_output_tokens`) som TJÄNSTEN verkställer. Det är ett skydd mot ett
 *    skenande anrop och sätts väl över ett normalt svar: ett för snävt tak avkortar svaret (och faktureras ändå).
 *  - Sökfrågor har INGEN parameter hos Google (dokumentationen nämner ingen). Taket verkställs av oss på strömmen. Ett verktygsanrop bär flera
 *    frågor och ses först när det är utfärdat, så överskottet kan bli ett anrop.
 *  - Ett avbrutet anrop rapporterar ingen användning (då uppskattas den uppåt). Googles projektgräns ("spend cap" i AI Studio) är experimentell,
 *    ≈10 minuters fördröjning, och gäller hela projektet — inte en omgång.
 * Därför är säkerhetsbudgeten ett tak som verkställs per steg, inte en garanti från leverantören. Siffrorna står i docs/kvalitet-2026-10-25.md.
 */

import { PRICE_PER_MILLION } from "../research/config.js";

const envNumber = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Växelkursen som kostnaden räknas om med. Spotkursen var 9,9–10,05 SEK per USD i oktober 2026 (exchange-rates.org, 2026-10-19); här står
 * 11,0, alltså ≈10 % säkerhetsmarginal åt det dyrare hållet. `LOOPA_USD_SEK` ändrar den.
 */
export const USD_SEK = envNumber("LOOPA_USD_SEK", 11.0);

/**
 * Det affärsmässiga MÅLET för en komplett omgång, i SEK — vad en typisk omgång ska kosta. Rapporteras (`overTarget`), tvingar ingenting.
 * `LOOPA_ATTEMPT_TARGET_SEK` ändrar det.
 */
export const ATTEMPT_TARGET_SEK = envNumber("LOOPA_ATTEMPT_TARGET_SEK", 2.0);

/**
 * Säkerhetsbudgeten för en omgång, i SEK: det inställbara tak som skyddar mot okontrollerade utgifter och som tillåtelserna räknas mot. Ligger
 * medvetet över målet — en svår modell får kosta mer. `LOOPA_ATTEMPT_BUDGET_SEK` ändrar det.
 */
export const ATTEMPT_BUDGET_SEK = envNumber("LOOPA_ATTEMPT_BUDGET_SEK", 6.0);

/** Google-sökning: 14 USD per 1 000 sökfrågor, betalt per fråga modellen kör. Gratisnivån (5 000 per månad) räknas INTE in. */
export const SEARCH_USD_PER_QUERY = 14 / 1000;

export type CostStage = "identify" | "specs" | "condition" | "listing" | "variants" | "price" | "other";

export interface CostEntry {
  stage: CostStage;
  /** Anropets syfte: "identify", "specs", "main_inspection", "seller_generate" … */
  label: string;
  model: string;
  at: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  searchQueries: number;
  /** Uppskattad kostnad i USD, sökfrågorna räknade som betalda. */
  usd: number;
  /** Användningen rapporterades inte (avbrutet anrop): tokens är uppskattade UPPÅT och summan är en uppskattning. */
  estimated?: boolean;
  /** Anropet gav ett användbart svar. Ett som föll kostar ändå — det står med. */
  ok: boolean;
  note?: string;
}

export interface JobCost {
  /** Taket när jobbet skapades. Ändras inte av senare inställningar — det som gällde då är det som mäts mot. */
  budgetSek: number;
  usdSek: number;
  entries: CostEntry[];
}

export function newJobCost(budgetSek = ATTEMPT_BUDGET_SEK, usdSek = USD_SEK): JobCost {
  return { budgetSek, usdSek, entries: [] };
}

// ─── Priser ───────────────────────────────────────────────────────────────────

/** Prioritetsnivån (`serviceTier: priority`) kostar 1,8 gånger standardpriset på samma modell (ai.google.dev/gemini-api/docs/pricing, 2026-10-23). */
export const PRIORITY_MULTIPLIER = 1.8;

/** Tokenkostnaden (utan sökavgift) i USD. Okända modeller räknas som gemini-3.8-flash. */
export function tokenUsd(model: string, usage: { inputTokens: number; outputTokens: number; thoughtTokens: number }, tier: "standard" | "priority" = "standard"): number {
  const price = PRICE_PER_MILLION[model] ?? PRICE_PER_MILLION["gemini-3.8-flash"];
  const usd = (usage.inputTokens * price.input + (usage.outputTokens + usage.thoughtTokens) * price.output) / 1_000_000;
  return usd * (tier === "priority" ? PRIORITY_MULTIPLIER : 1);
}

/**
 * Totalen i tokens utan uppdelning (besiktningens anrop rapporterar bara den). Räknas med ett konservativt blandat pris: 85 % indata
 * (bilderna) och 15 % utdata inklusive tankande, vilket ger ≈1,2 USD per miljon tokens på gemini-3.6-flash — drygt dubbelt det
 * gamla "blandade" talet i run.ts (0,6) och därför på den säkra sidan.
 */
export function totalTokensUsd(model: string, totalTokens: number, tier: "standard" | "priority" = "standard"): number {
  return tokenUsd(model, { inputTokens: Math.round(totalTokens * 0.85), outputTokens: Math.round(totalTokens * 0.15), thoughtTokens: 0 }, tier);
}

/**
 * Ett avbrutet anrop rapporterar ingen användning. Det har ändå tänkt och skrivit tills det avbröts: uppskatta utdata uppåt ur tiden
 * (≈80 tokens per sekund, högst 8 000) i stället för att räkna noll.
 */
export function abortedOutputTokens(latencyMs: number): number {
  return Math.min(8_000, Math.round((latencyMs / 1000) * 80));
}

export const usdToSek = (usd: number, usdSek = USD_SEK): number => usd * usdSek;

// ─── Summor ───────────────────────────────────────────────────────────────────

export const spentUsd = (c: JobCost): number => c.entries.reduce((n, e) => n + e.usd, 0);
export const spentSek = (c: JobCost): number => usdToSek(spentUsd(c), c.usdSek);
export const remainingSek = (c: JobCost): number => c.budgetSek - spentSek(c);

export function byStage(c: JobCost): Record<string, { usd: number; sek: number; searchQueries: number; calls: number }> {
  const out: Record<string, { usd: number; sek: number; searchQueries: number; calls: number }> = {};
  for (const e of c.entries) {
    const s = (out[e.stage] ??= { usd: 0, sek: 0, searchQueries: 0, calls: 0 });
    s.usd += e.usd;
    s.sek += usdToSek(e.usd, c.usdSek);
    s.searchQueries += e.searchQueries;
    s.calls += 1;
  }
  return out;
}

/** `within`: under taket med marginal. `tight`: över 80 % förbrukat. `exceeded`: taket passerat — inget mer betalt arbete startas. */
export type BudgetStatus = "within" | "tight" | "exceeded";
export function budgetStatus(c: JobCost): BudgetStatus {
  const used = spentSek(c) / c.budgetSek;
  return used >= 1 ? "exceeded" : used >= 0.8 ? "tight" : "within";
}

// ─── Tillåtelser ──────────────────────────────────────────────────────────────

/**
 * Vad ett steg beräknas kosta i tokens (USD), före sökfrågorna. MÄTT 2026-10-24/25 (riktiga omgångar, tom svarscache):
 *   - identifiering: 0,025–0,15 USD per ANROP i tokens (bilderna, tänkandet och — den stora variabeln — sidor modellen öppnar). Identifieringen är högst
 *     tre anrop i följd (research/config.ts), så 0,18 planeras för hela steget;
 *   - specar, tre produktsidor: ≈0,07–0,09 USD — kostnaden är SIDORNA (≈30 000 indatatokens per IKEA-sida, ≈0,023 USD) plus tänkandet.
 */
export const STAGE_TOKEN_USD: Record<"identify" | "specs", number> = { identify: 0.18, specs: 0.08 };

/**
 * Marginal som aldrig planeras bort, i SEK. Tokenkostnaden rapporteras först när ett anrop är klart, och specsökningen får det som blir kvar.
 * 5 % av säkerhetsbudgeten.
 */
export const SAFETY_MARGIN_SEK = 0.3;

/**
 * Det som SPARAS åt ett steg som ännu inte körts, i SEK. Mätt 2026-10-24 på riktiga omgångar med tom svarscache: besiktningen 0,10–0,30 (medel
 * ≈0,17), annonstexten 0,03–0,07 (flash-lite, en strukturering), varianterna 0,03–0,05, prismotorn gör inget betalt anrop i de uppmätta körningarna
 * (reserven är en marginal), och specarna — det dyra steget — räknas som sina tokens (≈0,9). Identifieringen har ingen reserv: den kör först
 * och får resten.
 */
export const STAGE_RESERVE_SEK: Record<Exclude<CostStage, "identify" | "other">, number> = {
  condition: 0.25,
  specs: STAGE_TOKEN_USD.specs * USD_SEK,
  listing: 0.1,
  variants: 0.05,
  price: 0.03,
};

export interface Allowance {
  /** Kvar att spendera på steget efter att övriga steg fått sitt. Kan vara negativt. */
  availableSek: number;
  /** Antal sökfrågor säkerhetsbudgeten rymmer för steget, tokens frånräknade. Aldrig negativt. Taket på anropet. */
  searchQueries: number;
}

/** Steg som redan har minst en post och därför inte längre behöver en reserv. */
function started(c: JobCost): Set<CostStage> {
  return new Set(c.entries.map((e) => e.stage));
}

export function searchAllowance(c: JobCost, stage: "identify" | "specs"): Allowance {
  const done = started(c);
  let reserved = 0;
  for (const [s, sek] of Object.entries(STAGE_RESERVE_SEK) as Array<[keyof typeof STAGE_RESERVE_SEK, number]>) {
    if (s !== stage && !done.has(s)) reserved += sek;
  }
  const availableSek = remainingSek(c) - reserved - SAFETY_MARGIN_SEK;
  const searchUsd = availableSek / c.usdSek - STAGE_TOKEN_USD[stage];
  const searchQueries = Math.max(0, Math.floor(searchUsd / SEARCH_USD_PER_QUERY));
  return { availableSek, searchQueries };
}

/**
 * Det minsta ett nytt skickförsök ska ha kvar för att få startas: en besiktning kostar ≈0,25 SEK uppmätt (≈15 000 tokens in, ≈3 000 ut), och ett
 * omtag som inte ryms skulle lägga omgången över taket. Säljaren får då veta det i stället för att ett betalt anrop startas i det tysta.
 */
export const CONDITION_RETRY_MIN_SEK = 0.4;

/** Rymmer budgeten ett steg som kostar `sek`? Nej när taket redan är passerat. */
export function canSpend(c: JobCost, sek: number): boolean {
  return remainingSek(c) >= sek;
}

/**
 * Vad en ofullständig omgång ska säga. `null` när allt gick inom taket. Texten är för loggen och för säljaren, som ska få veta att kortet
 * inte är helt — inte varför.
 */
export function incompleteReason(c: JobCost): string | null {
  return budgetStatus(c) === "exceeded" ? "Kostnadstaket för omgången nåddes — kortet är inte komplett." : null;
}

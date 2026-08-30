import type {
  ConditionResult,
  Damage,
  DamageType,
  FurnitureIdentity,
  PriceDamageLine,
  PriceEstimate,
  Severity,
} from "./types.js";
import { damageStands } from "./pipeline/grade.js";

const PRICE_ENGINE_URL = (process.env.PRICE_ENGINE_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const PRICE_ENGINE_API_KEY = process.env.PRICE_ENGINE_API_KEY ?? null;
/** The corpus lives in memory on the Python side, so a warm query is fast; this only guards a hung socket. */
const PRICE_TIMEOUT_MS = Number(process.env.PRICE_ENGINE_TIMEOUT_MS ?? 45000);
/**
 * OFF by default, and measured before it was: sending a frame makes the engine classify the furniture
 * type from it, which is an external LLM call its client builds with no timeout and two retries. A text
 * -only query answers in well under a second; the same query with one frame attached had not returned
 * after three minutes, and the price step died on our own timeout instead.
 *
 * Nothing is lost by leaving it off. The engine's type system already derives the furniture type from
 * the model name itself — "Landskrona" resolves to soffa with the union of bäddsoffa/hörnsoffa kept as
 * candidates — which is the same answer the image would have supplied, without the dependency.
 *
 * Set PRICE_ENGINE_USE_IMAGE=1 to turn it back on once that call is bounded on the Python side.
 */
const SEND_COVER_IMAGE = process.env.PRICE_ENGINE_USE_IMAGE === "1";

/**
 * Condition damage type -> the price engine's own deduction category.
 *
 * Still PARTIAL, and for the same reason as before: the engine values a damage only through a category
 * in its table, and a wrong category is worse than none — it moves real money on a guess. What is
 * mapped here is a synonym of a row that already exists, nothing more.
 *
 * MÄTT, och skälet till att luckorna täpptes till: en NORDVIKEN-stol gav fyra fynd över nitton
 * körningar, varav TVÅ på S2 — `worn_material` på ryggstödet och `abrasion` på fotstödet. Båda saknade
 * kategori, gick som fritext, och kom tillbaka `no_valuation`: noll kronor. Samma stol dagen innan,
 * när inspektionen råkade skriva `scuff` om exakt samma ryggstöd, gav `repa_hard` grad 2 och 6 % i
 * avdrag. Skillnaden i pris låg alltså i vilket ORD modellen valde, inte i möbelns skick — och
 * `abrasion` mot `scuff` är inte två skador, det är två ord för nötning.
 *
 * Kvar utanför med flit: `pilling` och `fraying`. De är textilslitage, och tabellen har ingen rad för
 * det. Varje befintlig rad vore fel — `reva_hal` (14–30 %) tar betalt för ett hål som inte finns, och
 * `nedsutten` betyder tappad FORM, inte nött yta. De ska ha en egen mätt rad i tabellen, inte lånas in
 * i någon annans. `other` står utanför av samma skäl: en catch-all har ingen innebörd att mappa.
 */
const CATEGORY_BY_TYPE: Partial<Record<DamageType, string>> = {
  scratch: "repa_hard",
  scuff: "repa_hard",
  // Nötning är samma yta och samma rad som scuff — "Repa i trä/lack/metall".
  abrasion: "repa_hard",
  worn_material: "repa_hard",
  general_wear: "repa_hard",
  chip: "repa_hard",
  dent: "repa_hard",
  tear: "reva_hal",
  hole: "reva_hal",
  stain: "flack",
  discoloration: "missfargning",
  fading: "missfargning",
  // Rost och korrosion har ingen egen rad. `missfargning` är den närmaste MÄTTA raden och rätt
  // storleksordning för en rostfläck på ett stolsben: kosmetisk, 7 % synlig / 16 % framträdande.
  rust: "missfargning",
  corrosion: "missfargning",
  compressed_upholstery: "nedsutten",
  sagging: "nedsutten",
  // "Nedsutten / tappad form" är precis vad en deformation är.
  deformation: "nedsutten",
  peeling_flaking: "skinnflagning",
  loose_component: "stomskada",
  broken_component: "stomskada",
  crack: "stomskada",
  structural_damage: "stomskada",
  missing_part: "saknad_del",
};

/** Leather scratches are their own table row and cost several times what a scratch in wood does. */
const LEATHER_WORDS = /\b(skinn|läder|lader|leather)/i;

/**
 * S1-S4 -> the engine's 0/1/2 grade. S1 lands on 0, which is below its materiality threshold: the
 * finding is still listed and still lowers the CONDITION grade, it just does not move the price. That
 * is the engine's rule, not ours — "AI:n ser mer än köparen bryr sig om".
 */
const GRADE_BY_SEVERITY: Record<Severity, number> = { S1: 0, S2: 1, S3: 2, S4: 2 };

// NOT_RUN = aldrig granskad, inte underkänd. Fyndet ska värderas som det rapporterades — se
// damageStands, som är samma regel betyget använder.
const isPriceable = damageStands;

function categoryFor(d: Damage): string | undefined {
  const leather = LEATHER_WORDS.test(`${d.part} ${d.description}`);
  // En spricka i skinn är sprucket skinn, inte en skadad stomme. Villkoret sitter på TYPEN och inte
  // på kategorin: `structural_damage` i en skinnsoffas ram är fortfarande en stomskada, och en regel
  // som läste kategorin hade flyttat även den till skinnraden.
  if (d.type === "crack" && leather) return "skinnflagning";
  const category = CATEGORY_BY_TYPE[d.type];
  if (category === "repa_hard" && leather) return "repa_skinn";
  return category;
}

/**
 * Damage list -> the engine's `damages[]`. Two shapes on purpose, both documented by the engine:
 * a pre-mapped entry carries `matchedBy` and is passed through its `normalise` untouched, while an
 * unmapped one is handed over as raw text for its own matcher to interpret.
 */
export function mapDamagesForPricing(damages: Damage[]): Array<Record<string, unknown>> {
  return damages.filter(isPriceable).map((d) => {
    const location = [d.part, d.semanticLocation].filter(Boolean).join(", ") || null;
    const category = categoryFor(d);
    if (category) {
      return {
        category,
        grade: GRADE_BY_SEVERITY[d.severity],
        gradeAssumed: false,
        location,
        description: d.description,
        image: null,
        matchedBy: "condition-system",
      };
    }
    return { description: d.description, severity: GRADE_BY_SEVERITY[d.severity], location };
  });
}

/**
 * Kanonisk nyckel för EXAKT det prismotorn matas med.
 *
 * Ren funktion, för att spekulationen i run.ts måste kunna svara på frågan "blev det någon skillnad?"
 * utan att gissa. Jämförelsen sker på den MAPPADE listan — den prismotorn faktiskt får — och inte på
 * skadeobjekten: två olika `Damage` kan mappa till samma avdragspost (severity S3 och S4 blir båda
 * grad 2), och då är priset detsamma och spekulationen giltig. Objektidentitet hade sagt "ändrat" där
 * ingenting som påverkar priset ändrats.
 *
 * Sorteras, eftersom `mapDamagesForPricing` bevarar inmatningsordningen och verify kan flytta om ett
 * fynd utan att ändra vad som står i det.
 */
export function pricingSignature(damages: Damage[], canonicalCondition: string | null): string {
  const mapped = mapDamagesForPricing(damages)
    .map((entry) => JSON.stringify(entry, Object.keys(entry).sort()))
    .sort();
  return JSON.stringify({ condition: canonicalCondition, damages: mapped });
}

function unavailable(reason: string, startedAt: number): PriceEstimate {
  return {
    status: "unavailable",
    low: null,
    default: null,
    high: null,
    currency: "SEK",
    confidence: null,
    note: null,
    matchCount: 0,
    variant: null,
    variantMethod: null,
    damageDeduction: null,
    damageLines: [],
    unavailableReason: reason,
    requestedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
  };
}

interface PriceEngineResponse {
  low: number | null;
  default: number | null;
  high: number | null;
  confidence: string;
  note: string;
  matchCount: number;
  query?: { variant?: string[] | null };
  variantMethod?: string | null;
  damage?: {
    items?: PriceDamageLine[];
    totalDeduction?: number;
    totalDeductionApplied?: number;
    error?: string;
  } | null;
}

/**
 * Asks the price engine what the furniture is worth GIVEN the findings. It never detects anything —
 * the damage list is ours, the valuation is its.
 *
 * Never throws and never rejects: a price is an addition to the condition report, and an unreachable
 * pricing service must not cost the seller the inspection they already paid a Gemini call for. Every
 * failure comes back as a `PriceEstimate` that says so in plain Swedish.
 */
export async function estimatePrice(
  identity: FurnitureIdentity | null,
  damages: Damage[],
  canonicalCondition: string | null,
  coverImageBase64: string | null,
  /** Avbryter anropet i förtid — används när ett spekulativt pris visar sig vara på fel lista. */
  signal?: AbortSignal,
): Promise<PriceEstimate | null> {
  if (!identity?.model?.trim()) return null;
  const startedAt = Date.now();

  const brand = identity.brand?.trim() || null;
  const model = identity.model.trim();
  const body: Record<string, unknown> = {
    name: model,
    brand,
    // The whole thing the seller typed. The engine builds its cell key from this, not from `name`,
    // and a furniture word that only exists in the brand field would be lost to it otherwise.
    attribute_text: [brand, model].filter(Boolean).join(" "),
    condition: canonicalCondition,
    damages: mapDamagesForPricing(damages),
    // Type classification only, and only when explicitly enabled — see SEND_COVER_IMAGE. The DINOv2
    // re-rank is a much heavier pass again and buys nothing here either way.
    image_base64: SEND_COVER_IMAGE ? coverImageBase64 : null,
    image_rerank: false,
  };

  let res: Response;
  try {
    res = await fetch(`${PRICE_ENGINE_URL}/price`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(PRICE_ENGINE_API_KEY ? { "x-api-key": PRICE_ENGINE_API_KEY } : {}),
      },
      body: JSON.stringify(body),
      // Två skäl att sluta vänta: vår egen tidsgräns, eller att svaret blivit inaktuellt.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PRICE_TIMEOUT_MS)]) : AbortSignal.timeout(PRICE_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError"
        ? `Prismotorn svarade inte inom ${Math.round(PRICE_TIMEOUT_MS / 1000)} s.`
        : err instanceof Error && err.name === "AbortError"
          ? "Prisförfrågan avbröts — skadelistan ändrades."
          : `Prismotorn gick inte att nå på ${PRICE_ENGINE_URL}. Är den igång?`;
    console.warn(`[condition-grading] price engine unreachable — ${reason}`);
    return unavailable(reason, startedAt);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return unavailable(`Prismotorn svarade ${res.status}. ${detail.slice(0, 200)}`.trim(), startedAt);
  }

  let data: PriceEngineResponse;
  try {
    data = (await res.json()) as PriceEngineResponse;
  } catch {
    return unavailable("Prismotorns svar gick inte att tolka.", startedAt);
  }

  const damage = data.damage ?? null;
  // `totalDeductionApplied` is what actually scaled the price; it differs from `totalDeduction` when
  // the engine halved the deduction because its comparison set already carried damaged listings.
  const deduction = damage?.totalDeductionApplied ?? damage?.totalDeduction ?? null;

  return {
    status: data.default === null || data.default === undefined ? "no_data" : "ok",
    low: data.low ?? null,
    default: data.default ?? null,
    high: data.high ?? null,
    currency: "SEK",
    confidence: data.confidence ?? null,
    note: data.note ?? null,
    matchCount: data.matchCount ?? 0,
    variant: data.query?.variant ?? null,
    variantMethod: data.variantMethod ?? null,
    damageDeduction: typeof deduction === "number" ? deduction : null,
    damageLines: damage?.items ?? [],
    unavailableReason:
      data.default === null || data.default === undefined
        ? (data.note ?? "Hittade inga jämförbara annonser.")
        : null,
    requestedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Re-prices a finished job after the seller changed the findings. Called from the same places that
 * re-run `gradeCondition`, so the two halves of the report can never disagree about which damages
 * they were computed from.
 *
 * Keeps the previous estimate when the engine is unreachable: a stale price with a note beats blanking
 * out a number the seller was already looking at.
 */
export async function repriceResult(result: ConditionResult, coverImageBase64: string | null): Promise<void> {
  if (!result.identity) return;
  const fresh = await estimatePrice(
    result.identity,
    result.damages,
    result.grade?.canonicalCondition ?? null,
    coverImageBase64,
  );
  if (!fresh) return;
  if (fresh.status === "unavailable" && result.price && result.price.status === "ok") {
    result.price = { ...result.price, note: `${result.price.note ?? ""} (Priset kunde inte uppdateras: ${fresh.unavailableReason})`.trim() };
    return;
  }
  result.price = fresh;
}

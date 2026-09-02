/**
 * Efterfrågeannonser: utkast till kampanjer, aldrig en publicering.
 *
 * ALDRIG AUTONOMT. Det som genereras här är en SPEC — målgrupp, text, budgettak — som läggs i en
 * kö för en människa att godkänna, ändra eller kasta. Publiceringen ligger bakom en flagga som är
 * AV, och även påslagen kräver den ett godkännande först. Skälet är enkelt: en annons är Loopas ord
 * i offentligheten, och ett system som formulerar och publicerar dem själv kan säga saker vi inte
 * står för till en publik vi inte valt, på en budget som är riktiga pengar.
 *
 * UTKASTEN BYGGER PÅ OMÄTTAD EFTERFRÅGAN. Inte på störst efterfrågan — den mättas ofta av sig själv
 * — utan på det folk väntat på UTAN att vi hittat något. Det är den listan som säger vad vi behöver
 * be någon filma.
 *
 * TEXTEN NÄMNER ALDRIG EN KÖPARE. "En köpare väntar" är sant och anonymt; "Anna på Södermalm väntar"
 * är varken. Se wall.ts för samma gräns på den publika väggen.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";
import { categoryNoun } from "../butik/catalog.js";
import { demandDashboard, type DemandRow } from "./wall.js";

/** Minsta omättade efterfrågan innan ett utkast är värt någons tid att läsa. */
const MIN_UNMET = Number(process.env.DEMAND_ADS_MIN_UNMET ?? 2);
/** Publicering via API. AV, och ska vara det tills någon medvetet slår på den. */
export function publishingEnabled(): boolean {
  return process.env.DEMAND_ADS_PUBLISH === "1";
}

export type AdState = "draft" | "approved" | "rejected" | "published";

export interface DemandAd {
  id: string;
  state: AdState;
  /** Vad utkastet svarar mot. Bär rankningen och är nyckeln mot efterfrågan. */
  categorySlug: string | null;
  brand: string | null;
  priceBand: string | null;
  unmet: number;
  /** Stockholm. Enda målgruppen produkten kan leverera i. */
  audience: string;
  headline: string;
  body: string;
  /** Föreslaget tak i kronor. Ett FÖRSLAG — den som godkänner sätter det riktiga. */
  suggestedBudgetSek: number;
  /**
   * Spårningsparametern som knyter en säljare tillbaka hit.
   *
   * Läggs på länken i annonsen. Utan den går det inte att säga om en kampanj gav några säljare, och
   * en kampanj vars effekt inte går att mäta är en kampanj man inte kan avsluta.
   */
  utm: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Redigerad text, när någon skrivit om utkastet innan godkännandet. */
  editedHeadline: string | null;
  editedBody: string | null;
}

const DIR = () => process.env.EFTERLYSNING_DATA_DIR?.trim() || path.join(DATA_DIR, "efterlysningar");
const FILE = () => path.join(DIR(), "demand-ads.json");

let cache: DemandAd[] | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function load(): Promise<DemandAd[]> {
  if (cache) return cache;
  try { cache = JSON.parse(await readFile(FILE(), "utf-8")) as DemandAd[]; } catch { cache = []; }
  return cache;
}

async function flush(): Promise<void> {
  await mkdir(DIR(), { recursive: true });
  await writeFile(FILE(), JSON.stringify(await load(), null, 2), "utf-8");
}

/**
 * Kampanjnamnet i en URL.
 *
 * Slugifieras med flit. Prisbandet skrivs med `toLocaleString("sv-SE")`, som skiljer tusental med
 * ett HÅRT mellanslag (U+00A0) — det blev `%C2%A0` mitt i utm_campaign, vilket är giltigt men
 * oläsligt i varje rapport parametern någonsin dyker upp i.
 */
function campaignSlug(key: string): string {
  return key
    .toLowerCase()
    .replace(/[|\s\u00a0]+/g, "-")
    .replace(/[^a-z0-9åäö-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "ovrigt";
}

/** Nyckeln som gör ett utkast till samma utkast. Två körningar ska inte fylla kön med dubbletter. */
function keyOf(r: Pick<DemandAd, "categorySlug" | "brand" | "priceBand">): string {
  return `${r.categorySlug ?? ""}|${r.brand ?? ""}|${r.priceBand ?? ""}`;
}

/**
 * Texten. Skriven i kod, inte av en modell.
 *
 * En annons är Loopas ord i offentligheten. En genererad mening kan bli bra nio gånger av tio och
 * pinsam den tionde, och den tionde är den som körs med budget mot en publik som aldrig hört talas
 * om oss. Mallarna nedan är tråkiga och sanna, vilket är rätt ordning på de två.
 */
function copyFor(r: DemandRow): { headline: string; body: string } {
  const noun = categoryNoun(r.categorySlug);
  const vad = [r.brand, noun].filter(Boolean).join(" ");
  const vantar = r.unmet === 1 ? "En köpare väntar" : `${r.unmet} köpare väntar`;
  return {
    headline: `Har du en ${vad}?`,
    body:
      `${vantar} på en sådan i Stockholm. Sälj den på tre minuter: filma ett varv med mobilen, ` +
      `så besiktigar vi den, sätter priset och hämtar hem den. Du behöver inte skriva en annons.`,
  };
}

/**
 * Budgetförslaget.
 *
 * Skalas med omättad efterfrågan, med ett tak. Talet är avsiktligt lågt: det är ett FÖRSLAG till
 * någon som ska sätta ett riktigt, och ett för högt förslag är farligare än ett för lågt eftersom
 * det är det som klickas igenom när kön är lång.
 */
function budgetFor(unmet: number): number {
  return Math.min(2000, 250 * Math.max(1, unmet));
}

/** Genererar utkast ur den omättade efterfrågan. Idempotent: befintliga rör vi inte. */
export async function generateDrafts(): Promise<{ created: number; skipped: number }> {
  const rows = (await demandDashboard()).filter((r) => r.unmet >= MIN_UNMET);
  return serialize(async () => {
    const list = await load();
    // Ett beslutat utkast kommer inte tillbaka: den som kastat en kampanj ska slippa se den igen
    // nästa gång jobbet kör.
    const seen = new Set(list.map((a) => keyOf(a)));
    let created = 0;
    let skipped = 0;

    for (const r of rows) {
      const key = keyOf({ categorySlug: r.categorySlug, brand: r.brand, priceBand: r.priceBand });
      if (seen.has(key)) { skipped += 1; continue; }
      seen.add(key);
      const { headline, body } = copyFor(r);
      list.push({
        id: randomUUID(),
        state: "draft",
        categorySlug: r.categorySlug,
        brand: r.brand,
        priceBand: r.priceBand,
        unmet: r.unmet,
        audience: "Stockholms län",
        headline,
        body,
        suggestedBudgetSek: budgetFor(r.unmet),
        utm: `utm_source=loopa&utm_medium=efterfragan&utm_campaign=${campaignSlug(key)}`,
        createdAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        editedHeadline: null,
        editedBody: null,
      });
      created += 1;
    }
    if (created) await flush();
    return { created, skipped };
  });
}

export async function list(state?: AdState): Promise<DemandAd[]> {
  const all = await load();
  return (state ? all.filter((a) => a.state === state) : all)
    .sort((a, b) => b.unmet - a.unmet || (a.createdAt < b.createdAt ? 1 : -1));
}

export async function decide(
  id: string,
  decision: "approved" | "rejected",
  by: string,
  edits?: { headline?: string; body?: string },
): Promise<DemandAd | null> {
  return serialize(async () => {
    const list = await load();
    const ad = list.find((a) => a.id === id);
    if (!ad) return null;
    // Ett beslut fattas en gång. Att godkänna en kastad kampanj i efterhand är ett annat beslut och
    // ska kräva att någon skapar den på nytt.
    if (ad.state !== "draft") return ad;
    ad.state = decision;
    ad.decidedAt = new Date().toISOString();
    ad.decidedBy = by;
    if (edits?.headline) ad.editedHeadline = edits.headline.slice(0, 120);
    if (edits?.body) ad.editedBody = edits.body.slice(0, 600);
    await flush();
    return ad;
  });
}

/**
 * Exporten: godkända kampanjer som CSV, att klistra in i ett annonsverktyg för hand.
 *
 * DET HÄR ÄR MVP:ns PUBLICERING. Att gå via ett kalkylark låter långsamt, och är det — men varje rad
 * passerar då en människas ögon en gång till innan pengar börjar rulla, och den bromsen är hela
 * poängen så länge texterna är nya.
 */
export function toCsv(ads: DemandAd[]): string {
  const head = "rubrik;text;malgrupp;budget_sek;kategori;marke;prisband;omattade;utm";
  const rows = ads.map((a) =>
    [
      a.editedHeadline ?? a.headline,
      a.editedBody ?? a.body,
      a.audience,
      a.suggestedBudgetSek,
      a.categorySlug ?? "",
      a.brand ?? "",
      a.priceBand ?? "",
      a.unmet,
      a.utm,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(";"),
  );
  return [head, ...rows].join("\n");
}

/**
 * Markerar en godkänd kampanj som publicerad.
 *
 * Kräver att flaggan är på OCH att kampanjen redan är godkänd. Två grindar för samma sak, med flit:
 * flaggan skyddar mot att någon råkar slå på automatiken, godkännandet mot att automatiken kör på
 * något ingen läst.
 */
export async function markPublished(id: string): Promise<DemandAd | null> {
  if (!publishingEnabled()) return null;
  return serialize(async () => {
    const list = await load();
    const ad = list.find((a) => a.id === id);
    if (!ad || ad.state !== "approved") return null;
    ad.state = "published";
    await flush();
    return ad;
  });
}

export function reset(): void { cache = null; }

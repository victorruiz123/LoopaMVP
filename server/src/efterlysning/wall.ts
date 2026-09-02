/**
 * Efterlysningsväggen och efterfrågepanelen: samma data, två läsare.
 *
 * VÄGGEN ÄR PUBLIK och vänder sig till SÄLJARE: "Sökes: String-hylla i valnöt, upp till 4 000 kr –
 * Södermalm. Har du en? Sälj den nu →". Den är produktens billigaste utbudsgenerering — en lista
 * över vad folk faktiskt vill ha, som dessutom är en söksida i sig ("sökes string hylla stockholm").
 *
 * INGEN KÖPARE FÅR GÅ ATT PEKA UT. Tre regler bär det, och de gäller åt båda hållen:
 *
 *   1. Aldrig identitet. Inget namn, ingen e-post, inget id som går att slå upp.
 *   2. Aldrig anteckningen. "Måste gå in genom en smal dörr i Vasastan" beskriver en lägenhet.
 *   3. Grovt område. Stadsdel, inte adress — och bara den stadsdel köparen själv skrivit.
 *
 * PANELEN ÄR ADMIN och läser samma poster men ostädade: den ska styra intag och annonser, och då
 * behövs prisband, ålder och omättad efterfrågan. Skillnaden mellan de två funktionerna nedan är
 * alltså vad som SKALAS BORT, inte var datan kommer ifrån.
 */

import { categoryLabel } from "../butik/catalog.js";
import * as store from "./store.js";
import type { Efterlysning } from "./types.js";
import { nabar } from "./types.js";

/** En rad på den publika väggen. Allt som står här får en främling se. */
export interface WallItem {
  /** Stabil nyckel för listan. Inte efterlysningens id — det är en nyckel in i någons konto. */
  key: string;
  /** "Sökes: String-hylla i valnöt, upp till 4 000 kr" */
  title: string;
  categorySlug: string | null;
  categoryLabel: string | null;
  /** Grovt område, eller null. Aldrig mer exakt än en stadsdel. */
  area: string | null;
  /** Hur länge någon väntat. Dagar, inte datum — ett datum är en nyckel till en person. */
  waitingDays: number;
  /** Hur många som söker samma sak. Aggregerat, så en enskild inte går att peka ut. */
  count: number;
}

/**
 * Ett tal som beskriver ett spann i stället för en persons budget.
 *
 * AVRUNDAS NEDÅT, ALLTID. Den första versionen la 4 000 kr i bandet "upp till 6 000 kr" — vilket
 * överdriver köparens budget för varje säljare som läser väggen, och det är precis den sortens
 * förhandlingsposition väggen finns för att INTE ge bort. En köpare får hellre framstå som snålare
 * än de är; det kostar dem ingenting, medan motsatsen kostar pengar.
 *
 * Stegen är grova nog att en enskild budget inte går att läsa av: 500 kr upp till tretusen, tusen
 * däröver.
 */
function priceBand(max: number | null | undefined): string | null {
  if (!max || max < 500) return null;
  const step = max <= 3000 ? 500 : 1000;
  const floor = Math.floor(max / step) * step;
  return `upp till ${floor.toLocaleString("sv-SE")} kr`;
}

/**
 * Rubriken en säljare läser.
 *
 * Byggs ur specen och inte ur köparens sammanfattning: sammanfattningen kan bära ord köparen skrev
 * själv, och de orden är deras. Här står bara det strukturerade — kategori, märke, material, färg
 * och prisband.
 */
function wallTitle(e: Efterlysning, cap: number | null): string {
  const bits: string[] = [];
  if (e.filter.brands?.length) bits.push(e.filter.brands[0]);
  if (e.filter.categorySlug) bits.push(categoryLabel(e.filter.categorySlug).toLowerCase());
  if (e.filter.materials?.length) bits.push(`i ${e.filter.materials[0]}`);
  else if (e.filter.colors?.length) bits.push(`i ${e.filter.colors[0]}`);
  const band = priceBand(cap);
  const what = bits.join(" ") || "möbel";
  return band ? `Sökes: ${what}, ${band}` : `Sökes: ${what}`;
}

/**
 * Nyckeln som avgör vad som är "samma sak". Bär också anonymiteten: flera köpare blir en rad.
 *
 * PRISET INGÅR INTE I NYCKELN, och det är en rättelse. Med bandet i nyckeln hamnade två köpare av
 * samma gröna soffa på skilda rader — den ena med 5 500 kr och den andra med 6 000 — och två rader
 * med var sin stadsdel pekar ut mer än en rad med två. Gruppen bär i stället det LÄGSTA bandet
 * (se `wall`), vilket varken överdriver någons budget eller splittrar gruppen.
 */
function groupKey(e: Efterlysning): string {
  return [
    e.filter.categorySlug ?? "",
    (e.filter.brands ?? [])[0] ?? "",
    (e.filter.materials ?? [])[0] ?? (e.filter.colors ?? [])[0] ?? "",
  ].join("|");
}

/**
 * Den publika väggen.
 *
 * Grupperar på vad som söks, inte på vem som söker. Två personer som letar samma hylla blir en rad
 * med `count: 2` — vilket både skyddar dem och är ett STARKARE säljargument än två rader.
 */
export async function wall(categorySlug?: string | null): Promise<WallItem[]> {
  const open = (await store.open()).filter(nabar);
  const groups = new Map<string, { rows: Efterlysning[] }>();

  for (const e of open) {
    if (categorySlug && e.filter.categorySlug !== categorySlug) continue;
    const key = groupKey(e);
    const g = groups.get(key) ?? { rows: [] };
    g.rows.push(e);
    groups.set(key, g);
  }

  const now = Date.now();
  return [...groups.entries()]
    .map(([key, g]) => {
      // Äldst i gruppen bär väntetiden: "någon har väntat i tolv dagar" är sant om gruppen.
      const oldest = g.rows.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
      /**
       * Gruppens pris är det LÄGSTA taket i den.
       *
       * Aldrig det högsta och aldrig ett snitt: båda hade överdrivit någons budget för varje säljare
       * som läser. Det lägsta är sant om åtminstone en i gruppen och understiger de andra — vilket
       * är åt det håll ett fel ska luta.
       */
      const lowestCap = g.rows
        .map((r) => r.filter.maxPriceSek)
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => a - b)[0] ?? null;
      const areas = [...new Set(g.rows.map((r) => r.area).filter((a): a is string => !!a))];
      return {
        key,
        title: wallTitle(oldest, lowestCap),
        categorySlug: oldest.filter.categorySlug ?? null,
        categoryLabel: oldest.filter.categorySlug ? categoryLabel(oldest.filter.categorySlug) : null,
        // Ett område bara när gruppen är enig om det. Två stadsdelar blir "Stockholm" — annars
        // pekar raden ut vilken av två personer som bor var.
        area: areas.length === 1 ? areas[0] : areas.length > 1 ? "Stockholm" : null,
        waitingDays: Math.max(0, Math.floor((now - new Date(oldest.createdAt).getTime()) / 86_400_000)),
        count: g.rows.length,
      };
    })
    .sort((a, b) => b.count - a.count || b.waitingDays - a.waitingDays);
}

// ---------------------------------------------------------------------------
// Adminpanelen: samma data, ostädad
// ---------------------------------------------------------------------------

export interface DemandRow {
  categorySlug: string | null;
  categoryLabel: string | null;
  brand: string | null;
  priceBand: string | null;
  count: number;
  /** Medianväntetid i dagar. Styr vad intaget ska prioritera. */
  medianWaitDays: number;
  /** Hur många av dem som ALDRIG fått en träff. Den siffran är rankningen. */
  unmet: number;
}

export async function demandDashboard(): Promise<DemandRow[]> {
  const open = (await store.open()).filter(nabar);
  const matches = await store.allMatches();
  const withMatch = new Set(matches.map((m) => m.efterlysningId));

  /**
   * Grupperas som väggen, och UTAN prisbandet.
   *
   * Samma rättelse som där, och den behövdes här av ett annat skäl: två köpare av samma String-hylla
   * med 4 000 och 4 500 kr i tak hamnade i skilda band och fick `unmet: 1` var — under tröskeln för
   * ett annonsutkast. Efterfrågan fanns, men delades sönder av en indelning som inte handlar om vad
   * folk söker.
   */
  const groups = new Map<string, Efterlysning[]>();
  for (const e of open) {
    const key = [e.filter.categorySlug ?? "", (e.filter.brands ?? [])[0] ?? ""].join("|");
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }

  const now = Date.now();
  return [...groups.values()]
    .map((rows) => {
      const waits = rows
        .map((r) => Math.floor((now - new Date(r.createdAt).getTime()) / 86_400_000))
        .sort((a, b) => a - b);
      const first = rows[0];
      return {
        categorySlug: first.filter.categorySlug ?? null,
        categoryLabel: first.filter.categorySlug ? categoryLabel(first.filter.categorySlug) : null,
        brand: (first.filter.brands ?? [])[0] ?? null,
        // Gruppens lägsta tak, av samma skäl som på väggen: överdriv aldrig någons budget.
        priceBand: priceBand(
          rows.map((r) => r.filter.maxPriceSek).filter((v): v is number => typeof v === "number").sort((a, b) => a - b)[0] ?? null,
        ),
        count: rows.length,
        medianWaitDays: waits[Math.floor(waits.length / 2)] ?? 0,
        // Omättad efterfrågan: de som väntat utan att vi hittat något alls. Det är den listan som
        // ska styra vad vi ber folk filma.
        unmet: rows.filter((r) => !withMatch.has(r.id)).length,
      };
    })
    .sort((a, b) => b.unmet - a.unmet || b.count - a.count);
}

/** CSV, för den som vill räkna vidare i ett kalkylark. Ingen köparidentitet, av samma skäl som väggen. */
export function toCsv(rows: DemandRow[]): string {
  const head = "kategori;marke;prisband;antal;median_vantetid_dagar;omattade";
  const body = rows.map((r) =>
    [r.categoryLabel ?? "", r.brand ?? "", r.priceBand ?? "", r.count, r.medianWaitDays, r.unmet]
      .map((v) => String(v).replace(/;/g, ","))
      .join(";"),
  );
  return [head, ...body].join("\n");
}

/**
 * Säljarkroken: hur många som efterlyst en möbel som den här.
 *
 * BARA ETT ANTAL. Säljaren får veta att det finns efterfrågan, aldrig vem eller exakt vad — en
 * säljare som ser "någon i Vasastan söker en grön sammetssoffa max 6 000" vet både var köparen bor
 * och vad de har råd med, och det är en förhandlingsposition vi gett bort gratis.
 */
export async function demandCountFor(signals: {
  categorySlug: string | null;
  brand: string | null;
  priceSek: number | null;
}): Promise<number> {
  const open = (await store.open()).filter(nabar);
  return open.filter((e) => {
    if (e.filter.categorySlug && e.filter.categorySlug !== signals.categorySlug) return false;
    if (e.filter.brands?.length) {
      const want = e.filter.brands.map((b) => b.toLowerCase());
      if (!signals.brand || !want.includes(signals.brand.toLowerCase())) return false;
    }
    // Priset räknas bara när säljaren har ett: en möbel utan pris kan inte falla på ett pristak.
    if (signals.priceSek !== null && e.filter.maxPriceSek && signals.priceSek > e.filter.maxPriceSek) return false;
    return true;
  }).length;
}

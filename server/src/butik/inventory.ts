/**
 * Lagret som butiken läser: jobben projicerade till varor, filtrerade och sorterade.
 *
 * VARFÖR ETT INDEX. `listJobs()` läser 193 filer från disk, och `jobByLoopaId` gör om det för varje
 * uppslag (publicCard.ts:163). Det bär ett kort i taget men inte ett rutnät som filtrerar, sorterar
 * och paginerar vid varje sidladdning. Varorna byggs därför en gång och hålls i minnet, med en TTL
 * som gör att en nypublicerad möbel dyker upp av sig själv och en `invalidate()` för de ställen som
 * vet att något ändrats.
 *
 * Indexet är HÄRLETT och får kastas när som helst: sanningen om innehållet står i jobben, sanningen
 * om tillståndet i butikslagret. Ingenting bor bara här.
 */

import { listJobs } from "../jobStore.js";
import { loopaIdFor } from "../loopaId.js";
import { jobToProduct } from "./normalize.js";
import { shopReadiness } from "./state.js";
import { ensureRecord, publish, store, unpublish, type ButikRecord } from "./store.js";
import { alla as allaOverstyrningar, tillampaPaProdukt } from "./overrides.js";
import { fold } from "./catalog.js";
import { notify, takePendingNotifications } from "./bevakningar.js";
import { BROWSABLE_STATES, type BrowseResult, type Product, type ProductFilter, type SortKey } from "./types.js";
import { rankScore } from "./rank.js";

/** Hur länge indexet får vara gammalt. Kort — en säljare som publicerar ska se sin möbel i butiken. */
const INDEX_TTL_MS = Number(process.env.BUTIK_INDEX_TTL_MS ?? 30_000);

let cache: { at: number; products: Product[] } | null = null;
let building: Promise<Product[]> | null = null;

export function invalidate(): void {
  cache = null;
}

/**
 * Jobben som butiksvaror, med tillståndet påsatt ur butikslagret.
 *
 * Jobb som inte klarar `shopReadiness` faller bort helt — de får inget tillstånd, syns inte i
 * rutnätet och räknas inte i lagret. Mätt: 67 av 172 besiktigade jobb har ingen annons alls.
 */
async function build(): Promise<Product[]> {
  const jobs = await listJobs();
  const records = new Map((await store().all()).map((r) => [r.id, r]));
  /**
   * Adminens rättelser läggs på sist, och hämtas EN gång för hela bygget.
   *
   * Ordningen är hela poängen: normalize.ts härleder ur besiktningen, och det en människa
   * uttryckligen skrivit går före. Se butik/overrides.ts för varför de inte bor i jobbet.
   */
  const overstyrningar = await allaOverstyrningar();
  const products: Product[] = [];

  for (const job of jobs) {
    const loopaId = loopaIdFor(job.id);
    const record: ButikRecord | undefined = records.get(loopaId);
    const harlett = jobToProduct(job, record?.state ?? "draft");
    if (!harlett) continue;
    const product = tillampaPaProdukt(harlett, overstyrningar.get(loopaId));
    if (!shopReadiness(product).ready) continue;
    products.push(product);
  }
  return products;
}

export async function allProducts(): Promise<Product[]> {
  if (cache && Date.now() - cache.at < INDEX_TTL_MS) return cache.products;
  // En byggnad i taget: tio samtidiga sidladdningar ska inte läsa 193 filer tio gånger.
  building ??= build().finally(() => { building = null; });
  const products = await building;
  cache = { at: Date.now(), products };
  return products;
}

/**
 * Ger varje butiksfärdigt jobb en post i butikslagret.
 *
 * Utkast som förval: att bli besiktigad är inte att bli publicerad, och en säljares möbel ska inte
 * dyka upp till försäljning för att den passerat en pipeline. UNDANTAGET är möbler som redan ligger
 * uppe på Tradera — där HAR säljaren tryckt på publicera, och butiken är samma beslut i en annan
 * kanal. Utan det undantaget hade butiken startat tom trots ett lager på 105 varor.
 */
export async function syncFromJobs(): Promise<{ enrolled: number; published: number; withdrawn: number; held: number }> {
  const jobs = await listJobs();
  const records = new Map((await store().all()).map((r) => [r.id, r]));
  // Samma rättelser som bygget ovan: en möbel som blivit butiksfärdig FÖR att en admin fyllde i
  // kategorin ska också skrivas in i lagret, inte bara visas i rutnätet.
  const overstyrningar = await allaOverstyrningar();
  let enrolled = 0;
  let published = 0;
  let withdrawn = 0;

  /**
   * Varor som slutat vara beskrivbara tas ur butiken igen.
   *
   * Underlaget under en publicerad vara kan ändras: säljaren rättar en skada, betyget räknas om, en
   * tolkningsbugg lagas. LP-M17J-9QQX är fallet som visade det — barstolen låg live med "62 cm" läst
   * ur ett värde som egentligen sade bänkhöjd, och när tolkningen lagades hade den varken mått eller
   * bild kvar. Posten stod då `live` medan rutnätet inte kunde visa den: huvudboken påstod något
   * butiken inte gjorde.
   *
   * Sålda, reserverade och levererade rörs INTE. Deras tillstånd handlar om en affär som redan
   * pågår, och den upphör inte för att beskrivningen blev sämre.
   */
  const ready = new Set<string>();
  /** Möbler som hölls tillbaka av en förtur i det här varvet. Släpps av sig själva när den går ut. */
  let held = 0;

  for (const job of jobs) {
    const harlett = jobToProduct(job, "draft");
    const product = harlett && tillampaPaProdukt(harlett, overstyrningar.get(harlett.id));
    if (!product || !shopReadiness(product).ready) continue;
    ready.add(product.id);
    const loopaId = product.id;
    if (!records.has(loopaId)) {
      await ensureRecord(loopaId, job.id, "loopa", product.listedAt);
      enrolled += 1;
    }
    const current = records.get(loopaId) ?? (await store().get(loopaId));
    if (job.tradera?.status === "published" && current?.state === "draft") {
      /**
       * Förturen grindar publiceringen — men kan aldrig stoppa den.
       *
       * En köpare som efterlyst just den här möbeln får ett dygn på sig innan den går ut publikt.
       * Grinden ligger HÄR och inte i tillståndsmaskinen: möbeln står kvar som `draft` hela tiden,
       * och förturen är en post vid sidan om som slutar gälla av sig själv när klockan går ut. Se
       * efterlysning/fortur.ts för varför.
       *
       * Faller uppslagningen publicerar vi. En missad artighet är ett mindre fel än en möbel som
       * aldrig kommer ut.
       */
      const { publishBlocked } = await import("../efterlysning/fortur.js");
      if (await publishBlocked(loopaId)) {
        held += 1;
        continue;
      }
      await publish(loopaId, { kind: "seller", userId: job.ownerId ?? null });
      published += 1;
    }
  }
  for (const record of records.values()) {
    if (record.source !== "loopa" || record.state !== "live") continue;
    if (ready.has(record.id)) continue;
    const done = await unpublish(record.id, { kind: "system", job: "syncFromJobs" });
    if (done) {
      withdrawn += 1;
      console.warn(`[butik] ${record.id} togs ur butiken — underlaget räcker inte längre för en annons.`);
    }
  }

  if (enrolled || published || withdrawn) invalidate();

  /**
   * Nypublicerade möbler prövas mot bevakningarna.
   *
   * Här och inte i `publish()`: matchningen behöver den FÄRDIGA varan — kategori, pris och mått —
   * och den finns först när jobbet normaliserats. Ett anrop i tillståndsmaskinen hade fått pröva ett
   * id mot ett filter som handlar om bredd.
   */
  if (published) {
    try {
      const live = (await allProducts()).filter((p) => p.state === "live");
      const pending = await takePendingNotifications(live);
      if (pending.length) await notify(pending);
    } catch (err) {
      // En bevakning som inte gick att skicka får aldrig stoppa en publicering.
      console.warn("[bevakning] matchningen föll:", err instanceof Error ? err.message : err);
    }
  }

  return { enrolled, published, withdrawn, held };
}

// ---------------------------------------------------------------------------
// Sökning, filter och sortering
// ---------------------------------------------------------------------------

/** Fälten fritextsökningen tittar i. Titel, märke, modell, kategori, färg, material. */
function haystack(p: Product): string {
  return fold([p.title, p.brand, p.model, p.categorySlug, p.color, p.material].filter(Boolean).join(" "));
}

/**
 * Hur väl varan svarar mot söktexten. 0 = ingen träff alls och varan faller bort.
 *
 * Ett ord som står i märket eller modellen väger tyngre än samma ord i materialet: den som skriver
 * "ek" menar oftast träslaget, men den som skriver "Ektorp" menar soffan.
 */
function score(p: Product, terms: string[]): number {
  if (terms.length === 0) return 1;
  const hay = haystack(p);
  const strong = fold([p.title, p.brand, p.model].filter(Boolean).join(" "));
  let total = 0;
  for (const term of terms) {
    if (!hay.includes(term)) return 0; // varje ord måste finnas någonstans
    total += strong.includes(term) ? 3 : 1;
  }
  return total;
}

function withinDimension(actual: number | null, max: number | null | undefined): "pass" | "fail" | "unknown" {
  if (max === null || max === undefined) return "pass";
  if (actual === null) return "unknown";
  return actual <= max ? "pass" : "fail";
}

function sorted(items: Product[], sort: SortKey, scores: Map<string, number>, rang: Map<string, number>): Product[] {
  /**
   * Nyast först — men det som har ett KÄNT datum före det som inte har det.
   *
   * Utan den första raden vinner Tradera alltid: deras `listedAt` är en sluttid i framtiden, och en
   * auktion som slutar om en vecka hade då räknats som nyare än en möbel vi lade upp i morse.
   */
  const byNewest = (a: Product, b: Product) => {
    if (a.listedAtKnown !== b.listedAtKnown) return a.listedAtKnown ? -1 : 1;
    return a.listedAt < b.listedAt ? 1 : -1;
  };
  switch (sort) {
    case "nyinkommet":
      return [...items].sort(byNewest);
    case "pris_upp":
      return [...items].sort((a, b) => (a.priceSek ?? Infinity) - (b.priceSek ?? Infinity));
    case "pris_ner":
      return [...items].sort((a, b) => (b.priceSek ?? -Infinity) - (a.priceSek ?? -Infinity));
    case "relevans":
    default:
      /**
       * Loopa först, alltid — även utan filtret "Endast Loopa-granskade".
       *
       * Det är butikens löfte gjort till en sorteringsregel: det vi själva granskat, kan leverera och
       * ta tillbaka står före det vi bara länkar vidare till. Filtret finns för den som vill stänga
       * ute Tradera helt; sorteringen finns för alla andra.
       */
      return [...items].sort((a, b) => {
        if (a.source !== b.source) return a.source === "loopa" ? -1 : 1;
        /**
         * TEXTTRÄFFEN FÖRST, rangordningen sedan.
         *
         * Ordningen mellan de två är inte en avvägning utan en nödvändighet. Söker någon på "HAY"
         * ska HAY-möbler komma först, även om en billigare IKEA-soffa har högre fyndpoäng — annars
         * svarar sökrutan på en annan fråga än den som ställdes. Utan sökord är `score` 1 för
         * allihop (se score()), raden nedan blir noll, och rangordningen tar över hela sorteringen
         * av sig själv.
         */
        const d = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
        if (d !== 0) return d;
        const r = (rang.get(b.id) ?? 0) - (rang.get(a.id) ?? 0);
        return r !== 0 ? r : byNewest(a, b);
      });
  }
}

/** Filtrerar, sorterar och paginerar. Tar varorna som argument så Tradera kan blandas in av browse.ts. */
export function applyFilter(source: Product[], filter: ProductFilter): BrowseResult {
  const terms = filter.q ? fold(filter.q).split(" ").filter(Boolean) : [];
  const scores = new Map<string, number>();
  let excludedForMissingDimensions = 0;
  let excludedForMissingData = 0;

  const matched = source.filter((p) => {
    if (!BROWSABLE_STATES.includes(p.state)) return false;
    if (filter.onlyLoopa && p.source !== "loopa") return false;
    if (filter.categorySlug && p.categorySlug !== filter.categorySlug) return false;
    if (filter.brands?.length && !filter.brands.some((b) => fold(b) === fold(p.brand ?? ""))) return false;
    if (filter.homeDeliveryOnly && !p.homeDeliveryAvailable) return false;
    if (filter.minPriceSek != null && (p.priceSek ?? 0) < filter.minPriceSek) return false;
    if (filter.maxPriceSek != null && (p.priceSek ?? Infinity) > filter.maxPriceSek) return false;
    /**
     * Färg och material matchas som DELSTRÄNG, inte som likhet.
     *
     * Fälten är fritext ur annonsgeneratorn, och i korpusen heter samma material "Massivt trä",
     * "Massivträ", "Massiv bok" och "Trä". Med likhet gav en sökning på "trä" exakt en träff — den
     * enda vara vars fält råkade stå precis så — och rutnätet såg tomt ut fast lagret var fullt.
     *
     * KVAR ATT LÖSA: "furu" och "bok" ÄR trä, men det står inte i strängen, så de matchar inte
     * "trä". Det kräver en materialtaxonomi och inte en strängjämförelse; tills den finns är det
     * här den ärliga halvan — vi hittar det som säger sig vara trä, inte allt som är det.
     */
    /**
     * Saknat värde räknas, precis som saknade mått.
     *
     * Traderas sökresultat bär varken färg eller material, så ett filter på något av dem utesluter
     * hela deras utbud — tyst. "matbord i ek" gav noll träffar fast butiken hade tolv bord, för alla
     * tolv var Tradera-annonser utan materialfält. Ett tomt rutnät utan förklaring läser som ett tomt
     * lager, och det är en annan sak.
     */
    if (filter.colors?.length) {
      if (p.color === null) { excludedForMissingData += 1; return false; }
      if (!filter.colors.some((c) => fold(p.color!).includes(fold(c)))) return false;
    }
    if (filter.materials?.length) {
      if (p.material === null) { excludedForMissingData += 1; return false; }
      if (!filter.materials.some((m) => fold(p.material!).includes(fold(m)))) return false;
    }

    /**
     * Skickfiltret gäller bara det vi granskat.
     *
     * En Tradera-vara har inget betyg, och att låta den passera ett betygsfilter vore att påstå ett
     * skick vi inte kontrollerat. Den faller därför bort så fort filtret är satt — vilket också är
     * vad "ej granskad" på kortet betyder.
     */
    if (filter.grades?.length) {
      if (!p.condition) return false;
      if (!filter.grades.includes(p.condition.grade)) return false;
    }

    // Måttfiltret: "Får den plats?". En vara utan mått kan inte svara, och ska räknas och redovisas
    // i stället för att tyst försvinna — de flesta Tradera-annonser saknar mått helt.
    const dims = [
      withinDimension(p.dimensions.widthMm, filter.maxWidthMm),
      withinDimension(p.dimensions.depthMm, filter.maxDepthMm),
      withinDimension(p.dimensions.heightMm, filter.maxHeightMm),
    ];
    if (dims.includes("fail")) return false;
    if (dims.includes("unknown")) {
      excludedForMissingDimensions += 1;
      excludedForMissingData += 1;
      return false;
    }

    const s = score(p, terms);
    if (s === 0) return false;
    scores.set(p.id, s);
    return true;
  });

  const limit = Math.min(Math.max(filter.limit ?? 24, 1), 96);
  const offset = Math.max(filter.offset ?? 0, 0);
  /**
   * Rangpoängen räknas EN GÅNG per vara, inte inne i jämförelsefunktionen.
   *
   * Två skäl, och det andra är en riktig bugg och inte en optimering: `alderspoang` läser klockan,
   * och anropas den inuti komparatorn kan två jämförelser i samma sortering se olika tidpunkter.
   * Sorteringen blir då icke-transitiv — a > b, b > c, c > a — och utfallet är en ordning som byter
   * sig själv mellan två anrop utan att något ändrats. Ett `nu` för hela svepet kan inte göra det.
   */
  const nu = new Date();
  const rang = new Map(matched.map((p) => [p.id, rankScore(p, null, nu)]));
  const ordered = sorted(matched, filter.sort ?? "relevans", scores, rang);

  return {
    items: ordered.slice(offset, offset + limit),
    total: ordered.length,
    offset,
    limit,
    traderaDegraded: false,
    excludedForMissingDimensions,
    excludedForMissingData,
  };
}

/** En enskild vara, oavsett tillstånd — PDP:n måste kunna visa en såld möbel som såld. */
export async function productById(id: string): Promise<Product | null> {
  return (await allProducts()).find((p) => p.id === id) ?? null;
}

/** Märkena som faktiskt finns i lagret, med antal. Driver märkesfiltret och /butik/marke. */
export async function brandFacets(): Promise<Array<{ brand: string; count: number }>> {
  const counts = new Map<string, number>();
  for (const p of await allProducts()) {
    if (!p.brand || !BROWSABLE_STATES.includes(p.state)) continue;
    counts.set(p.brand, (counts.get(p.brand) ?? 0) + 1);
  }
  return [...counts].map(([brand, count]) => ({ brand, count })).sort((a, b) => b.count - a.count);
}

/**
 * Märkena i ett sammanslaget lager, med antalet DELAT per källa.
 *
 * Brickan på köpsidan säger "41 granskade · 33 via Tradera" och inte "74", och skillnaden är ett
 * löfte: en granskad möbel går att köpa i dag med hemleverans, en Tradera-annons är någon annans som
 * vi kan analysera. Ett sammanslaget tal hade lånat vår granskning till annonser vi inte granskat.
 *
 * Ligger här och inte i routes.ts för att talen ÄR ett löfte om vad märkessidan innehåller, och ett
 * löfte som bara finns i en HTTP-hanterare går inte att pröva.
 */
export interface MarkeFacet {
  brand: string;
  count: number;
  loopa: number;
  tradera: number;
  slug: string;
}

export function brandFacetsMerged(items: Product[]): MarkeFacet[] {
  const counts = new Map<string, { loopa: number; tradera: number }>();
  for (const p of items) {
    // Samma tillståndsregel som rutnätet: en bricka får bara räkna det man faktiskt kan gå till.
    if (!p.brand || !BROWSABLE_STATES.includes(p.state)) continue;
    const rad = counts.get(p.brand) ?? { loopa: 0, tradera: 0 };
    if (p.source === "loopa") rad.loopa += 1;
    else rad.tradera += 1;
    counts.set(p.brand, rad);
  }
  return [...counts]
    .map(([brand, n]) => ({
      brand,
      count: n.loopa + n.tradera,
      loopa: n.loopa,
      tradera: n.tradera,
      slug: brand.toLowerCase().replace(/\s+/g, "-"),
    }))
    // Våra egna först inom samma storleksordning: en bricka med granskade möbler bakom sig är en
    // bättre bricka att trycka på.
    .sort((a, b) => b.count - a.count || b.loopa - a.loopa || a.brand.localeCompare(b.brand, "sv"));
}

/**
 * Antal per kategori, för kategoribrickorna på landningssidan.
 *
 * Räknar BÅDA källorna. Räknades bara våra egna stod "Inget just nu" på Bord och Förvaring medan
 * rutnätet bakom brickan hade tolv annonser — en bricka som säger att hyllan är tom och sedan inte
 * är det är värre än ingen siffra alls.
 */
export function categoryFacetsOf(items: Product[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of items) {
    if (!BROWSABLE_STATES.includes(p.state)) continue;
    counts[p.categorySlug] = (counts[p.categorySlug] ?? 0) + 1;
  }
  return counts;
}

/**
 * Från besiktigat jobb till butiksvara.
 *
 * Allt det här steget gör är att svara på frågor rutnätet ställer och som jobbet inte har ett fält
 * för: vilken kategori, hur brett, vilken färg, vilket pris. Svaren finns i underlaget, men de ligger
 * i `ListingAttribute[]` — fritext med nyckel, etikett och värde, skrivna av en språkmodell. Mätt på
 * de 109 skarpa annonser som har attribut stavas samma mått `width`, `bredd`, `w` och `dimensions`,
 * färgen `color` och `farg`, och sitthöjden på fyra sätt. Det är den soppan som kokas ner här.
 *
 * SYSKONET: web/src/lib/furnitureModel.ts har en parseDimensions som läser samma attribut med samma
 * etikettregler — först skrivet vinner, sitthöjd är inte höjd, bord mäts längd × bredd. Reglerna ÄR
 * desamma och ska ändras på båda ställena. Kontrakten är däremot olika, och det är därför det finns
 * två: den ritar en möbel och MÅSTE ha tre tal, så den fyller i ur TYPICAL när underlaget tiger. Den
 * här får inte det. Ett gissat djup som filtreras mot köparens dörrmått är ett löfte vi inte kan
 * hålla — "Får den plats?" måste kunna svara "vi vet inte" i stället för att svara fel.
 */

import type { ConditionJob, ConditionResult, GeneratedListing, ListingAttribute } from "../types.js";
import { damageStands } from "../pipeline/grade.js";
import { loopaIdFor } from "../loopaId.js";
import { cutoutOf, harPubliktKort } from "../publicCard.js";
import { brandSlug, fold, resolveCategorySlug } from "./catalog.js";
import type { Dimensions, Product, ProductCondition, ProductState } from "./types.js";
import { harGodkantOmslag } from "../pipeline/bild/omslag.js";

/**
 * "81 cm", "ca 80 cm" — talet, med svenskt decimalkomma.
 *
 * Gränserna i båda ändar (`(?<!\d)` och `(?!\d)`) är inte kosmetik: utan dem plockar `\d{1,3}` ut
 * "201" ur årtalet "2019" och måttet blir 2010 mm. Ett artikelnummer eller ett årtal ska ge NOLL
 * mått, inte ett trovärdigt.
 */
const NUMBER = /(?<!\d)(\d{1,3})(?:[,.](\d))?(?!\d)\s*(cm|mm|m\b)?/i;

/** "198 × 99 × 83 cm", "B 198 x D 99 x H 83". */
const TRIPLE = /(\d{2,3})\s*(?:cm)?\s*[x×*]\s*(\d{2,3})\s*(?:cm)?\s*[x×*]\s*(\d{2,3})/i;

/** "Bredd 52 cm, djup 50 cm, höjd 80 cm" — det sammansatta måttfältet, uppdelat på etikett. */
const LABELLED = /(bredd|djup|h[öo]jd|l[äa]ngd|sitth[öo]jd)\s*:?\s*(\d{1,3})(?:[,.](\d))?\s*(?:cm)?/gi;

/** Millimeter ur ett fritextvärde. Null när det inte står något tal som är ett rimligt möbelmått. */
function toMm(value: string): number | null {
  const m = NUMBER.exec(value);
  if (!m) return null;
  const n = Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0);
  if (!(n > 0)) return null;
  const unit = m[3]?.toLowerCase();
  const mm = unit === "mm" ? n : unit === "m" ? n * 1000 : n * 10;
  // Möbler under 5 cm och över 4 m finns inte. Talet var något annat — ett artikelnummer, ett årtal.
  return mm >= 50 && mm <= 4000 ? Math.round(mm) : null;
}

/** Etiketter som handlar om en DEL av möbeln och aldrig om möbeln. Samma lista som furnitureModel. */
const PART_LABEL = /sitth|sitsh|sittd|sitsd|seat|arm|rygg|back|fotring|ben\b|leg/i;

/**
 * Samma sak, fast skrivet i VÄRDET i stället för i etiketten.
 *
 * Generatorn kvalificerar måttet inom parentes när etiketten inte räcker: NORDVIKEN barstol kom in
 * som `height = "62 cm (bänkhöjd)"`. Nyckeln säger höjd, värdet säger bänkhöjd, och bara den ena av
 * dem är sann om möbeln. Läses den rakt av blir barstolen 62 cm hög — och "Får den plats?" svarar
 * med en siffra som är en halv stol fel.
 */
const PART_VALUE = /b[äa]nkh[öo]jd|barh[öo]jd|sitth[öo]jd|sitsh[öo]jd|sittdjup|rygghöjd|armh[öo]jd/i;

/**
 * Värden som räknar upp ALTERNATIV i stället för att mäta den här möbeln.
 *
 * NORDVIKEN finns både som matbord och som barstol, och generatorn skördade bordets spec till
 * stolens annons: `bredd = "210 cm (eller 152 cm / 74 cm beroende på storlek)"`. Läst rakt av blev
 * barstolen 210 cm bred och hamnade i rutnätet med ett bords mått.
 *
 * Ett mått med ett "eller" i är inte ett mått på ett exemplar — det är en produktserie. Butiken
 * filtrerar på "får den plats?", och där är ett tomt fält ärligt medan ett av tre möjliga tal är en
 * gissning som ser ut som en uppgift.
 */
const AMBIGUOUS_VALUE = /\beller\b|beroende p[åa]|\bvarianter?\b/i;

/** Fler än ett cm-tal i ett enskilt måttfält betyder samma sak: det är inte ETT mått. */
function enumeratesAlternatives(value: string): boolean {
  if (AMBIGUOUS_VALUE.test(value)) return true;
  return (value.match(/\d+\s*(?:cm|mm)\b/gi) ?? []).length > 1;
}

/**
 * Måtten, i millimeter, med noll gissningar.
 *
 * `estimated` sätts när minst ett av måtten kom från ett attribut generatorn själv flaggat som
 * uppskattat (`estimated` på ListingAttribute — se types.ts). Det talet står kvar och används, men
 * kortet och måttfiltret ska kunna säga att det är ett typiskt mått och inte ett uppmätt.
 */
export function parseDimensionsMm(attributes: ListingAttribute[], categorySlug: string): Dimensions {
  let width: number | null = null;
  let depth: number | null = null;
  let height: number | null = null;
  let length: number | null = null;
  let seatHeight: number | null = null;
  let estimated = false;

  const note = (a: ListingAttribute, hit: number | null) => {
    if (hit !== null && a.estimated) estimated = true;
    return hit;
  };

  // Sitthöjden först och för sig: den matchar "höjd" och skulle annars skriva över möbelns höjd.
  for (const a of attributes) {
    const label = `${a.key} ${a.label}`.toLowerCase();
    if (/sitth[öo]jd|sitsh[öo]jd|seat.?height/.test(label)) seatHeight ??= toMm(a.value);
  }

  // Först skrivet vinner. Listan börjar med det generatorn belagt mot en källa och slutar med det
  // sidskörden fyllt på, så ett senare värde är ett SÄMRE värde — aldrig ett nyare.
  for (const a of attributes) {
    const label = `${a.key} ${a.label}`.toLowerCase();
    if (PART_LABEL.test(label) || PART_VALUE.test(a.value) || enumeratesAlternatives(a.value)) continue;
    if (/bredd|width|\bw\b/.test(label)) width ??= note(a, toMm(a.value));
    else if (/djup|depth|\bd\b/.test(label)) depth ??= note(a, toMm(a.value));
    else if (/h[öo]jd|height|\bh\b/.test(label)) height ??= note(a, toMm(a.value));
    else if (/l[äa]ngd|length/.test(label)) length ??= note(a, toMm(a.value));
  }

  // Det sammansatta fältet fyller bara luckor: "Mått: Bredd 52 cm, djup 50 cm, höjd 80 cm".
  for (const a of attributes) {
    const label = `${a.key} ${a.label}`.toLowerCase();
    if (!/m[åa]tt|dimension|size|storlek/.test(label)) continue;
    for (const m of a.value.matchAll(LABELLED)) {
      const mm = toMm(`${m[2]}${m[3] ? "," + m[3] : ""} cm`);
      const which = fold(m[1]);
      if (which === "bredd") width ??= note(a, mm);
      else if (which === "djup") depth ??= note(a, mm);
      else if (which === "hojd") height ??= note(a, mm);
      else if (which === "langd") length ??= note(a, mm);
      else if (which === "sitthojd") seatHeight ??= mm;
    }
    const t = TRIPLE.exec(a.value);
    if (t) {
      width ??= note(a, toMm(`${t[1]} cm`));
      depth ??= note(a, toMm(`${t[2]} cm`));
      height ??= note(a, toMm(`${t[3]} cm`));
    }
  }

  /**
   * Bord och sängar mäts längd × bredd; allt annat bredd × djup.
   *
   * IKEA skriver ett matbord som "Längd 210 cm | Bredd 105 cm | Höjd 75 cm" — där ÄR bredden det
   * korta måttet, alltså djupet framifrån sett. Läses etiketterna rakt av blir ett 210 × 105-bord
   * ett 105-brett bord med okänt djup. Bara när djupet saknas, och bara när längden är den längre av
   * de två: är den kortare är etiketterna inte de vi tror. Samma regel som furnitureModel.ts:164.
   */
  const lengthwise = categorySlug === "bord" || categorySlug === "sangar" || categorySlug === "skrivbord-kontor";
  if (lengthwise && depth === null && length !== null && width !== null && length >= width) {
    depth = width;
    width = length;
  }
  // Längden är bredden bara när ingen bredd står någonstans. En soffa mäts på längden, men en stol
  // med både "Bredd 40" och "Längd 90" är 40 bred — de 90 är kartongen den kom i.
  width ??= length;

  return { widthMm: width, depthMm: depth, heightMm: height, seatHeightMm: seatHeight, estimated };
}

/** Nycklar som bär färgen, på de stavningar korpusen faktiskt använder. */
const COLOR_KEY = /^(color|colour|farg|färg)$/i;
/** Nycklar som bär materialet. `stomme`, `kladsel` och `upholstery` är material på svenska annonser. */
const MATERIAL_KEY = /(material|stomme|kladsel|klädsel|upholstery|tyg|fabric)/i;

function attr(attributes: ListingAttribute[], test: RegExp): string | null {
  for (const a of attributes) {
    if (test.test(a.key) || test.test(a.label)) {
      const v = a.value.trim();
      if (v) return v;
    }
  }
  return null;
}

/** Färgen, kapad till det ord en filterknapp kan bära. "Ljusa/beige ton" -> "Ljusa". */
export function normalizeColor(raw: string | null): string | null {
  if (!raw) return null;
  const first = raw.split(/[\/,;()]| och | eller /i)[0]?.trim();
  if (!first || first.length > 24) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/** Materialet, kapat på samma sätt. "Massivträ med akrylfärg, klädsel i 100% polyester" -> "Massivträ". */
export function normalizeMaterial(raw: string | null): string | null {
  if (!raw) return null;
  const first = raw.split(/[\/,;()]| med | och /i)[0]?.trim();
  if (!first || first.length > 28) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/** Skicket som butiken visar det. Null när jobbet inte har ett betyg — då är det inte en butiksvara. */
export function conditionOf(result: ConditionResult): ProductCondition | null {
  if (!result.grade) return null;
  return {
    grade: result.grade.grade,
    canonical: result.grade.canonicalCondition,
    label: result.grade.label,
    rationale: result.grade.rationale,
    // Samma filter som kortet och betyget använder — en avvisad skada räknas inte här heller.
    defectCount: result.damages.filter((d) => damageStands(d)).length,
    inspectedAt: result.createdAt,
    reviewed: result.reviewed,
  };
}

/**
 * Priset butiken visar.
 *
 * Prisstegen går FÖRE prismotorns förslag när den finns: stegen är säljarens eget val av startpris
 * och golv, och `currentPrice` är det som faktiskt ligger uppe just nu (se types.ts:449). Att visa
 * motorns `default` bredvid en annons som redan sänkts två gånger hade varit två priser på samma
 * möbel.
 *
 * Det betyder att "fast pris" i butiken är fast i ÖGONBLICKET, inte för evigt: stegen fortsätter
 * sänka veckovis. Priset i kassan är det som lästes när reservationen gjordes.
 */
export function priceOf(job: ConditionJob): number | null {
  if (job.priceLadder) return Math.round(job.priceLadder.currentPrice);
  const p = job.result?.price;
  if (p?.status === "ok" && p.default !== null) return Math.round(p.default);
  return null;
}

/**
 * Prismotorns uppskattning av vad möbeln är värd begagnad.
 *
 * `status === "ok"` krävs. `no_data` betyder att motorn körde och inte hittade något jämförbart, och
 * `unavailable` att den inte nåddes — i båda fallen är rätt svar null och inte noll. En vara utan
 * uppskattning ska få NOLL fyndpoäng, inte maximal, och det är skillnaden mellan att sakna en siffra
 * och att ha siffran noll.
 */
function uppskattatVarde(job: ConditionJob): number | null {
  const p = job.result?.price;
  if (p?.status !== "ok" || p.default === null) return null;
  return Math.round(p.default);
}

/** Sant när minst ett mått är uppmätt och inget är gissat. Se hasMeasurements i types.ts. */
function harUppmattMatt(d: Dimensions): boolean {
  if (d.estimated) return false;
  return d.widthMm !== null || d.depthMm !== null || d.heightMm !== null;
}

function retailOf(listing: GeneratedListing | null): number | null {
  const r = listing?.pricing?.retailPriceSek;
  return typeof r === "number" && r > 0 ? Math.round(r) : null;
}

/**
 * Titeln: Märke + Modell + Kategori, i den ordningen.
 *
 * Annonsgeneratorns egen titel ("Sits Impulse fåtölj i fint skick") är skriven för Tradera och bär
 * ett skickpåstående i texten. I butiken står skicket i sin egen rad med sitt eget betyg, och en
 * titel som också påstår "fint skick" säger det två gånger med två olika auktoriteter.
 */
export function titleOf(brand: string | null, model: string | null, typeNoun: string | null, fallback: string): string {
  const parts = [brand, model].filter((p): p is string => !!p && p.trim().length > 0);
  if (parts.length === 0) return fallback;
  const head = parts.join(" ");

  /**
   * Substantivet kommer ur generatorns EGET `type`-attribut, aldrig ur kategorislugen.
   *
   * Slugen är grov med flit — åtta hyllor ska rymma allt — och att skriva ut den som ett ord gör
   * påståenden som inte stämmer: IKEA Jules är en barnskrivbordsstol och hamnar riktigt i
   * "Skrivbord & kontor", men "IKEA Jules skrivbord" är fel möbel. Hellre "IKEA Jules" och låta
   * kategorin stå i sin egen rad, än en titel som är osann i sista ordet.
   */
  const noun = typeNoun?.trim().toLowerCase();
  if (!noun || noun.length > 20 || fold(head).includes(fold(noun))) return head;
  return `${head} ${noun}`;
}

/**
 * Bilden butiken visar: TILLVERKARENS KATALOGBILD först, säljarens egen bildruta som reserv.
 *
 * VI REDIGERAR INTE NÅGONS FOTO. Vägen hit har gått via två försök som båda gjorde det: möbeln
 * friklippt och lagd på vitt, och samma urklipp lagt på säljarens egen bildruta i oskärpa. Det
 * första krävde en mask som var perfekt — och blev annars en soffa med en tvättkorg fastvuxen i
 * armstödet — det andra lämnade rummet kvar fast suddigt, alltså varken borttaget eller ärligt. Ett
 * redigerat foto som misslyckas ser värre ut än ett oredigerat som är tråkigt.
 *
 * KATALOGBILDEN ÄR REDAN DEN BILDEN. Den är fotograferad i studio mot vitt av den som tillverkat
 * möbeln, den behöver ingen bearbetning av oss, och den ger rutnätet exakt det utseende en möbelbutik
 * har. Att den visar en NY exemplar av modellen är dess enda svaghet — och den bärs av att kortet
 * säger det rakt ut (se ListingView) och av att varje skada står utskriven med sitt eget foto.
 *
 * SÄLJARENS BILDRUTA ÄR RESERVEN, orörd. Utan katalogbild är den enda ärliga bilden av möbeln den
 * som togs av den, och den är bättre än en tom ruta. Adressen är kortets, inte jobbets:
 * `/api/cards/:id/cover` är den publika porten och lämnar ut exakt en bildruta, bara när kortet finns
 * publikt — därför frågas `harPubliktKort` innan adressen läggs ut.
 *
 * Saknas båda ritas möbeln ur sina mått (se ProductCard).
 */
export function imageUrlOf(job: ConditionJob, loopaId: string): string | null {
  /**
   * SÄLJARENS EGEN MÖBEL FÖRST, katalogbilden som reserv. Ordningen var tvärtom fram till att
   * produktbildssystemet kom (server/src/pipeline/bild/), och den ordningen var ett medgivande.
   *
   * Katalogbilden är en NY exemplar av modellen. Den svarar snabbt på "vad är det här?" och lika
   * snabbt fel på "vad är det jag köper?": en fläckfri studiosoffa ovanför ett pris som gäller en tio
   * år gammal. Ett kort som annars räknar upp varje skråma har då sitt största påstående — bilden —
   * hämtat någon annanstans ifrån. Den stod ändå först, därför att alternativet var ett urklipp som
   * ofta saknade ett ben.
   *
   * Det alternativet är nu en produktbild med mätt kvalitet och en spärr framför sig. Porten
   * (`/api/cards/:id/cover`) lämnar urklippet när kontrollen godkänt det och säljarens bildruta
   * annars — så adressen här är rätt i båda fallen, och katalogbilden behövs bara när det inte finns
   * någon bildruta alls.
   */
  const harBildruta = (job.result?.images.length ?? 0) > 0;
  const publikt = harBildruta && harPubliktKort(job);

  // 1. Produktbilden, när den finns och kvalitetskontrollen godkänt den.
  if (publikt && harGodkantOmslag(cutoutOf(job))) return `/api/cards/${loopaId}/cover`;

  // 2. Katalogbilden. Fel möbel — en NY exemplar — men den ser ut som en produktbild, och kortet
  //    skriver ut att den inte är möbeln som säljs.
  const katalog = job.result?.productImage?.url ?? job.productImage?.url ?? null;
  if (katalog) return katalog;

  /**
   * 3. Säljarens bildruta, med rummet kvar.
   *
   * SIST, och det ledet fanns inte i första versionen av den här ordningen: då lämnades
   * omslagsadressen ut så fort det fanns en bildruta, och porten föll själv tillbaka på den råa
   * rutan. Följden var att varje vara vars urklipp underkändes visade ett vardagsrumsfoto i
   * rutnätet i stället för katalogbilden — rutnätet blev en samling privata foton, vilket är precis
   * det produktbildssystemet finns för att slippa. Reserven ska vara den näst bästa bilden, inte
   * den sista.
   */
  return publikt ? `/api/cards/${loopaId}/cover` : null;
}

/**
 * Jobbet som butiksvara. Null när jobbet inte hör hemma i en butik alls.
 *
 * `state` skickas in i stället för att härledas: tillståndet ÄGS av butikslagret (se store.ts) och
 * inte av jobbet. Ett jobb vet inte om det är reserverat.
 */
export function jobToProduct(job: ConditionJob, state: ProductState): Product | null {
  /**
   * Ett jobb som tillhör en affär är inte en butiksvara.
   *
   * Kontrollen sitter FÖRST och i projektionen, inte i anroparen: `jobToProduct` är den enda vägen
   * från ett jobb till något butiken kan visa, och en regel som ska gälla överallt hör hemma i den
   * enda porten — inte upprepad hos var och en som råkar gå igenom den.
   *
   * TVÅ MARKÖRER, båda stängande: `dealId` (tillhör en affär) och `adDerived` (byggt på någon annans
   * annonsbilder). Den andra finns redan innan den första gör det — köparens analys skapas innan de
   * har ett konto — och utan den hade en möbel vi aldrig sett legat till försäljning hos oss.
   */
  if (job.dealId || job.adDerived) return null;

  const result = job.result;
  if (!result) return null;
  const condition = conditionOf(result);
  if (!condition) return null;

  const listing = result.listing?.result ?? job.listing?.result ?? job.pendingListing?.result ?? null;
  const attributes = listing?.attributes ?? [];
  const loopaId = loopaIdFor(job.id);

  const brand = listing?.identity?.brand ?? job.selected?.brand ?? job.identity?.brand ?? null;
  const model = listing?.identity?.exactProduct ?? job.selected?.model ?? job.identity?.model ?? null;

  const typeAttr = attr(attributes, /^(type|typ|kategori|category)$/i);
  const categorySlug = resolveCategorySlug({
    type: typeAttr,
    category: listing?.identity?.category ?? null,
    title: listing?.listing?.title ?? null,
    model,
  });

  return {
    id: loopaId,
    source: "loopa",
    title: titleOf(brand, model, typeAttr, listing?.listing?.title ?? "Möbel"),
    brand,
    model,
    categorySlug,
    color: normalizeColor(attr(attributes, COLOR_KEY)),
    material: normalizeMaterial(attr(attributes, MATERIAL_KEY)),
    dimensions: parseDimensionsMm(attributes, categorySlug),
    priceSek: priceOf(job),
    retailPriceSek: retailOf(listing),
    estimatedValueSek: uppskattatVarde(job),
    priceHistory: job.priceLadder?.drops ?? [],
    priceDroppedAt: job.priceLadder?.drops?.at(-1)?.at ?? null,
    imageCount: result.images.length,
    hasMeasurements: harUppmattMatt(parseDimensionsMm(attributes, categorySlug)),
    imageUrl: imageUrlOf(job, loopaId),
    condition,
    state,
    listedAt: job.tradera?.publishedAt ?? result.createdAt,
    listedAtKnown: true,
    externalUrl: null,
    auction: null,
    region: "Stockholm",
    homeDeliveryAvailable: true,
    returnsAccepted: true,
    jobId: job.id,
    identity: result.identity,
  };
}

export { brandSlug };

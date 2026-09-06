/**
 * "Beskriv vad du söker" — fritext till filter.
 *
 * Butikens andra ingång, vid sidan av märkesbrickorna. Skillnaden mot sökrutan är vad man får
 * skriva: sökrutan matchar ord mot titlar, det här tolkar en MENING. "En soffa till ett litet
 * vardagsrum, max 5000, gärna i tyg" är inga sökord — det är en kategori, ett pristak, ett material
 * och ett underförstått måttkrav, och det är den översättningen som sker här.
 *
 * MODELLEN FÅR INTE HITTA PÅ ETT FILTER. Svaret valideras mot den riktiga katalogen innan det
 * används: en kategori som inte finns i CATEGORIES kastas, ett märke vi inte har i lager kastas, ett
 * pris som inte är ett tal kastas. Modellen föreslår, servern bestämmer. Utan det steget kan en
 * mening styra rutnätet till ett filter som inte matchar något och se ut som ett tomt lager.
 *
 * DEN FÅR HELLER INTE BLI ETT KRAV. Går Gemini inte att nå, eller är nyckeln inte satt, faller
 * sökningen tillbaka på vanlig fritextsökning — samma ord, sämre tolkning, men aldrig ett fel i
 * ansiktet på någon som bara ville hitta en soffa. Se `interpretQuery`.
 */

import { callGeminiStructured, Type } from "../gemini.js";
import { CATEGORIES, categoryBySlug, fold, resolveCategorySlug } from "./catalog.js";
import type { ConditionGrade } from "../types.js";
import type { ProductFilter } from "./types.js";

/** Vad tolkningen kom fram till, i en form rutnätet och adressraden förstår. */
export interface Interpretation {
  filter: ProductFilter;
  /**
   * Samma filter, men med rutnätets EGNA parameternamn — `kategori`, `maxbredd` i centimeter.
   *
   * Finns för att servern och klienten talar olika dialekt om samma sak: internt heter det
   * `maxWidthMm` i millimeter, i adressen `maxbredd` i centimeter (se filterFromQuery i routes.ts).
   * Utan den här översättningen måste klienten kunna serverns dialekt för att kunna använda svaret,
   * och då finns vokabulären på två ställen som var för sig kan glida.
   */
  query: Record<string, unknown>;
  /** En mening till köparen: "Soffor & fåtöljer · max 5 000 kr · tyg". Visas ovanför träffarna. */
  summary: string;
  /** Sant när Gemini faktiskt tolkade. Falskt = vi föll tillbaka på ren ordmatchning. */
  aiUsed: boolean;
}

/** Internt filter -> rutnätets parameternamn. Millimeter blir centimeter, som i adressen. */
export function toQuery(filter: ProductFilter): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  if (filter.q) q.q = filter.q;
  if (filter.categorySlug) q.kategori = filter.categorySlug;
  if (filter.brands?.length) q.marke = filter.brands;
  if (filter.onlyLoopa) q.onlyLoopa = true;
  if (filter.minPriceSek != null) q.minPris = filter.minPriceSek;
  if (filter.maxPriceSek != null) q.maxPris = filter.maxPriceSek;
  if (filter.grades?.length) q.skick = filter.grades;
  if (filter.maxWidthMm != null) q.maxBredd = Math.round(filter.maxWidthMm / 10);
  if (filter.maxDepthMm != null) q.maxDjup = Math.round(filter.maxDepthMm / 10);
  if (filter.maxHeightMm != null) q.maxHojd = Math.round(filter.maxHeightMm / 10);
  if (filter.colors?.length) q.farg = filter.colors;
  if (filter.materials?.length) q.material = filter.materials;
  if (filter.homeDeliveryOnly) q.hemleverans = true;
  return q;
}

const GRADES: ConditionGrade[] = ["A", "B", "C", "D", "E", "F"];

/** Modellens svar, innan något av det är betrott. */
interface RawInterpretation {
  kategori?: string | null;
  /* Fälten nedan fylls bara i efterlysningsläget — se `interpretQuery(..., { efterlysning: true })`. */
  stil?: string[] | null;
  deadline_dagar?: number | null;
  bradska?: string | null;
  anteckning?: string | null;
  marken?: string[] | null;
  sokord?: string | null;
  minpris?: number | null;
  maxpris?: number | null;
  maxbredd_cm?: number | null;
  maxdjup_cm?: number | null;
  maxhojd_cm?: number | null;
  farger?: string[] | null;
  material?: string[] | null;
  skick?: string[] | null;
  endast_granskade?: boolean | null;
  sammanfattning?: string | null;
}

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    kategori: { type: Type.STRING, description: "Exakt en slug ur listan i systemprompten, eller utelämnad." },
    marken: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Märken NÄMNDA i frågan, exakt som de stavas i lagerlistan." },
    sokord: { type: Type.STRING, description: "ETT ord eller ett modellnamn, t.ex. 'Ektorp'. Aldrig en mening, aldrig ditt resonemang. Tomt om inget." },
    minpris: { type: Type.NUMBER },
    maxpris: { type: Type.NUMBER },
    maxbredd_cm: { type: Type.NUMBER },
    maxdjup_cm: { type: Type.NUMBER },
    maxhojd_cm: { type: Type.NUMBER },
    farger: { type: Type.ARRAY, items: { type: Type.STRING } },
    material: { type: Type.ARRAY, items: { type: Type.STRING } },
    skick: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Betyg A-D. A=nyskick, B=mycket bra, C=bra, D=slitage." },
    endast_granskade: { type: Type.BOOLEAN, description: "Sant bara om frågan uttryckligen ber om granskade/garanterade möbler." },
    sammanfattning: { type: Type.STRING, description: "En kort svensk mening om vad du förstod. Max 12 ord." },
  },
} as const;

/**
 * Efterlysningens fyra extra fält.
 *
 * Läggs till SCHEMA i stället för att bli ett andra anrop: samma mening bär både filtret och
 * brådskan, och att läsa den två gånger hade kostat två modellanrop för ett svar. Fälten är
 * meningslösa för en sökruta — en sökning har ingen deadline — och skickas därför bara med när
 * anroparen ber om dem.
 */
const EFTERLYSNING_FIELDS = {
  stil: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: "Stil- eller epokord som NÄMNS: '60-tal', 'funkis', 'skandinaviskt'. Tomt om inget.",
  },
  deadline_dagar: {
    type: Type.NUMBER,
    description: "Antal dagar tills möbeln behövs, om ett datum eller en tidsrymd nämns. Annars utelämnad.",
  },
  bradska: { type: Type.STRING, description: "none, soon eller urgent. Sätt urgent bara vid uttrycklig brådska." },
  anteckning: { type: Type.STRING, description: "Ett önskemål som INTE ryms i fälten ovan, i köparens egna ord. Max 15 ord." },
} as const;

const EFTERLYSNING_SCHEMA = {
  type: Type.OBJECT,
  properties: { ...SCHEMA.properties, ...EFTERLYSNING_FIELDS },
} as const;

/** Extra regler för efterlysningsläget. Läggs sist i systemprompten. */
const EFTERLYSNING_RULES = [
  "",
  "DET HÄR ÄR EN EFTERLYSNING, inte en sökning. Köparen beskriver något de vill ha men inte hittat.",
  "- stil är ord om FORM eller EPOK, aldrig om färg eller material. 'grön sammet' är inte stil.",
  "- deadline_dagar sätts bara när en tid nämns: 'innan jul', 'till nästa vecka', 'inom en månad'.",
  "- bradska är urgent bara när köparen säger att det brådskar. Ett datum ensamt är soon.",
  "- anteckning bär det som inte fick plats: 'måste gå in genom en smal dörr', 'helst avtagbar klädsel'.",
  "  Skriv köparens ord, inte dina. Utelämna fältet hellre än att sammanfatta hela meningen igen.",
].join("\n");

function systemPrompt(brands: string[]): string {
  return [
    "Du översätter en svensk mening om en möbel till ett filter i en begagnatbutik i Stockholm.",
    "",
    "KATEGORIER — använd exakt en av dessa slugs, eller utelämna fältet:",
    ...CATEGORIES.map((c) => `  ${c.slug} = ${c.label}`),
    "",
    brands.length
      ? `MÄRKEN I LAGER — använd bara dessa, exakt så stavade: ${brands.join(", ")}.`
      : "Inga märken finns i lager. Utelämna märkesfältet.",
    "",
    "REGLER:",
    "- Utelämna hellre ett fält än att gissa. Ett tomt filter ger många träffar; ett påhittat ger noll.",
    "- 'Litet', 'trångt', 'liten lägenhet' är INTE ett mått. Sätt bara mått när frågan har ett tal i cm eller meter.",
    "- Meter blir centimeter: '2 meter bred' -> maxbredd_cm 200.",
    "- 'Billig' är inget pris. Sätt bara pris när frågan har ett tal.",
    "- Färg och material skrivs i grundform och på svenska: 'blå', 'ek', 'tyg', 'skinn'.",
    "- Ett modellnamn ('Ektorp', 'Lamino', 'Poäng') hör i sokord, aldrig i marken.",
    "- sokord är ETT ord. Är ordet redan fångat av kategori, märke, färg eller material: lämna det tomt.",
    "- Nämner frågan inget om skick: utelämna skick och endast_granskade.",
    "- Fyll i ALLA fält frågan svarar på. 'svart barstol i trä under 1000 kr' är fyra fält: kategori,",
    "  färg, material och pris — inte ett.",
    "- Skriv aldrig ditt resonemang i ett fält. Fälten innehåller värden, inga meningar om värden.",
    "",
    "Sammanfattningen är till köparen och beskriver bara det du FAKTISKT filtrerade på.",
  ].join("\n");
}

/**
 * Tolkningen, med katalogen som facit.
 *
 * Varje fält prövas mot något verkligt innan det får bli ett filter — och ett fält som inte håller
 * kastas tyst i stället för att fälla hela sökningen. En mening där modellen fick kategorin rätt men
 * hittade på ett märke ska ge kategorifiltret, inte ett felmeddelande.
 */
export function validate(raw: RawInterpretation, brands: string[]): Interpretation {
  const parts: string[] = [];
  const filter: ProductFilter = {};

  const category = raw.kategori && categoryBySlug(raw.kategori) ? raw.kategori : null;
  if (category) {
    filter.categorySlug = category;
    parts.push(categoryBySlug(category)!.label);
  }

  // Märket måste finnas i lagret. Ett märke vi inte har är en garanterat tom sida.
  const known = new Map(brands.map((b) => [fold(b), b]));
  const marken = (raw.marken ?? []).map((m) => known.get(fold(m))).filter((m): m is string => !!m);
  if (marken.length) {
    filter.brands = marken;
    parts.push(marken.join(" eller "));
  }

  const num = (v: unknown, max: number): number | null => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n) : null;
  };

  const minPris = num(raw.minpris, 500_000);
  const maxPris = num(raw.maxpris, 500_000);
  if (minPris !== null) filter.minPriceSek = minPris;
  if (maxPris !== null) filter.maxPriceSek = maxPris;
  if (maxPris !== null) parts.push(`max ${maxPris.toLocaleString("sv-SE")} kr`);
  else if (minPris !== null) parts.push(`från ${minPris.toLocaleString("sv-SE")} kr`);

  // Måtten kommer i cm från modellen och lagras i mm, som allt annat i butiken.
  const dim = (v: unknown) => {
    const cm = num(v, 400);
    return cm === null ? null : cm * 10;
  };
  const bredd = dim(raw.maxbredd_cm);
  const djup = dim(raw.maxdjup_cm);
  const hojd = dim(raw.maxhojd_cm);
  if (bredd !== null) { filter.maxWidthMm = bredd; parts.push(`max ${bredd / 10} cm bred`); }
  if (djup !== null) { filter.maxDepthMm = djup; parts.push(`max ${djup / 10} cm djup`); }
  if (hojd !== null) { filter.maxHeightMm = hojd; parts.push(`max ${hojd / 10} cm hög`); }

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0 && s.length < 30).slice(0, 4) : [];

  const farger = strings(raw.farger);
  if (farger.length) { filter.colors = farger; parts.push(farger.join("/")); }
  const material = strings(raw.material);
  if (material.length) { filter.materials = material; parts.push(material.join("/")); }

  const skick = strings(raw.skick).map((s) => s.toUpperCase()).filter((s): s is ConditionGrade => GRADES.includes(s as ConditionGrade));
  if (skick.length) { filter.grades = skick; parts.push(`skick ${skick.join("/")}`); }

  if (raw.endast_granskade === true) { filter.onlyLoopa = true; parts.push("endast Loopa-granskade"); }

  /**
   * Sökordet ska vara ett ORD, inte en mening.
   *
   * Modellen svarade en gång "barstol Cristofaro? No, just barstol. Wait, let's keep it simple." i
   * det här fältet — den tänkte högt rakt in i filtret, och eftersom `q` matchas mot varje titel gav
   * det noll träffar på en fråga som hade gott om svar. Fältet är därför kapat till några ord och
   * kastas helt när det ser ut som en mening.
   */
  const sokordRaw = typeof raw.sokord === "string" ? raw.sokord.trim() : "";
  const rambling = /[?!.,:;]|\b(no|wait|just|let'?s|eller hur|kanske)\b/i.test(sokordRaw) || sokordRaw.split(/\s+/).length > 3;

  /**
   * Ett sökord som bara upprepar kategorin kastas.
   *
   * "svart barstol i trä" gav `kategori: stolar` OCH `sokord: "barstol"`. Kategorin är rätt, men
   * sökordet matchas mot titel, märke och modell — och våra titlar heter "IKEA NORDVIKEN", aldrig
   * "barstol". Kraven tillsammans gav noll träffar på en fråga med 48 svar. Prompten ber redan
   * modellen låta bli; det här är samma regel på vår sida av anropet, där den håller.
   */
  const echoesCategory =
    !!category && !!sokordRaw && resolveCategorySlug({ title: sokordRaw }) === category;

  const sokord = rambling || echoesCategory ? "" : sokordRaw.slice(0, 40);
  if (sokord) { filter.q = sokord; parts.push(`”${sokord}”`); }

  const summary = typeof raw.sammanfattning === "string" && raw.sammanfattning.trim()
    ? raw.sammanfattning.trim().slice(0, 120)
    : parts.length
      ? parts.join(" · ")
      : "Hela lagret";

  return { filter, query: toQuery(filter), summary, aiUsed: true };
}

/**
 * Ett enkelt tak per avsändare.
 *
 * Slutpunkten är PUBLIK — sökningen ska fungera utloggad — och varje anrop kostar ett Gemini-anrop.
 * Utan tak är det en öppen kran mot vår kvot. Fönstret är litet med flit: en människa som söker
 * skriver några meningar i minuten, inte trettio.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;
const hits = new Map<string, number[]>();

export function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  // Städar bort avsändare som slutat höra av sig, så kartan inte växer i evighet.
  if (hits.size > 500) for (const [k, v] of hits) if (v.every((t) => now - t > RATE_WINDOW_MS)) hits.delete(k);
  return recent.length > RATE_MAX;
}

export function aiSearchAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY?.trim() && process.env.BUTIK_AI_SEARCH !== "0";
}

/** Reservtolkningen: meningen som sökord. Sämre, men den svarar alltid. */
function fallback(question: string): Interpretation {
  const filter: ProductFilter = { q: question.trim().slice(0, 80) };
  return { filter, query: toQuery(filter), summary: `Sökning: ${question.trim().slice(0, 60)}`, aiUsed: false };
}

/** Efterlysningens fyra extra fält, som de kommer ur tolkningen. Tomma i sökläget. */
export interface EfterlysningExtras {
  styleTags: string[];
  deadlineDays: number | null;
  urgency: "none" | "soon" | "urgent";
  note: string | null;
}

export interface InterpretOptions {
  /** Läs även stil, deadline, brådska och anteckning. Se EFTERLYSNING_FIELDS. */
  efterlysning?: boolean;
}

/** Extras ur ett råsvar, prövade var för sig — ett dåligt fält får inte fälla de andra. */
function validateExtras(raw: RawInterpretation): EfterlysningExtras {
  const tags = (raw.stil ?? [])
    .filter((t): t is string => typeof t === "string" && t.trim().length > 1)
    .map((t) => t.trim().toLowerCase())
    .slice(0, 5);
  const days = typeof raw.deadline_dagar === "number" && raw.deadline_dagar > 0 && raw.deadline_dagar <= 365
    ? Math.round(raw.deadline_dagar)
    : null;
  const urgency = raw.bradska === "urgent" || raw.bradska === "soon" ? raw.bradska : "none";
  const note = typeof raw.anteckning === "string" && raw.anteckning.trim().length > 3
    ? raw.anteckning.trim().slice(0, 200)
    : null;
  // En deadline utan uttryckt brådska är ändå brådska av det mildare slaget.
  return { styleTags: tags, deadlineDays: days, urgency: days !== null && urgency === "none" ? "soon" : urgency, note };
}

export const EMPTY_EXTRAS: EfterlysningExtras = { styleTags: [], deadlineDays: null, urgency: "none", note: null };

/**
 * Svaret utan modellen, när frågan inte är en mening.
 *
 * MODELLEN FINNS FÖR MENINGAR — "en soffa till ett litet vardagsrum, max 5000, gärna i tyg". Ett
 * ensamt ord är ingen mening: "soffa" är en kategori och "IKEA" är ett märke, och båda går att slå
 * upp i listor vi redan har. Anropet kostade 1,8–3 s första gången ordet söktes och gav samma svar
 * som uppslagningen — en väntan köparen betalade för ingenting.
 *
 * TVÅ ORD RÄCKER SOM GRÄNS, och siffror diskvalificerar: "under 3000" och "max 80 cm" är precis den
 * sortens frågor modellen är bra på, och de får kosta sitt anrop.
 *
 * Returnerar null när frågan inte är entydig — då är modellen fortfarande rätt verktyg.
 */
function utanModell(text: string, brands: string[]): Interpretation | null {
  const ord = text.split(/\s+/).filter(Boolean);
  if (ord.length > 2 || /\d/.test(text)) return null;

  // Märket först: "Mio" är ett märke OCH ett ord som kan råka finnas i en titel. Märkesfiltret är
  // det snävare och mer sanna av de två.
  const marke = brands.find((b) => fold(b) === fold(text));
  if (marke) {
    const filter: ProductFilter = { brands: [marke] };
    return { filter, query: toQuery(filter), summary: marke, aiUsed: false };
  }

  /**
   * Kategorin ur samma nyckelordslista som butiken kategoriserar VARORNA med (catalog.ts).
   *
   * Att låna den listan är hela poängen: ett ord som gör en möbel till en soffa gör en sökning på
   * soffor. Två vokabulärer hade kunnat säga olika saker om samma ord.
   */
  const slug = resolveCategorySlug({ title: text });
  if (slug !== "ovrigt") {
    // Sökordet står kvar bredvid kategorin: "barstol" är kategorin stolar, men ordet skiljer
    // barstolen från matstolen och det är den skillnaden köparen skrev.
    const filter: ProductFilter = { categorySlug: slug, q: text.slice(0, 80) };
    return {
      filter,
      query: toQuery(filter),
      summary: `${categoryBySlug(slug)?.label ?? slug} · ${text}`,
      aiUsed: false,
    };
  }
  return null;
}

export async function interpretQuery(
  question: string,
  brands: string[],
  opts: InterpretOptions = {},
): Promise<Interpretation & { extras: EfterlysningExtras }> {
  const text = question.trim();
  if (!text) return { filter: {}, query: {}, summary: "Hela lagret", aiUsed: false, extras: EMPTY_EXTRAS };
  /**
   * Genvägen prövas FÖRE nyckeln, och gäller BARA sökläget.
   *
   * Före nyckeln därför att den inte behöver någon: uppslagningen mot kategori- och märkeslistorna
   * är vår egen, och utan Gemini-nyckel är den dessutom ett bättre svar än ren ordmatchning.
   *
   * Bara sökläget därför att efterlysningen läser stil, deadline och brådska ur samma mening, och de
   * fälten finns inte i någon lista. "Soffa" som efterlysning är dessutom en annan sorts yttrande än
   * "soffa" som sökning — där ÄR det korta ordet början på ett samtal, och modellen ställer
   * följdfrågorna.
   */
  if (!opts.efterlysning) {
    const genvag = utanModell(text, brands);
    if (genvag) return { ...genvag, extras: EMPTY_EXTRAS };
  }

  if (!aiSearchAvailable()) return { ...fallback(text), extras: EMPTY_EXTRAS };

  try {
    const result = await callGeminiStructured<RawInterpretation>({
      // Egen cachenyckel per läge: samma mening ger olika svar beroende på vilket schema som gällde.
      purpose: opts.efterlysning ? "efterlysning_parse" : "butik_search",
      systemPrompt: opts.efterlysning ? systemPrompt(brands) + EFTERLYSNING_RULES : systemPrompt(brands),
      userPrompt: text.slice(0, 400),
      images: [],
      responseSchema: opts.efterlysning ? EFTERLYSNING_SCHEMA : SCHEMA,
      // Ingen bild, kort svar: en sökruta får inte kännas som en analys. Faller den, faller den fort.
      resolution: "low",
      // Första anropet efter en omstart betalar klientuppsättning och TLS och landade på 8 s; det
      // gav en tyst reservtolkning på en fråga modellen hade svarat rätt på. Taket är därför satt
      // över den kostnaden, men fortfarande så lågt att en sökruta aldrig känns hängd. (API:t
      // avvisar allt under 10 s, så reservanropet klampar dit ändå — se MIN_TIMEOUT_MS.)
      primaryTimeoutMs: 12_000,
      /**
       * Sökningar cachas i ett dygn, inte för alltid.
       *
       * Cachen skyddar kvoten när samma fras söks om och om igen. Men modellen varierar, och utan
       * tak frystes en enstaka tunn tolkning som svaret på den frågan för all framtid — mätt på
       * "svart barstol i trä under 1000 kr", som gav hela filtret vid ett anrop och bara kategorin
       * vid nästa. Ett dygn är kort nog att ett dåligt utfall rättar sig självt och långt nog att
       * en fras som söks mycket bara kostar ett anrop.
       */
      cacheMaxAgeMs: 24 * 60 * 60 * 1000,
    });
    return {
      ...validate(result.data, brands),
      extras: opts.efterlysning ? validateExtras(result.data) : EMPTY_EXTRAS,
    };
  } catch (err) {
    console.warn("[butik] AI-tolkningen föll, faller tillbaka på ordmatchning:", err instanceof Error ? err.message : err);
    return { ...fallback(text), extras: EMPTY_EXTRAS };
  }
}

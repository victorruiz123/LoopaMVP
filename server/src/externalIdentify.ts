/**
 * Identifiering som görs UTANFÖR servern — appens webbvy mot Googles AI-läge — och skickas hit som text.
 *
 * PROTOTYP (2026-10-27), bakom ett per-jobb-flagga (`externalIdentify` vid uppladdningen). Webbklienten sätter den bara när den körs i appskalet
 * (`window.loopaApp`); den vanliga webben berörs inte. Se scripts/loopa-app-prototype/.
 *
 * VAD SERVERN GÖR MED SVARET:
 *   1. Ett Gemini-anrop UTAN sökning för över AI-lägets fritext till ett schema (modell, säkerhet, alternativ, mått, material, källor). Det är ENDAST en översättning:
 *      prompten förbjuder allt som inte står i svaret.
 *   2. Kandidaterna blir vanliga `ModelCandidate`-rader (primär + alternativ), så väljarskärmen fungerar oförändrad. Referensbilder hämtas som vanligt ur källorna.
 *   3. Måtten och materialen sparas på jobbet och används när säljaren väljer den modellen: de går då genom specsökningens VANLIGA verifiering (vi hämtar källsidorna
 *      och märker varje rad bekräftad/citerad/obekräftad) — ingen ny forskning, inget sökande anrop. AI-lägets påståenden tas aldrig för sanna utan den kontrollen.
 */

import { SPEC_SCHEMA } from "./research/schema.js";
import { runInteraction } from "./research/geminiInteractions.js";
import { RESEARCH_MODEL } from "./research/config.js";
import { getJob, getJobSync } from "./jobStore.js";
import { rostaTyp } from "./candidateType.js";

const STRUCTURE_SCHEMA = {
  ...SPEC_SCHEMA,
  properties: {
    ...SPEC_SCHEMA.properties,
    alternatives: {
      type: "array",
      description:
        "Alla övriga förslag i svarets ordning, högst fem (förslag 1 är identity.model). Ett förslag som är SAMMA modell som ett tidigare — bara en annan höjd, storlek eller variant, " +
        "som \"NORDVIKEN barstol\" och sedan \"NORDVIKEN matstol\" — hoppas över, så att tre OLIKA modeller återstår.",
      items: {
        type: "object",
        properties: {
          model: { type: "string" },
          why: { type: ["string", "null"], description: "Svarets motivering för just det här förslaget (VARFÖR), kort." },
          confidence: { type: "string", enum: ["high", "medium", "low"], description: "Svarets SÄKERHET för förslaget: hög→high, medel→medium, låg eller saknas→low." },
          sourceUrl: { type: ["string", "null"], description: "Svarets SIDA för förslaget, bara om adressen står i listan 'Länkar på sidan'; annars null." },
        },
        required: ["model", "why", "confidence", "sourceUrl"],
      },
    },
    confidenceReason: { type: ["string", "null"], description: "Varför AI-läget var säkert eller osäkert, med dess egna ord (kort)." },
  },
  required: [...SPEC_SCHEMA.required, "alternatives", "confidenceReason"],
};

const SYSTEM = `Du för över ett svar från en AI-sökning om en möbel till ett schema. Skriv ENDAST det svaret säger: inget du själv vet, ingen gissning, ingen uppskattning.
- Svaret rangordnar upp till fyra förslag (numrerade 1–4, eller märkta FÖRSLAG 1–4), det mest sannolika först. Finns ett avsnitt "FLER FÖRSLAG (svar på en uppföljningsfråga)" fortsätter det listan: dess förslag räknas efter de första, i sin ordning, och samma modell tas inte två gånger. identity.model är förslag 1 utan märket och utan produkttyp ("Impulse", inte "Sits Impulse Armchair"); samma sak för alternatives[].model. identity.category är möbeltypen svaret nämner, på svenska (t.ex. "fåtölj"); nämner svaret ingen typ lämnas den tom.
- Säkerhet: identity.confidence och alternatives[].confidence är svarets egen säkerhet för just det förslaget. Anges den i procent: 75 % eller mer → high, 40–74 % → medium, under 40 % → low. Anges den i ord: "mycket hög"/"hög" → high, "medel"/"måttlig"/"ganska säker" → medium, annars low. Anges ingen: low. confidenceReason är svarets motivering för förslag 1 (dess egna ord, kort).
- Mått och material tas bara ur avsnittet "MÅTT OCH MATERIAL FÖR FÖRSLAG 1" — och bara om det avsnittet gäller samma modell som förslag 1. Nämner det en annan modell, eller saknas avsnittet, lämnas mått och material tomma. 'okänt' lämnas ut helt. Mått anges som tal i svarets enhet. Kanonisk type i snake_case (overall_width, overall_depth, overall_height, seat_height, seat_depth, arm_height, arm_width …).
- sourceUrl på ett mått eller material är en av länkarna som listas under "Länkar på sidan" OM svaret tydligt hänför uppgiften dit; annars null. Hitta aldrig på adresser.
- sourcesUsed = länkarna svaret stöder sig på. variants och otherFacts: tomma om svaret inte nämner dem. missing = det svaret säger att det inte vet.
- alternatives = de övriga förslagen i svarets ordning, med deras egen säkerhet, motivering och sida. Samma modell i annan storlek, höjd eller variant är INTE ett eget förslag (svaret kan lista "NORDVIKEN barstol" som förslag 1 och "NORDVIKEN matstol" som förslag 4: det är en modell): hoppa över den och ta nästa förslag med ett annat modellnamn i stället, så att tre olika modeller återstår när svaret har så många (fler än fyra förslag finns när ett avsnitt "FLER FÖRSLAG" fyllt på). Förslag som svaret märker utgångna eller äldre modeller är förslag som alla andra: ta med dem. sourceUrl bara om adressen står under "Länkar på sidan"; en länktext utan adress ("Sits Impulse Collection") är ingen adress. Ändra aldrig ordningen och lägg inte till förslag som svaret inte har.`;

export interface ExternalAlternative {
  model: string;
  why: string | null;
  confidence: "high" | "medium" | "low";
  sourceUrl: string | null;
}

export interface ExternalStructured {
  spec: Record<string, unknown>;
  model: string;
  confidence: "high" | "medium" | "low";
  confidenceReason: string | null;
  alternatives: ExternalAlternative[];
  costUsd: number;
}

const PRODUCT_TYPE_WORDS = /\s*[(\-–,]?\s*\b(arm\s?chairs?|easy\s?chairs?|chairs?|sofas?|couch(?:es)?|loveseats?|fåtölj(?:er|en)?|soffa(?:n|or)?|stol(?:en|ar)?)\b\)?\s*$/i;

/**
 * Modellnamnet så som märket själv skriver det: utan märket först och utan produkttyp sist ("Sits Brandon Armchair" → "Brandon").
 * AI-lägets svar lägger ofta på typen ("Stella Armchair"), och då hittar ingen sida modellen: bildjakten kräver att sidans titel nämner namnet, och Sits egen sida heter
 * "Stella furniture collection". Blir namnet tomt efter rensningen (modellen heter faktiskt "Chair") behålls det ursprungliga.
 */
export function cleanModelName(name: string, brand: string): string {
  let s = name.replace(/\s+/g, " ").trim();
  const b = brand.trim();
  if (b && s.toLowerCase().startsWith(b.toLowerCase() + " ")) s = s.slice(b.length).trim();
  // En parentes är en kommentar och inte en del av namnet: "Impulse (med breda armstöd)" blev en bildsökning på hela uttrycket och därmed en tom ruta för just den modellen.
  // Blir namnet tomt (det bestod bara av en parentes) behålls det ursprungliga, som alltid.
  const utanParentes = s.replace(/\s*\([^)]*\)/g, "").trim();
  if (utanParentes) s = utanParentes;
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(PRODUCT_TYPE_WORDS, "").trim();
  }
  return s || name.trim();
}

/**
 * Möbeltypen ur de ord svaret redan använder ("Brandon Armchair", "Fåtölj (Armchair), standardbredd"), för när MÖBELTYP saknas. Bildjakten behöver typen: utan den
 * ger "Brandon" bilden av Brandon-SOFFAN, och säljaren kan inte skilja fåtöljerna åt på en rad soffbilder. Okänt ger null, aldrig en gissning.
 */
export function inferProductType(...texts: Array<string | null | undefined>): string | null {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (/arm\s?chair|easy\s?chair|fåtölj/.test(t)) return "fåtölj";
  if (/\bsofa|soffa|couch|loveseat/.test(t)) return "soffa";
  if (/chair\b|stol/.test(t)) return "stol";
  return null;
}

/**
 * Möbeltypen för alla förslag: det strukturerade svarets egen (identity.category), annars ur orden som redan står (modellnamnet, varianten), annars ur svarets inledning ("Fåtöljen på bilderna …").
 * Svarets källistor längre ner nämner ofta andra produkter ("ÄPPLARYD sofa with chaise"), så bara de första tecknen får avgöra. Okänt ger null.
 */
export function pickCategory(category: unknown, rawModel: string, variant: unknown, answer: string, links: string[] = []): string | null {
  if (typeof category === "string" && category.trim()) return category.trim();
  return inferProductType(rawModel, typeof variant === "string" ? variant : null) ?? inferProductType(answer.slice(0, 500)) ?? rostaTyp(`${answer.slice(0, 8000)} ${links.join(" ")}`);
}

/** En motivering som får plats på ett val-kort: hela meningar tills gränsen, annars ett ordgränssnitt med "…". Hela svaret finns kvar på jobbet. */
export function clipReason(text: string | null | undefined, max = 220): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end >= 60) return cut.slice(0, end + 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "") + "…";
}

/**
 * Förslag 2–4 ur strukturerarens svar: modellnamnen rensade (se cleanModelName), tomma namn bort, samma modell som förslag 1 (eller som ett tidigare förslag) bort,
 * högst tre kvar, svarets ordning orörd. En länk behålls bara om den står bland sidans länkar — strukturerarens fria text blir aldrig en adress vi går till.
 */
export function parseAlternatives(raw: unknown, primary: string, links: string[], brand = ""): ExternalAlternative[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set([slug(cleanModelName(primary, brand))]);
  const out: ExternalAlternative[] = [];
  for (const a of raw as Array<Record<string, unknown>>) {
    const model = typeof a?.model === "string" ? cleanModelName(a.model, brand) : "";
    const key = slug(model);
    if (!model || !key || seen.has(key)) continue;
    seen.add(key);
    const url = typeof a.sourceUrl === "string" ? a.sourceUrl.trim().replace(/[.,;:!?)\]}>"'*_]+$/, "") : "";
    out.push({
      model,
      why: typeof a.why === "string" ? clipReason(a.why) : null,
      confidence: a.confidence === "high" || a.confidence === "medium" ? a.confidence : "low",
      sourceUrl: url && links.includes(url) ? url : null,
    });
    if (out.length === 3) break;
  }
  return out;
}

/** Adresser som står i löptext slutar ofta på ett skiljetecken som hör till meningen ("…/brandon/,"). */
export function cleanExternalLinks(links: string[]): string[] {
  const out = links
    .map((l) => l.trim().replace(/[.,;:!?)\]}>"'*_]+$/, ""))
    .filter((l) => /^https?:\/\//i.test(l) && !/google\.[a-z.]+\/(search|url)|gstatic|googleusercontent/i.test(l));
  return [...new Set(out)].slice(0, 60);
}

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");

/**
 * Den länk som handlar om just den här modellen: adressen nämner modellnamnet (helst på märkets egen sida), annars märkets egen sida, annars ingen.
 * Rena bildfiler och PDF-filer väljs sist: sidan vi kan läsa väger tyngre än en katalog vi inte tolkar.
 */
export function pickModelPage(links: string[], model: string, brand: string): string | null {
  const m = slug(model);
  const b = slug(brand);
  if (!links.length) return null;
  const score = (u: string) => {
    let host = "";
    let rest = u;
    try {
      const x = new URL(u);
      host = slug(x.hostname);
      rest = x.pathname + x.search;
    } catch {
      /* ogiltig adress: poäng 0 */
    }
    const path = slug(rest);
    let s = 0;
    if (m && path.includes(m)) s += 4;
    if (b && host.includes(b)) s += 3;
    if (/\.(pdf|jpe?g|png|webp)(\?|$)/i.test(u)) s -= 2;
    return s;
  };
  const best = [...links].sort((a, z) => score(z) - score(a))[0];
  return score(best) >= 3 ? best : null;
}

/**
 * AI-lägets svar anger sällan en länk per mått; det som står är en källista i botten. En uppgift utan både länk och citat kastas av specsökningens verifiering,
 * och en uppgift med bara citat hämtas aldrig mot någon sida — så en uppgift utan egen länk får modellens sida. Det är ett PÅSTÅENDE om var uppgiften står, inget mer:
 * vår egen sidhämtning bekräftar det bara om värdet faktiskt står där, annars blir raden obekräftad.
 * Citatet tas bort samtidigt: det är AI-lägets ord ("bredd: 99 (standard)"), inte ett utdrag ur sidan, och skulle annars visas som ett sidcitat.
 */
export function attributeSources(spec: Record<string, unknown>, model: string, brand: string, links: string[]): Record<string, unknown> {
  const page = pickModelPage(links, model, brand);
  if (!page) return spec;
  const fill = (rows: unknown): unknown =>
    Array.isArray(rows)
      ? rows.map((r) => {
          const row = r as { sourceUrl?: unknown };
          const hasUrl = typeof row.sourceUrl === "string" && row.sourceUrl.trim();
          return hasUrl ? r : { ...(r as object), sourceUrl: page, quote: null };
        })
      : rows;
  const used = Array.isArray(spec.sourcesUsed) ? (spec.sourcesUsed as Array<{ url?: unknown }>) : [];
  const sourcesUsed = used.some((s) => s.url === page) ? used : [...used, { url: page, title: null, kind: "other" }];
  return { ...spec, dimensions: fill(spec.dimensions), materials: fill(spec.materials), sourcesUsed };
}

export async function structureExternalAnswer(answer: string, links: string[], brand: string): Promise<ExternalStructured> {
  const clean = cleanExternalLinks(links);
  const out = await runInteraction({
    purpose: "identify",
    label: "external",
    model: RESEARCH_MODEL,
    systemInstruction: SYSTEM,
    prompt: `Märke: ${brand}\n\nSvaret att föra över:\n${answer.slice(0, 30_000)}\n\nLänkar på sidan:\n${clean.join("\n") || "(inga)"}`,
    images: [],
    schema: STRUCTURE_SCHEMA,
    thinkingLevel: "low",
    timeoutMs: 90_000,
    tools: [],
    maxOutputTokens: 16_000,
  });
  const j = (out.json ?? {}) as Record<string, unknown>;
  const id = (j.identity ?? {}) as Record<string, unknown>;
  const rawModel = typeof id.model === "string" ? id.model : "";
  const model = cleanModelName(rawModel, brand);
  if (!model) throw new Error("AI-lägets svar innehöll ingen modell");
  // Alla förslag gäller samma fotograferade möbel, så typen är gemensam. Den rensade bort-ordet ("Armchair") är ofta det enda stället typen står.
  const category = pickCategory(id.category, rawModel, id.variant, answer, clean);
  j.identity = { ...id, model, category };
  const conf = id.confidence === "high" || id.confidence === "medium" ? id.confidence : "low";
  const alternatives = parseAlternatives(j.alternatives, model, clean, brand);
  const { alternatives: _a, confidenceReason: _c, ...spec } = j;
  void _a;
  void _c;
  return {
    spec: attributeSources({ ...spec, productPages: Array.isArray(spec.productPages) ? spec.productPages : [] }, model, brand, clean),
    model,
    confidence: conf,
    confidenceReason: typeof j.confidenceReason === "string" ? clipReason(j.confidenceReason) : null,
    alternatives,
    costUsd: out.trace.estimatedCostUsd,
  };
}

const SPEC_SYSTEM = `Du för över ett svar från en AI-sökning om EN möbels exakta variant, mått, material och nypris till ett schema. Skriv ENDAST det svaret säger: inget du själv vet. Svaret får innehålla uppskattningar (märkta "uppskattat", "troligen" eller liknande): de förs över som de är, men du lägger aldrig till några egna.
- Svaret gäller modellen som anges i meddelandet och EN variant av den, den som svaret själv valde (raden "Variant:" eller motsvarande). identity.model och identity.brand är den modellen och det märket; identity.variant är variantens beteckning ur svaret, kort och utan märke, modellnamn och möbeltyp ("Vit stomme, grå sits"; "Standard komfort, fast klädsel, tyg Caleido Light Grey"), null om svaret inte väljer någon. identity.category är möbeltypen på svenska om svaret nämner den, annars tom. identity.confidence: low.
- variants är ALLTID en tom lista. Varianten är redan vald och alla värden gäller den. Räknar svaret ändå upp flera utföranden, tyger eller färger som möjligheter tas bara det svaret valde, resten lämnas ut. Inga appliesTo: alltid null.
- Mått: ett värde per mått, för den valda varianten. Kanonisk type i snake_case (overall_width, overall_depth, overall_height, seat_height, seat_depth, arm_height, arm_width …), tal i svarets enhet, spann i value och valueMax. 'okänt' och 'saknas' lämnas ut helt.
- Material: EN rad per del (Stomme, Klädsel, Ben …), det konkreta materialet för den valda varianten ("Massiv bok, vitlackad"; "Polyester, grå"), aldrig en uppräkning av alternativ. Märker svaret uppgiften som uppskattad skrivs "uppskattat" i detail, annars null. 'okänt' lämnas ut helt.
- Nypris: retailPriceSek är svarets nypris för varianten som ett tal i kronor ("1 295 kr" → 1295, "ca 10 390 kr" → 10390; anges ett spann, till exempel mellan två år, tas det HÖGRE och spannet skrivs i otherFacts med etiketten "Nyprisspann"). Anges ett pris i annan valuta eller ett begagnatpris (Tradera, Blocket, andrahand) är retailPriceSek null. retailPriceSourceUrl är länken priset hänförs till, bara om den står under "Länkar på sidan"; annars null. Anger svaret vilket år priset gällde (en utgången modell) skrivs det i otherFacts med etiketten "Nyprisets år".
- sourceUrl på ett mått eller material är en av länkarna som listas under "Länkar på sidan" OM svaret tydligt hänför uppgiften dit; annars null. Hitta aldrig på adresser.
- sourcesUsed = länkarna svaret stöder sig på. otherFacts: tomma om svaret inte nämner några. missing = det svaret säger att det inte vet.`;

const firstBy = <T>(rows: unknown, key: (r: T) => string): T[] => {
  const seen = new Set<string>();
  return (Array.isArray(rows) ? (rows as T[]) : []).filter((r) => {
    const k = key(r);
    return !seen.has(k) && seen.add(k);
  });
};

/**
 * Specen för EN variant, vad strukturerarens svar än blev. Frågan till AI-läget ber om en enda vald variant, men svaret kan ändå räkna upp tygval ("valbart i hundratals
 * tyger") eller flera utföranden, och en rad per alternativ gav (2026-11-02, Sits Impulse) en materialruta som beskrev möjligheter i stället för säljarens möbel och en
 * variantfråga om saker AI-läget redan avgjort. Här: inga varianter, ett mått per typ och ett material per del (den första raden, i svarets ordning), inga appliesTo.
 * Nyprisets källa: anges ingen länk för priset används modellens egen sida (som för mått), annars första länken som inte är en begagnatsajt. Ett pris utan någon länk lämnas,
 * och specsteget kastar det då — ett nypris utan källa visas aldrig som belagt. Ren funktion.
 */
export function singleVariantSpec(spec: Record<string, unknown>, model: string, brand: string, links: string[]): Record<string, unknown> {
  const dimensions = firstBy<{ type?: unknown }>(spec.dimensions, (d) => String(d?.type ?? "")).map((d) => ({ ...d, appliesTo: null }));
  const materials = firstBy<{ component?: unknown }>(spec.materials, (m) => String(m?.component ?? "").toLowerCase()).map((m) => ({ ...m, appliesTo: null }));
  const price = typeof spec.retailPriceSek === "number" && Number.isFinite(spec.retailPriceSek) ? spec.retailPriceSek : null;
  // Aldrig en begagnatsajt som nyprisets källa, inte ens när adressen nämner modellen (pickModelPage räknar bara på adressen).
  const marketplace = /tradera|blocket|facebook|ebay|vinted|pinterest|second.?hand|begagnat/i;
  const sidor = links.filter((l) => !marketplace.test(l));
  const own = typeof spec.retailPriceSourceUrl === "string" && sidor.includes(spec.retailPriceSourceUrl.trim()) ? spec.retailPriceSourceUrl.trim() : null;
  const priceUrl = price === null ? null : own ?? pickModelPage(sidor, model, brand) ?? sidor.find((l) => !/\.(pdf|jpe?g|png|webp)(\?|$)/i.test(l)) ?? null;
  const used = Array.isArray(spec.sourcesUsed) ? (spec.sourcesUsed as Array<{ url?: unknown }>) : [];
  const sourcesUsed = priceUrl && !used.some((s) => s.url === priceUrl) ? [...used, { url: priceUrl, title: null, kind: "other" }] : used;
  return { ...spec, variants: [], dimensions, materials, retailPriceSek: price, retailPriceSourceUrl: priceUrl, sourcesUsed };
}

/**
 * Variant, mått, material och nypris ur AI-lägets svar på frågan som ställs EFTER att säljaren valt modell, för modellen de valde. Översättning, inget mer — se SPEC_SYSTEM.
 */
export async function structureExternalSpecs(answer: string, links: string[], brand: string, model: string): Promise<{ spec: Record<string, unknown>; costUsd: number }> {
  const clean = cleanExternalLinks(links);
  const out = await runInteraction({
    purpose: "specs",
    label: "external-specs",
    model: RESEARCH_MODEL,
    systemInstruction: SPEC_SYSTEM,
    prompt: `Märke: ${brand}\nModell: ${model}\n\nSvaret att föra över:\n${answer.slice(0, 30_000)}\n\nLänkar på sidan:\n${clean.join("\n") || "(inga)"}`,
    images: [],
    schema: SPEC_SCHEMA,
    thinkingLevel: "low",
    timeoutMs: 90_000,
    tools: [],
    maxOutputTokens: 16_000,
  });
  const j = (out.json ?? {}) as Record<string, unknown>;
  const spec = attributeSources(singleVariantSpec({ ...j, productPages: Array.isArray(j.productPages) ? j.productPages : [] }, model, brand, clean), model, brand, clean);
  return { spec, costUsd: out.trace.estimatedCostUsd };
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Identifieringens spec (som saknar mått, eftersom de frågades senare) och måttsvarets spec till EN: identiteten (variant, typ) från den första, allt annat från den andra där den
 * har något, annars den förstas. Källor och motsägelser läggs ihop utan dubbletter. Ren funktion, så den går att pröva utan anrop.
 */
export function mergeExternalSpec(base: Record<string, unknown>, add: Record<string, unknown>): Record<string, unknown> {
  const pick = (key: string): unknown[] => (list(add[key]).length ? list(add[key]) : list(base[key]));
  const union = (key: string, by?: (x: unknown) => string): unknown[] => {
    const seen = new Set<string>();
    return [...list(base[key]), ...list(add[key])].filter((x) => {
      const k = by ? by(x) : JSON.stringify(x);
      return !seen.has(k) && seen.add(k);
    });
  };
  return {
    ...base,
    ...add,
    identity: { ...((add.identity as object) ?? {}), ...((base.identity as object) ?? {}) },
    variants: pick("variants"),
    dimensions: pick("dimensions"),
    materials: pick("materials"),
    otherFacts: union("otherFacts"),
    conflicts: union("conflicts"),
    missing: union("missing"),
    productPages: union("productPages"),
    sourcesUsed: union("sourcesUsed", (x) => String((x as { url?: unknown })?.url ?? "")),
  };
}

/** Har specen något att bygga en annons på — minst ett mått eller ett material? En tom spec får aldrig ersätta Loopas egen specsökning. */
export function specHasFacts(spec: Record<string, unknown> | null | undefined): boolean {
  return !!spec && (list(spec.dimensions).length > 0 || list(spec.materials).length > 0);
}

/**
 * Specsteget väntar på att AI-lägets svar (variant, mått, material, nypris) ska landa, högst `ms`. Returnerar när det kom, när det gav upp, eller när tiden är ute.
 * Frågan ställs först när säljaren valt modell, och AI-läget söker då upp varianten och nypriset: taket ska rymma det, och efter det går specsteget sin egen väg (en betald sökning). */
export async function waitForExternalSpecs(jobId: string, ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ext = (getJobSync(jobId) ?? (await getJob(jobId)))?.externalFacts;
    if (!ext?.specPending) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[identify] ${jobId.slice(0, 8)} måttsvaret från AI-läget kom inte inom ${Math.round(ms / 1000)} s — specsteget går vidare utan`);
}

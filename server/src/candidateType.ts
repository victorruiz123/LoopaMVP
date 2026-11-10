import { readFile } from "node:fs/promises";
import path from "node:path";
import { callGeminiStructured, Type } from "./gemini.js";
import { kandidatbilderDir } from "./kandidatbild.js";

/**
 * Möbeltypen på modellväljarens bilder.
 *
 * 2026-10-29, fältprov med Sits: fyra förslag på FÅTÖLJER visades med soffor. Märkets kollektionssida (`sits.eu/collection/stella/`) handlar
 * om modellen i alla dess utföranden, och dess og:image är en hörnsoffa i ett vardagsrum. Sidan nämner modellen, den klarade alltså
 * namnkontrollen — och säljaren, som väljer på bilden, fick en soffa att känna igen sin fåtölj i.
 *
 * Två försvar, i den ordning de är billiga:
 *   1. TEXTEN. En sida vars titel eller adress säger "armchair"/"fåtölj" är rätt typ; en som säger "sofa"/"soffa" är fel typ och ger ingen bild alls.
 *   2. BILDEN. En titt på själva bilden avgör: huvudmotivet ska vara samma typ som kandidaten, och det ska vara ett foto — Snug Interiors och Sits egna sidor har
 *      måttritningar ("82 · 44 · 92 · 81") som sidans första bild, och en ritning är ingen bild säljaren känner igen sin fåtölj i.
 *      Går kontrollen inte att göra (ingen nyckel, nätfel) antas bilden vara rätt, som förut — den kan inte göra läget sämre än det var.
 *
 * En bild på fel TYP av möbel är värre än en tom ruta av samma skäl som en bild på fel modell: bilden är det man väljer på.
 */

export type Typfamilj = "fatolj" | "soffa" | "stol" | "bord" | "sang";

const norm = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Familjen en kandidats produkttyp ("fåtölj", "hörnsoffa", "matstol") hör till. Null när typen är okänd eller något vi inte skiljer på. */
export function typfamilj(productType: string | null | undefined): Typfamilj | null {
  const f = familjerI(productType ?? "");
  // En produkttyp som nämner flera ("soffa och fåtölj") säger inget entydigt.
  return f.size === 1 ? [...f][0] : null;
}

/** Typens ord på engelska, för sökfrågan: märkets återförsäljare skriver "armchair", inte "fåtölj". Null när typen är okänd. */
export function engelskTyp(productType: string | null | undefined): string | null {
  const fam = typfamilj(productType);
  return fam ? { fatolj: "armchair", soffa: "sofa", stol: "chair", bord: "table", sang: "bed" }[fam] : null;
}

/** Alla familjer en text (titel, adress, alt-text) nämner. Texten normaliseras först, så "Fåtölj" och "fatolj" är samma ord. */
export function familjerI(text: string): Set<Typfamilj> {
  const t = ` ${norm(text)} `;
  const out = new Set<Typfamilj>();
  const fatolj = /armchair|arm chair|fatolj|fauteuil|sessel|lounge chair|easy chair|loungestol|karmstol/.test(t);
  if (fatolj) out.add("fatolj");
  if (/ sofas? |soffa|soffor|couch|canape| loveseats? |sectional| [2-5] ?(seater|seaters|seat) | [2-5] sits /.test(t)) out.add("soffa");
  // "armchair" innehåller "chair": stolsordet söks först när fåtöljordet är bortplockat.
  if (/stol| chairs? |stool|stuhl/.test(t.replace(/armchair|arm chair|fatolj\w*|fauteuil|lounge chair|easy chair|loungestol|karmstol/g, " "))) out.add("stol");
  if (/ tables? |bord | bord|desk/.test(t)) out.add("bord");
  if (/ bed |sang | sang|mattress|madrass/.test(t)) out.add("sang");
  return out;
}

const SV_NAMN: Record<Typfamilj, string> = { fatolj: "fåtölj", soffa: "soffa", stol: "stol", bord: "bord", sang: "säng" };

/**
 * UNDERTYP: samma modellnamn kan vara två helt olika möbler. IKEA NORDVIKEN är både en matstol och en BARSTOL, med samma formspråk men olika höjd och olika produktbild. Familjen "stol"
 * skiljer dem inte åt, och 2026-11-03 visade kortet för en NORDVIKEN-barstol matstolens bild (Googles egen sida sa "NORDVIKEN barstol"). Undertypen läses ur kandidatens EGEN text (svarets rad
 * om modellen, produktsidans adress, förklaringen) och går in i sökfrågan, titelurvalet, bildkontrollen och registrets nyckel.
 * Bara de undertyper där bilden verkligen är en annan möbel: lägg till fler här när de visar sig (hörnsoffa, bäddsoffa, kontorsstol).
 */
export type Undertyp = "barstol";
const UNDERTYP: Record<Undertyp, { fam: Typfamilj; ord: RegExp; motsatt: RegExp; svenska: string; beskrivning: string }> = {
  barstol: {
    fam: "stol",
    ord: /barstol|bar stool|barstool|counter stool|counter height|bankhojd|bar chair|barkrakk/,
    // En titel som säger "matstol" eller "dining chair" och inget om bar: det är den vanliga stolen.
    motsatt: /matstol|koksstol|dining chair|kitchen chair|karmstol|armchair|fatolj|kontorsstol|office chair/,
    svenska: "barstol",
    beskrivning:
      "en BARSTOL (bänkhöjdsstol): en hög stol vars sits sitter högt över golvet (ungefär 60–80 cm, i höjd med en bardisk eller köksö), med långa ben och oftast ett fotstöd eller en tvärslå långt ned. " +
      "En vanlig matstol eller köksstol med normal sitthöjd (ungefär 45 cm, korta ben, ingen fotpinne högt upp) är INTE en barstol, hur lik den än är i formen",
  },
};

/** Undertypen en text (svarets rad om modellen, en adress, en titel) säger — eller null. Texten normaliseras först ("bänkhöjd" och "bankhojd" är samma ord). */
export function undertypI(text: string): Undertyp | null {
  const t = ` ${norm(text)} `;
  return (Object.keys(UNDERTYP) as Undertyp[]).find((u) => UNDERTYP[u].ord.test(t)) ?? null;
}

/** Säger texten uttryckligen att det är den VANLIGA varianten ("matstol", "dining chair") och inget om undertypen? Då är kandidaten inte undertypen, även om en källa längre bort nämner den. */
export function motsagerUndertyp(text: string, u: Undertyp): boolean {
  const t = ` ${norm(text)} `;
  return UNDERTYP[u].motsatt.test(t) && !UNDERTYP[u].ord.test(t);
}

/** Undertypens ord, för sökfrågan ("IKEA NORDVIKEN barstol"). */
export const undertypOrd = (u: Undertyp): string => UNDERTYP[u].svenska;
/** Familjen undertypen hör till. */
export const undertypFamilj = (u: Undertyp): Typfamilj => UNDERTYP[u].fam;

/**
 * Möbeltypen som FLEST ord i texten pekar på ("Fåtölj … armchair … Sits Impulse Armchair" mot två "sofas"), på svenska — eller null när ingen typ har minst två träffar och
 * ett tydligt övertag. AI-lägets svar nämner ibland typen först i källistorna, och ingen typ på kandidaten betyder att varken sidtypsregeln eller bildkontrollen gör något.
 */
export function rostaTyp(text: string): string | null {
  const t = ` ${norm(text)} `;
  const count = (re: RegExp) => (t.match(re) ?? []).length;
  const n: Record<Typfamilj, number> = {
    fatolj: count(/armchair|arm chair|fatolj|fauteuil|sessel|lounge chair|easy chair|loungestol|karmstol/g),
    soffa: count(/ sofas? |soffa|soffor|couch|canape| loveseats? |sectional| [2-5] ?(seater|seaters|seat) | [2-5] sits /g),
    stol: count(/ matstol|barstol|kontorsstol| dining chairs? | stool/g),
    bord: count(/ tables? | bord | soffbord|matbord/g),
    sang: count(/ bed | sang | mattress|madrass/g),
  };
  const sorted = (Object.entries(n) as Array<[Typfamilj, number]>).sort((a, b) => b[1] - a[1]);
  const [best, second] = sorted;
  return best[1] >= 2 && best[1] >= second[1] * 1.5 + 0.0001 ? SV_NAMN[best[0]] : null;
}

/** Säger texten att det här ÄR typen? */
export function bekraftarTyp(text: string, fam: Typfamilj): boolean {
  return familjerI(text).has(fam);
}

/** Säger texten att det är en ANNAN typ — och ingenting om den rätta? En sida om "Hugo sofa" är ingen sida om en fåtölj. */
export function motsagerTyp(text: string, fam: Typfamilj): boolean {
  const f = familjerI(text);
  return f.size > 0 && !f.has(fam);
}

/**
 * Svar: är bilden ett FOTO av rätt typ av möbel? true = ja, false = fel typ eller inget foto (ritning, logga, tygprov), null = gick inte att avgöra (anroparen behåller bilden).
 * `lokalAdress` är miniatyrens adress hos oss (`/api/kandidatbild/<sha1>.jpg`); den finns med för att ett test ska kunna svara per bild.
 */
export type BildtypKontroll = (miniatyr: Buffer, fam: Typfamilj, lokalAdress: string) => Promise<boolean | null>;

/**
 * Möbeltypen ur SÄLJARENS EGEN bild — den enda källa som alltid finns. AI-lägets svar nämner typen ibland bara i källistorna, och en kandidat utan typ stänger av både sidtypsregeln
 * och bildkontrollen (mätt: tre av fyra kort fick då kollektionssidans hörnsoffa). Ett billigt anrop med EN bild; svarar på svenska ("fåtölj") eller null när typen är annan/okänd.
 */
export async function typFranFoto(absPath: string): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const bytes = await readFile(absPath);
    const svar = await callGeminiStructured<{ typ: Typfamilj | "annat" }>({
      purpose: "mobeltyp_foto",
      systemPrompt: "Du ser ett foto av en möbel som säljs. Säg vilken sorts möbel den är.",
      userPrompt: "Vilken sorts möbel är det på fotot? fatolj = en sittmöbel för EN person, soffa = två eller fler sitsar, stol = stol/barstol/pall, bord, sang. Annat om inget av dem.",
      images: [{ mimeType: "image/jpeg", base64: bytes.toString("base64") }],
      responseSchema: {
        type: Type.OBJECT,
        properties: { typ: { type: Type.STRING, enum: ["fatolj", "soffa", "stol", "bord", "sang", "annat"] } },
        required: ["typ"],
      },
      resolution: "low",
      primaryTimeoutMs: 15_000,
      fallbackTimeoutMs: 10_000,
    });
    return svar.data.typ === "annat" ? null : SV_NAMN[svar.data.typ] ?? null;
  } catch (err) {
    console.warn(`[bildtyp] kunde inte läsa typen ur fotot: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    return null;
  }
}

const BESKRIVNING: Record<Typfamilj, string> = {
  fatolj: "fåtölj (en möbel med plats för EN person, med armstöd eller fristående — inte en soffa)",
  soffa: "soffa (två eller fler sitsar, hörnsoffa, modulsoffa, bäddsoffa)",
  stol: "stol, barstol eller pall",
  bord: "bord",
  sang: "säng",
};

const MOTIV = ["fatolj", "soffa", "stol", "bord", "sang", "annat"] as const;
const BILDSLAG = ["foto", "ritning", "annat"] as const;

/** Ett billigt anrop med EN miniatyr. Cachas av gemini.ts på bildens innehåll, så samma bild frågas aldrig två gånger. */
const fraga: BildtypKontroll = async (miniatyr, fam) => {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const svar = await callGeminiStructured<{ motiv: (typeof MOTIV)[number]; bild: (typeof BILDSLAG)[number]; helt: boolean }>({
      purpose: "kandidatbild_typ",
      systemPrompt:
        "Du granskar en produktbild i en möbelkatalog. Säg vilken sorts möbel som är bildens HUVUDMOTIV, det vill säga det som tar mest plats " +
        "och som bilden är tagen för. Är det ett vardagsrum med en hörnsoffa och en liten fåtölj längst bak är huvudmotivet soffan. " +
        'Svara "annat" som motiv om bilden är en logotyp, en text, ett tygprov, en planritning eller inget tydligt möbelmotiv. ' +
        'Bildslag: "foto" är ett fotografi eller en realistisk återgivning av möbeln; "ritning" är en teknisk ritning, ett måttdiagram eller en skiss med linjer och måttsiffror; "annat" är allt annat.',
      userPrompt: `Vilken sorts möbel är huvudmotivet? Vi letar efter: ${BESKRIVNING[fam]}.`,
      images: [{ mimeType: "image/jpeg", base64: miniatyr.toString("base64") }],
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          motiv: { type: Type.STRING, enum: [...MOTIV] },
          bild: { type: Type.STRING, enum: [...BILDSLAG] },
          helt: { type: Type.BOOLEAN, description: "true bara när HELA möbeln syns som huvudmotiv — inte avskuren av bildkanten, inte bara en kant eller ett hörn av den, inte skymd av annat." },
        },
        required: ["motiv", "bild", "helt"],
      },
      resolution: "low",
      primaryTimeoutMs: 12_000,
      fallbackTimeoutMs: 10_000,
    });
    return svar.data.motiv === fam && svar.data.bild === "foto" && svar.data.helt === true;
  } catch (err) {
    console.warn(`[bildtyp] kunde inte avgöra: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    return null;
  }
};

let kontroll: BildtypKontroll = fraga;
/** För tester: ett eget svar i stället för ett betalt anrop. `null` återställer. */
export function settBildtypKontroll(fn: BildtypKontroll | null): void {
  kontroll = fn ?? fraga;
}

/** Avgörandena hålls per lokal adress och familj: fyra kandidater som pekar på samma bild frågar en gång. */
const avgjorda = new Map<string, Promise<boolean | null>>();

/**
 * Visar den hämtade miniatyren (`/api/kandidatbild/<sha1>.jpg`) typen? Se BildtypKontroll för svaren.
 * Ett fel — filen saknas, kontrollen faller — är `null`: en kontroll som inte gick att göra får aldrig ta bort en bild.
 */
export function bildenVisarTypen(lokalAdress: string, fam: Typfamilj): Promise<boolean | null> {
  const nyckel = `${lokalAdress}|${fam}`;
  let p = avgjorda.get(nyckel);
  if (!p) {
    p = (async () => {
      try {
        const bytes = await readFile(path.join(kandidatbilderDir(), path.basename(lokalAdress)));
        return await kontroll(bytes, fam, lokalAdress);
      } catch {
        return null;
      }
    })();
    avgjorda.set(nyckel, p);
  }
  return p;
}

/** För tester: glöm gamla avgöranden, så att ett prov inte ärver ett annat provs svar. */
export function glomBildtypsavgoranden(): void {
  avgjorda.clear();
  katalogAvgjorda.clear();
  referensAvgjorda.clear();
}

/**
 * Är bilden ett KATALOGFOTO av möbeln — studiobild eller återförsäljarens produktfoto (neutral eller ren bakgrund, jämnt ljus, hela möbeln) — och inte en ögonblicksbild i någons
 * hem, källare eller begagnatannons? Referensbilden på ett modellkort ska visa hur modellen SER UT, och en källarbild av någon annans stol är ingen sådan (2026-11-02: kortet för
 * NORRNÄS fick en Tradera-annonsbild med en kartong i bakgrunden). Samma regler som typkontrollen i övrigt: motivet ska vara rätt typ, ett foto, och hela möbeln.
 * Går kontrollen inte att göra är svaret null — och en kontroll som inte gick att göra tar aldrig bort en bild.
 */
const fragaKatalog: BildtypKontroll = async (miniatyr, fam) => {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const svar = await callGeminiStructured<{ motiv: (typeof MOTIV)[number]; bild: (typeof BILDSLAG)[number]; helt: boolean; katalog: boolean }>({
      purpose: "kandidatbild_katalog",
      systemPrompt:
        "Du granskar en referensbild av en möbelmodell. Säg vilken sorts möbel som är bildens HUVUDMOTIV. " +
        'Bildslag: "foto" är ett fotografi eller en realistisk återgivning av möbeln; "ritning" är en teknisk ritning, ett måttdiagram eller en skiss; "annat" är allt annat. ' +
        "katalog är true bara när det är ett professionellt produktfoto: möbeln fristående mot en ren eller neutral bakgrund (vit, grå, enfärgad) eller i en uppställd, ljus " +
        "butiks- eller katalogmiljö, jämnt ljus och skarp. katalog är false för en ögonblicksbild som någon tagit hemma, i en källare, ett garage eller en butik, för en annons-bild " +
        "(andrahandsannons) med kartonger, golv, väggar eller andra saker i bakgrunden, och för ett rum där möbeln bara är en del av inredningen.",
      userPrompt: `Vilken sorts möbel är huvudmotivet? Vi letar efter: ${BESKRIVNING[fam]}.`,
      images: [{ mimeType: "image/jpeg", base64: miniatyr.toString("base64") }],
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          motiv: { type: Type.STRING, enum: [...MOTIV] },
          bild: { type: Type.STRING, enum: [...BILDSLAG] },
          helt: { type: Type.BOOLEAN, description: "true bara när HELA möbeln syns som huvudmotiv — inte avskuren av bildkanten, inte skymd av annat." },
          katalog: { type: Type.BOOLEAN },
        },
        required: ["motiv", "bild", "helt", "katalog"],
      },
      resolution: "low",
      primaryTimeoutMs: 12_000,
      fallbackTimeoutMs: 10_000,
    });
    return svar.data.motiv === fam && svar.data.bild === "foto" && svar.data.helt === true && svar.data.katalog === true;
  } catch (err) {
    console.warn(`[bildtyp] katalogkontrollen kunde inte avgöra: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    return null;
  }
};

let katalogKontroll: BildtypKontroll = fragaKatalog;
/** För tester: ett eget svar i stället för ett betalt anrop. `null` återställer. */
export function settKatalogKontroll(fn: BildtypKontroll | null): void {
  katalogKontroll = fn ?? fragaKatalog;
}

const katalogAvgjorda = new Map<string, Promise<boolean | null>>();

/**
 * ALLA KONTROLLER I ETT ANROP (2026-11-03). Typkontrollen (fraga) och katalogkontrollen (fragaKatalog) frågade samma sak av samma bild, den andra med en fråga till; de kördes dessutom
 * efter varandra. Katalogfrågan bär redan allt typkontrollen svarar (motiv, bildslag, hela möbeln), så ett anrop räcker, och med undertypen ("är det en BARSTOL?") som tredje svar.
 * Varje fält är true/false, eller null när kontrollen inte gick att göra — och en kontroll som inte gick att göra tar aldrig bort en bild.
 */
export interface Referensbedomning {
  /** Foto av rätt typ, hela möbeln. */
  typ: boolean | null;
  /** Dessutom ett katalogfoto (ren bakgrund, jämnt ljus). Bara true när `typ` är true. */
  katalog: boolean | null;
  /** Är möbeln den undertyp som efterfrågas? Null när ingen undertyp efterfrågas. */
  undertyp: boolean | null;
}
export type ReferensKontroll = (miniatyr: Buffer, fam: Typfamilj, undertyp: Undertyp | null, lokalAdress: string) => Promise<Referensbedomning>;

const OKAND_BEDOMNING: Referensbedomning = { typ: null, katalog: null, undertyp: null };

/**
 * Hur mycket modellen får tänka: LOOPA_REFERENS_THINKING=minimal|low (förval minimal), eller "av" för modellens eget förval.
 * Mätt 2026-11-03 på sex verkliga kandidatbilder (en matstol, två barstolar, en matstol i barstolsjobbet, ett katalogfoto, ett källarfoto), ett anrop i taget: modellens eget förval 3,3–6,2 s
 * (280–650 tänk-token), "low" 1,6–4,7 s, "minimal" 1,6–2,4 s — och samma, rätta svar i alla tre fallen (matstolen underkänd som barstol, källarfotot underkänt som katalogfoto).
 */
const REFERENS_THINKING = (): "minimal" | "low" | undefined => {
  const v = (process.env.LOOPA_REFERENS_THINKING ?? "minimal").toLowerCase();
  return v === "minimal" || v === "low" ? v : undefined;
};

const fragaReferens: ReferensKontroll = async (miniatyr, fam, undertyp) => {
  if (!process.env.GEMINI_API_KEY) return OKAND_BEDOMNING;
  try {
    const svar = await callGeminiStructured<{ motiv: (typeof MOTIV)[number]; bild: (typeof BILDSLAG)[number]; helt: boolean; katalog: boolean; undertyp_ratt?: boolean }>({
      purpose: "kandidatbild_referens",
      systemPrompt:
        "Du granskar en referensbild av en möbelmodell. Säg vilken sorts möbel som är bildens HUVUDMOTIV, det vill säga det som tar mest plats och som bilden är tagen för. " +
        'Svara "annat" som motiv om bilden är en logotyp, en text, ett tygprov, en planritning eller inget tydligt möbelmotiv. ' +
        'Bildslag: "foto" är ett fotografi eller en realistisk återgivning av möbeln; "ritning" är en teknisk ritning, ett måttdiagram eller en skiss; "annat" är allt annat. ' +
        "katalog är true bara när det är ett professionellt produktfoto: möbeln fristående mot en ren eller neutral bakgrund (vit, grå, enfärgad) eller i en uppställd, ljus " +
        "butiks- eller katalogmiljö, jämnt ljus och skarp. katalog är false för en ögonblicksbild som någon tagit hemma, i en källare, ett garage eller en butik, för en annons-bild " +
        "(andrahandsannons) med kartonger, golv, väggar eller andra saker i bakgrunden, och för ett rum där möbeln bara är en del av inredningen." +
        (undertyp ? ` undertyp_ratt är true bara när huvudmotivet är ${UNDERTYP[undertyp].beskrivning}; annars false.` : ""),
      userPrompt: `Vilken sorts möbel är huvudmotivet? Vi letar efter: ${BESKRIVNING[fam]}${undertyp ? `, närmare bestämt ${UNDERTYP[undertyp].svenska}` : ""}.`,
      images: [{ mimeType: "image/jpeg", base64: miniatyr.toString("base64") }],
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          motiv: { type: Type.STRING, enum: [...MOTIV] },
          bild: { type: Type.STRING, enum: [...BILDSLAG] },
          helt: { type: Type.BOOLEAN, description: "true bara när HELA möbeln syns som huvudmotiv — inte avskuren av bildkanten, inte skymd av annat." },
          katalog: { type: Type.BOOLEAN },
          ...(undertyp ? { undertyp_ratt: { type: Type.BOOLEAN } } : {}),
        },
        required: ["motiv", "bild", "helt", "katalog", ...(undertyp ? ["undertyp_ratt"] : [])],
      },
      resolution: "low",
      thinkingLevel: REFERENS_THINKING(),
      primaryTimeoutMs: 12_000,
      fallbackTimeoutMs: 10_000,
    });
    const typ = svar.data.motiv === fam && svar.data.bild === "foto" && svar.data.helt === true;
    return { typ, katalog: typ && svar.data.katalog === true, undertyp: undertyp ? svar.data.undertyp_ratt === true : null };
  } catch (err) {
    console.warn(`[bildtyp] referenskontrollen kunde inte avgöra: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    return OKAND_BEDOMNING;
  }
};

let referensKontroll: ReferensKontroll = fragaReferens;
/** För tester: ett eget svar i stället för ett betalt anrop. `null` återställer. */
export function settReferensKontroll(fn: ReferensKontroll | null): void {
  referensKontroll = fn ?? fragaReferens;
}

const referensAvgjorda = new Map<string, Promise<Referensbedomning>>();

/** Alla kontroller av den hämtade miniatyren (`/api/kandidatbild/<sha1>.jpg`) i ETT anrop. Se Referensbedomning. Ett fel är "okänt" på alla tre. */
export function bedomReferensbild(lokalAdress: string, fam: Typfamilj, undertyp: Undertyp | null): Promise<Referensbedomning> {
  const nyckel = `${lokalAdress}|${fam}|${undertyp ?? ""}`;
  let p = referensAvgjorda.get(nyckel);
  if (!p) {
    p = (async () => {
      try {
        const bytes = await readFile(path.join(kandidatbilderDir(), path.basename(lokalAdress)));
        let svar = await referensKontroll(bytes, fam, undertyp, lokalAdress);
        // Ett tillfälligt fel (tidsgräns, belastning: 24 kontroller samtidigt vid fyra förslag) ger "okänt" för just den bilden, och då kunde en sämre bild längre ner i rangordningen vinna av en slump
        // (NORDVIKEN 2026-11-07: katalogbilden på plats 2 godkändes tre gånger av tre när jag körde om den, men kortet fick plats 4). Ett omförsök efter en kort paus innan vi ger upp.
        if (svar.typ === null && svar.katalog === null && process.env.GEMINI_API_KEY) {
          await new Promise((r) => setTimeout(r, 800));
          svar = await referensKontroll(bytes, fam, undertyp, lokalAdress);
        }
        // "Okänt" är inget omdöme: det får inte stanna i cachen resten av serverns liv, så nästa körning prövar bilden igen.
        if (svar.typ === null && svar.katalog === null) referensAvgjorda.delete(nyckel);
        return svar;
      } catch {
        referensAvgjorda.delete(nyckel);
        return OKAND_BEDOMNING;
      }
    })();
    referensAvgjorda.set(nyckel, p);
  }
  return p;
}

/** Är den hämtade miniatyren (`/api/kandidatbild/<sha1>.jpg`) ett katalogfoto av typen? Se fragaKatalog. Ett fel är `null`. */
export function bildenArKatalogfoto(lokalAdress: string, fam: Typfamilj): Promise<boolean | null> {
  const nyckel = `${lokalAdress}|${fam}`;
  let p = katalogAvgjorda.get(nyckel);
  if (!p) {
    p = (async () => {
      try {
        const bytes = await readFile(path.join(kandidatbilderDir(), path.basename(lokalAdress)));
        return await katalogKontroll(bytes, fam, lokalAdress);
      } catch {
        return null;
      }
    })();
    katalogAvgjorda.set(nyckel, p);
  }
  return p;
}

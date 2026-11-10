import { bekraftarTyp, familjerI, motsagerTyp, motsagerUndertyp, typfamilj, undertypI, type Undertyp } from "./candidateType.js";
import { dugerSomProduktbild } from "./kandidatbild.js";

/**
 * Referensbilder ur Googles bildsök (appens webbvy), för modellväljarens kort.
 *
 * 2026-10-29, fältprov: bildjakten (candidateImages.ts) letar sidor via sökmotorer och hinner inte inom sina 40 sekunder — tre av fyra förslag stod med "Din bild" och
 * säljaren väntade en halv minut på det. Googles bildsök vet vad en Sits Impulse-fåtölj ser ut som: ett enda anrop (2–3 s i webbvyn) ger sextio miniatyrer, var och en
 * med titeln på sidan den kommer från ("Impulse Fåtölj | Folkhemmet", "Sits Stella Armchair | Cookes Furniture").
 *
 * Webbvyn lämnar bara rådata (adress, titel, storlek). Vad som visas bestämmer VI: titeln ska nämna modellen och inte säga en annan möbeltyp, och varje vald bild prövas av
 * samma fotokontroll som bildjakten (candidateType.ts). Webbvyn är aldrig en sanning om något.
 */

export interface GoogleImageRow {
  src: string;
  alt: string;
  w: number;
  h: number;
  /**
   * Sajtens namn ("IKEA", "Vision of Home") och sidan bilden sitter på. Bara SerpApi-flödet skickar dem; skalets rader har dem inte, och då gäller reglerna nedan som förut.
   */
  source?: string;
  page?: string;
}

const norm = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
};

/**
 * Prisjämförare: deras bild är en tredje parts och kan vara vilken möbel som helst under en rätt titel. PriceRunner "IKEA NORDVIKEN Barstol (1 butiker) se bästa priserna" (2026-11-07) hade två
 * bruna läderbarstolar av ett annat märke på bilden, och blev kortets bild trots att 29 av 40 träffar kom från IKEA självt. Utesluts när träffens sida är känd.
 */
const PRISJAMFORARE = /\b(pricerunner|prisjakt|kelkoo|shopzilla|idealo|pricespy|jamforpris|compare)\b/;
const PRISJAMFORARE_TITEL = /\bse basta priserna\b|\bjamfor priser\b|\bbasta pris\b|\b\d+ butiker?\b/;

/** Så många miniatyrer per modell som hämtas hem och prövas. Fler kostar tid och betalda bildkontroller, färre ger fler tomma kort. */
export const MAX_ROWS_PER_MODEL = 6;
/**
 * Med sajten känd (SerpApi): upp till tio rader klarar reglerna och går vidare till det jämförande valet (referensbild.ts), som tittar på de fem bästa. Ett brett urval behövs: med fyra rader hade Brandon
 * två kvar och inte den grå fåtöljen som finns längre ned i träfflistan. Hämtningen är ett par sekunder, valet ETT anrop per modell.
 */
export const MAX_ROWS_PER_MODEL_MED_KALLA = 10;

/**
 * Titeln kommer från en andrahandsmarknad, ett anslagstavle- eller ett bildklippsidor ("6 köksstolar Norrnäs IKEA | Köp på Tradera"): bilden är någon annans ögonblicksbild, inte modellens
 * produktfoto. Aldrig förstahandsval som referensbild; se chooseReferenceIndex.
 */
const MARKNADSPLATS = /\b(tradera|blocket|facebook|marketplace|ebay|vinted|pinterest|olx|gumtree|craigslist|sellpy|auctionet|bukowskis|second hand|secondhand|begagnad|begagnat|used|till salu|kop pa|saljes)\b/;
export const arMarknadsplats = (alt: string): boolean => MARKNADSPLATS.test(norm(alt));

export interface ReferenceRow {
  src: string;
  /** Titeln pekar på en andrahandsmarknad: se MARKNADSPLATS. */
  marketplace: boolean;
}

/**
 * Raderna som kan bli den här modellens kort-bild, bästa först: miniatyrens adresser, var och en märkt med om titeln kommer från en andrahandsmarknad.
 *
 * - Titeln ska nämna modellen som eget ord. En träff på "Quattro" som ligger bland sextio andra är inte Quattro om titeln säger något annat.
 * - Titeln får inte säga en ANNAN typ än kandidatens ("Sits Quattro Sofa" för en fåtölj), men får gärna säga flera ("Sofas, Armchairs and Corner Groups": då avgör bildkontrollen).
 * - Märket i titeln och typen i titeln ger försteg. Ordningen i övrigt är Googles egen. En andrahandsmarknads titel hamnar sist (och är märkt så): Googles första träff på NORRNÄS var
 *   en Tradera-annons med en källarbild.
 * - Bara http(s)-adresser (miniatyrerna ligger hos gstatic), inga dubbletter, och storlek som duger som produktbild.
 */
export function pickReferenceRows(rows: unknown, model: string, brand: string, productType: string | null, undertyp: Undertyp | null = null): ReferenceRow[] {
  if (!Array.isArray(rows)) return [];
  const m = ` ${norm(model)} `;
  if (m.trim() === "") return [];
  const b = norm(brand);
  const fam = typfamilj(productType);
  const seen = new Set<string>();
  const scored: Array<{ src: string; score: number; order: number; marketplace: boolean }> = [];
  const asRows = rows as Array<Partial<GoogleImageRow>>;
  const pageOf = (r: Partial<GoogleImageRow>): string => (typeof r?.page === "string" ? r.page : "");
  const sourceOf = (r: Partial<GoogleImageRow>): string => (typeof r?.source === "string" ? r.source : "");
  // Ett tidigare "bevisad återförsäljare"-undantag (en sajt som i samma sökning visat märket någon annanstans fick låna ut rader utan märke) är BORTTAGET 2026-11-09: Vision of Home sålde "Nova Fåtölj | Swedese"
  // och fick räknas som Sits-återförsäljare. Märket måste stå på RADEN (titel, adress eller sajt); återförsäljare som inte säger det tas av steg A (produktlänken) och B (sökning).
  asRows.forEach((r, order) => {
    const src = typeof r?.src === "string" ? r.src.trim() : "";
    const alt = typeof r?.alt === "string" ? r.alt : "";
    if (!/^https?:\/\//i.test(src) || seen.has(src)) return;
    if (!` ${norm(alt)} `.includes(m)) return;
    if (fam && motsagerTyp(alt, fam)) return;
    // Undertypen ("barstol"): en titel som uttryckligen säger den VANLIGA varianten ("NORDVIKEN matstol") är en annan möbel med samma namn.
    if (undertyp && motsagerUndertyp(alt, undertyp)) return;
    const w = Number(r?.w) || 0;
    const h = Number(r?.h) || 0;
    if (w > 0 && h > 0 && !dugerSomProduktbild(w, h)) return;
    // Titeln nämner inte märket ("Impulse Fåtölj | Folkhemmet"): då måste den åtminstone säga typen, annars är "Hugo" lika gärna ett annat märkes Hugo.
    const medMarke = !!b && ` ${norm(alt)} `.includes(` ${b} `);
    if (b && fam && !medMarke && !bekraftarTyp(alt, fam)) return;
    // Sajt och sida känd (SerpApi): vem som visar bilden avgör. Utan dem (skalets rader) gäller bara reglerna ovan.
    const page = pageOf(r);
    const source = sourceOf(r);
    const harKalla = !!(page || source);
    const host = hostOf(page);
    const kalla = norm(`${source} ${host}`);
    let kallpoang = 0;
    if (harKalla) {
      if (PRISJAMFORARE.test(kalla) || PRISJAMFORARE_TITEL.test(norm(alt))) return;
      const markeIAdress = !!b && ` ${norm(page)} `.includes(` ${b} `);
      const markeSomSajt = !!b && ` ${norm(source)} `.includes(` ${b} `);
      // Ingen bild hellre än fel bild: utan märket i titeln, i adressen eller som sajt kan bilden vara ett annat märkes möbel med samma namn (Colin: Newport, Nova: Swedese, Palma: Offecct).
      if (b && !medMarke && !markeIAdress && !markeSomSajt) return;
      // Märkets egen sajt (ikea.com, sits.eu) får ett litet försprång, MINDRE än märket i titeln (10): en kollektionssida hos tillverkaren har ofta en närbild eller en miljöbild, medan en
      // återförsäljares produktrad ("Jenny Fåtölj Bred - Sits") visar just den möbeln (mätt på sparade sökningar 2026-11-07: ett försprång på 12 gav Jenny en närbild på ett ben).
      if (b && host && host.replace(/[^a-z0-9]/g, "").includes(b.replace(/ /g, ""))) kallpoang += 4;
      // En kollektionssida ("Felix furniture collection: details, dimensions, accessories") visar många möbler och detaljer: sits.eu valdes för Palma, Brandon och Colin och gav en soffa, en kuddnärbild och en soffa.
      if (/\b(collection|kollektion)\b/.test(norm(alt))) kallpoang -= 8;
    }
    seen.add(src);
    let score = kallpoang;
    // Märket i titeln väger tyngst: "Quattro fåtölj" utan märke gav en orange vilstol av ett annat märke, medan Sits egna Quattro-sidor låg lägre i listan. Rader utan märke är reserv.
    if (medMarke) score += 10;
    if (fam && bekraftarTyp(alt, fam)) score += 3;
    // Titeln säger undertypen ("NORDVIKEN barstol"): bästa tänkbara bevis före bildkontrollen, och en rad som bara säger "stol" ligger efter.
    if (undertyp && undertypI(alt) === undertyp) score += 6;
    // En titel som nämner flera typer ("Sofas, Armchairs and Corner Groups") är en kollektionssida: bilden kan vara vilken som helst av dem, så den som säger EN typ går före.
    if (familjerI(alt).size > 1) score -= 3;
    const marketplace = arMarknadsplats(alt) || (harKalla && MARKNADSPLATS.test(kalla));
    if (marketplace) score -= 20;
    scored.push({ src, score, order, marketplace });
  });
  scored.sort((x, y) => y.score - x.score || x.order - y.order);
  const max = asRows.some((r) => pageOf(r) || sourceOf(r)) ? MAX_ROWS_PER_MODEL_MED_KALLA : MAX_ROWS_PER_MODEL;
  return scored.slice(0, max).map((s) => ({ src: s.src, marketplace: s.marketplace }));
}

/** Samma urval som adresslista (för anropare som inte bryr sig om märkningen). */
export function pickImageRows(rows: unknown, model: string, brand: string, productType: string | null, undertyp: Undertyp | null = null): string[] {
  return pickReferenceRows(rows, model, brand, productType, undertyp).map((r) => r.src);
}

/** Vad vi vet om en hämtad rad när bilden ska väljas. `typ`, `katalog` och `undertyp`: kontrollernas svar (true/false), eller null när kontrollen inte gick att göra. */
export interface ReferenceCheck {
  /** Bilden gick att hämta hem. */
  local: boolean;
  marketplace: boolean;
  typ: boolean | null;
  katalog: boolean | null;
  /** Är möbeln den undertyp som efterfrågas ("barstol")? Utelämnad/null när ingen undertyp efterfrågas eller kontrollen inte gick att göra. */
  undertyp?: boolean | null;
}

/**
 * Vilken rad som blir kortets referensbild, eller -1 (ingen bild hellre än fel bild). I ordning:
 *   1. det första KATALOGFOTOT av rätt typ (hela möbeln, ren bakgrund) — oavsett vilken sajt titeln nämner;
 *   2. annars den första rad vars bild klarade typkontrollen och som INTE kommer från en andrahandsmarknad (katalogkontrollen kunde inte göras, eller sa nej men ingen bättre fanns);
 *   3. annars ingen. En andrahandsannons ögonblicksbild som enda träff är inget kortet ska visa som "så här ser modellen ut".
 * En rad vars typkontroll sa nej (false) eller som inte gick att hämta räknas aldrig. Ren funktion.
 */
export function chooseReferenceIndex(checks: ReferenceCheck[]): number {
  const katalog = checks.findIndex((c) => duger(c) && c.katalog === true);
  if (katalog >= 0) return katalog;
  return checks.findIndex((c) => duger(c) && !c.marketplace);
}

/** En rad som inte är fel typ och inte fel undertyp (en matstol för en barstol) och som gick att hämta. En kontroll som inte gick att göra (null) räknas inte som nej. */
const duger = (c: ReferenceCheck): boolean => c.local && c.typ !== false && c.undertyp !== false;

/**
 * Samma val som chooseReferenceIndex, men utan att vänta på alla rader i onödan: raderna bedöms parallellt (varje element är en redan påbörjad bedömning), och den FÖRSTA raden i
 * rangordningen som är ett godkänt katalogfoto av rätt typ och undertyp vinner så snart just dess svar finns — de efter den behöver ingen vänta på. Finns inget sådant efter att alla svarat
 * gäller chooseReferenceIndex (reserven). Valet blir alltså detsamma, bara snabbare. En bedömning får aldrig avvisas (kasta): den ska svara med "okänt" i stället.
 */
export async function valjReferensbild(bedomningar: Array<Promise<ReferenceCheck>>): Promise<number> {
  for (let i = 0; i < bedomningar.length; i++) {
    const c = await bedomningar[i];
    if (duger(c) && c.katalog === true) return i;
  }
  return chooseReferenceIndex(await Promise.all(bedomningar));
}

/**
 * Undertypen kandidaten MENAR, läst ur dess EGNA ord: svarets rader om modellen ("1. NORDVIKEN (Barstol / Bänkhöjd stol)"), förklaringen, produktsidans adress ("…/nordviken-barstol-svart-…").
 * Aldrig ur svarets allmänna inledning: ett alternativ som STEFAN (en matstol) ska inte bli en barstol för att säljarens stol är det. Saknas ord om undertypen i kandidatens egna rader är den
 * okänd (null) och bara familjen gäller.
 */
export function undertypForKandidat(answer: string, model: string, texts: Array<string | null | undefined>, sourceUrl?: string | null): Undertyp | null {
  const own: string[] = [];
  // Produktsidans adress räknas bara om modellens eget namn står i den: ett alternativ får ibland en annan modells sida som `sourceUrl` ("…/nordviken-barstol-…" för STEFAN), och den sidan säger inget om STEFAN.
  const flat = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
  if (sourceUrl && flat(model) && flat(sourceUrl).includes(flat(model))) texts = [...texts, sourceUrl];
  const escaped = model.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (escaped) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu");
    // Raderna som nämner modellen (högst tre, utan länkrader), plus raden under en rubrik: AI-läget skriver ofta typen på raden efter namnet.
    const lines = answer.split("\n");
    lines.forEach((l, i) => {
      if (own.length >= 3 || !re.test(l) || /^\s*(länk|link|https?:)/i.test(l)) return;
      own.push(l);
      if (l.length < 80 && lines[i + 1]) own.push(lines[i + 1]);
    });
  }
  return undertypI([...own, ...texts.filter((t): t is string => !!t)].join(" \n "));
}

/**
 * Adminens rättelser av en annons.
 *
 * VARFÖR DE INTE SKRIVS IN I JOBBET. Allt en annons visar — titel, kategori, mått, färg, material,
 * bild — är HÄRLETT ur besiktningen och annonsgeneratorn (butik/normalize.ts). Härledningen körs om:
 * när en skada rättas räknas betyget om, när tolkningen lagas läses attributen på nytt, och
 * `syncFromJobs` bygger varan igen vid varje varv. En rättelse skriven in i `job.json` hade därför
 * levt tills nästa omräkning och sedan tyst försvunnit — vilket är värre än att inte kunna rätta
 * alls, för då tror den som rättade att det är gjort.
 *
 * Rättelserna ligger därför BREDVID, i ett eget lager med Loopa-ID som nyckel, och läggs på sist i
 * projektionen. Härledningen får ändras hur den vill; det en människa uttryckligen skrivit står kvar.
 *
 * VARJE FÄLT ÄR TRESTÄLLT: saknas (använd härledningen), satt (använd det här), eller uttryckligen
 * tomt. Det sista är inte samma som saknas — "den här möbeln har ingen känd färg" är ett beslut, och
 * ett fält som inte kan uttrycka det tvingar den som rättar att skriva något osant i stället.
 *
 * SPÅRET FÖLJER MED. Vem som ändrade och när står på posten, för att en annons som avviker från
 * besiktningen ska gå att förklara ett halvår senare.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";
import { loopaIdFor } from "../loopaId.js";
import type { ConditionJob } from "../types.js";
import type { Dimensions, Product } from "./types.js";

const BUTIK_DIR = () => process.env.BUTIK_DATA_DIR?.trim() || path.join(DATA_DIR, "butik");
const FILE = () => path.join(BUTIK_DIR(), "overstyrningar.json");

/**
 * Ett fält som en människa satt.
 *
 * `null` betyder "uttryckligen tomt", inte "osatt" — se filens topp. Ett fält som saknas i objektet
 * är osatt.
 */
export interface Overstyrning {
  id: string;
  title?: string | null;
  /** Annonstexten. Syns på Tradera och i säljarens annonsvy; butiksrutnätet visar den inte. */
  description?: string | null;
  brand?: string | null;
  model?: string | null;
  categorySlug?: string | null;
  color?: string | null;
  material?: string | null;
  widthMm?: number | null;
  depthMm?: number | null;
  heightMm?: number | null;
  seatHeightMm?: number | null;
  /** Nypriset som stryks över. Sätts när generatorn gissat fel eller inte hittade något. */
  retailPriceSek?: number | null;
  /**
   * Omslagsbilden.
   *
   * En adress och inte en uppladdning: bilderna som finns är jobbets egna (urklippet på
   * /api/cards/:id/cover) och tillverkarens katalogbilder, och båda har redan en adress. En egen
   * uppladdningsväg hade betytt filhantering, format och beskärning — en annan uppgift än den här.
   */
  imageUrl?: string | null;
  /** Fritext till nästa människa som undrar varför annonsen ser ut som den gör. */
  note?: string | null;
  updatedAt: string;
  /** Adminens användar-id. Aldrig e-posten — den står i katalogen och behöver inte kopieras hit. */
  updatedBy: string | null;
}

/** Fälten som får sättas utifrån. Allt annat i kroppen ignoreras. */
export const OVERSTYRBARA = [
  "title",
  "description",
  "brand",
  "model",
  "categorySlug",
  "color",
  "material",
  "widthMm",
  "depthMm",
  "heightMm",
  "seatHeightMm",
  "retailPriceSek",
  "imageUrl",
  "note",
] as const;

export type OverstyrbartFalt = (typeof OVERSTYRBARA)[number];

// ---------------------------------------------------------------------------
// Lagret
// ---------------------------------------------------------------------------

let cache: Map<string, Overstyrning> | null = null;
let kedja: Promise<unknown> = Promise.resolve();

async function ladda(): Promise<Map<string, Overstyrning>> {
  if (cache) return cache;
  try {
    const rows = JSON.parse(await readFile(FILE(), "utf-8")) as Overstyrning[];
    cache = new Map(rows.filter((r) => r?.id).map((r) => [r.id, r]));
  } catch {
    cache = new Map();
  }
  return cache;
}

export async function alla(): Promise<Map<string, Overstyrning>> {
  return new Map(await ladda());
}

export async function hamta(id: string): Promise<Overstyrning | null> {
  return (await ladda()).get(id) ?? null;
}

/**
 * Skriver en rättelse och lämnar tillbaka hela posten.
 *
 * `undefined` i patchen betyder "rör inte", `null` betyder "sätt till tomt". Skillnaden är hela
 * poängen med lagret och får inte plattas till här.
 */
export async function satt(
  id: string,
  patch: Partial<Record<OverstyrbartFalt, string | number | null>>,
  updatedBy: string | null,
): Promise<Overstyrning> {
  const gjort = kedja.then(async () => {
    const karta = await ladda();
    const nu: Overstyrning = { ...(karta.get(id) ?? { id }), id, updatedAt: new Date().toISOString(), updatedBy };
    for (const falt of OVERSTYRBARA) {
      if (!(falt in patch)) continue;
      const varde = patch[falt];
      (nu as unknown as Record<string, unknown>)[falt] = varde === "" ? null : varde;
    }
    karta.set(id, nu);
    await mkdir(BUTIK_DIR(), { recursive: true });
    await writeFile(FILE(), JSON.stringify([...karta.values()], null, 2), "utf-8");
    return nu;
  });
  kedja = gjort.catch(() => undefined);
  return gjort;
}

/**
 * Tar bort NAMNGIVNA fält ur rättelsen. Resten står kvar.
 *
 * Utan den här vägen är det tredje tillståndet en enkelriktad gata: ett fält går att sätta till
 * uttryckligen tomt, men aldrig tillbaka till osatt — det enda sättet ut var `tabort`, som kastar
 * varje annan rättelse på annonsen med sig. Den som rättat rubriken och sedan tömt färgen fick välja
 * mellan fel färg och att skriva om rubriken.
 *
 * Blir posten tom på faktiska fält försvinner den helt: en rättelse som inte rättar något ska inte
 * ligga kvar och märka annonsen som "Rättad".
 */
export async function taBortFalt(
  id: string,
  falt: readonly OverstyrbartFalt[],
  updatedBy: string | null,
): Promise<Overstyrning | null> {
  const gjort = kedja.then(async () => {
    const karta = await ladda();
    const nu = karta.get(id);
    if (!nu) return null;
    for (const f of falt) delete (nu as unknown as Record<string, unknown>)[f];

    const kvar = OVERSTYRBARA.some((f) => harSatt(nu, f));
    if (kvar) {
      nu.updatedAt = new Date().toISOString();
      nu.updatedBy = updatedBy;
      karta.set(id, nu);
    } else {
      karta.delete(id);
    }
    await mkdir(BUTIK_DIR(), { recursive: true });
    await writeFile(FILE(), JSON.stringify([...karta.values()], null, 2), "utf-8");
    return kvar ? nu : null;
  });
  kedja = gjort.catch(() => null);
  return gjort;
}

/** Tar bort en rättelse helt — annonsen faller tillbaka på besiktningen igen. */
export async function tabort(id: string): Promise<boolean> {
  const gjort = kedja.then(async () => {
    const karta = await ladda();
    if (!karta.delete(id)) return false;
    await mkdir(BUTIK_DIR(), { recursive: true });
    await writeFile(FILE(), JSON.stringify([...karta.values()], null, 2), "utf-8");
    return true;
  });
  kedja = gjort.catch(() => false);
  return gjort;
}

/** Bara för tester. */
export function nollstall(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Påläggningen
// ---------------------------------------------------------------------------

/** Satt = fältet finns i posten OCH är inte undefined. Null räknas som satt. */
function harSatt(o: Overstyrning, falt: OverstyrbartFalt): boolean {
  return falt in o && o[falt] !== undefined;
}

function valj<T>(o: Overstyrning, falt: OverstyrbartFalt, harlett: T): T {
  return harSatt(o, falt) ? (o[falt] as unknown as T) : harlett;
}

/**
 * Rättelserna pålagda på den härledda varan.
 *
 * SIST I KEDJAN med flit: normalize.ts har redan gjort sitt bästa ur underlaget, och det här är den
 * enda punkt där en människas ord går före maskinens. Anropas i inventory.ts, som är den enda vägen
 * från jobb till butiksvara.
 */
export function tillampaPaProdukt(product: Product, o: Overstyrning | undefined | null): Product {
  if (!o) return product;
  const dimensions: Dimensions = {
    widthMm: valj(o, "widthMm", product.dimensions.widthMm),
    depthMm: valj(o, "depthMm", product.dimensions.depthMm),
    heightMm: valj(o, "heightMm", product.dimensions.heightMm),
    seatHeightMm: valj(o, "seatHeightMm", product.dimensions.seatHeightMm),
    /**
     * Ett mått en människa skrivit in är inte en uppskattning.
     *
     * `estimated` styr om kortet skriver "ca" och om måttfiltret vågar lova att möbeln får plats.
     * Har någon mätt möbeln och skrivit talet ska flaggan falla — annars fortsätter butiken hedga ett
     * mått som inte längre är gissat.
     */
    estimated:
      product.dimensions.estimated &&
      !harSatt(o, "widthMm") &&
      !harSatt(o, "depthMm") &&
      !harSatt(o, "heightMm"),
  };
  return {
    ...product,
    title: valj(o, "title", product.title) || product.title,
    brand: valj(o, "brand", product.brand),
    model: valj(o, "model", product.model),
    categorySlug: valj(o, "categorySlug", product.categorySlug) || product.categorySlug,
    color: valj(o, "color", product.color),
    material: valj(o, "material", product.material),
    retailPriceSek: valj(o, "retailPriceSek", product.retailPriceSek),
    imageUrl: valj(o, "imageUrl", product.imageUrl),
    dimensions,
  };
}

/**
 * Annonstexten med rättelserna pålagda.
 *
 * Skild från produkten för att texten läses på andra ställen än rutnätet: Tradera-annonsen
 * (integrations/tradera/tradera.ts), Blocket-utkastet och säljarens egen annonsvy. Returnerar null
 * när jobbet inte har någon genererad annons alls — då finns ingen text att rätta.
 */
export function annonstext(
  job: ConditionJob,
  o: Overstyrning | undefined | null,
): { title: string; description: string; conditionText: string } | null {
  const listing = job.result?.listing?.result ?? job.listing?.result ?? job.pendingListing?.result ?? null;
  if (!listing) return null;
  return {
    title: (o && harSatt(o, "title") ? (o.title ?? "") : "") || listing.listing.title,
    description: (o && harSatt(o, "description") ? (o.description ?? "") : "") || listing.listing.description,
    conditionText: listing.listing.conditionText,
  };
}

/**
 * Jobbet med rättad annonstext, för de kanaler texten faktiskt går ut i.
 *
 * VARFÖR EN KOPIA. Tradera-annonsen och Blocket-utkastet byggs ur `job` av adContent.ts, som är
 * synkron och läser texten på tre möjliga ställen. Att göra den asynkron för att slå upp en rättelse
 * hade spridit sig genom hela annonsbyggaren; att skriva rättelsen in i jobbet hade förlorat den vid
 * nästa omräkning (se filens topp). En kopia vid porten löser båda: byggaren ser en text, och
 * jobbet på disk är orört.
 *
 * Kopian är grund och följer bara vägen ner till texten — bildlistorna och skadorna delas med
 * originalet. Den får därför ALDRIG sparas; den är ett underlag för en utskrift, inte ett jobb.
 */
export async function medRattelser(job: ConditionJob): Promise<ConditionJob> {
  const o = await hamta(loopaIdFor(job.id));
  if (!o || (!harSatt(o, "title") && !harSatt(o, "description"))) return job;

  const platser = ["result", "listing", "pendingListing"] as const;
  for (const plats of platser) {
    const barare = plats === "result" ? job.result?.listing : job[plats];
    const listing = barare?.result;
    if (!listing) continue;
    const text = {
      ...listing.listing,
      title: harSatt(o, "title") && o.title ? o.title : listing.listing.title,
      description: harSatt(o, "description") && o.description ? o.description : listing.listing.description,
    };
    const rattad = { ...barare, result: { ...listing, listing: text } };
    return plats === "result"
      ? { ...job, result: { ...job.result!, listing: rattad } }
      : { ...job, [plats]: rattad };
  }
  return job;
}

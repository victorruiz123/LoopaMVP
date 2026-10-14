/**
 * Provkörning av redigeringsrobotarna på en riktig annons, startad av en admin.
 *
 * Robotarna (blocket/redigera.ts, facebook/redigera.ts) är byggda och testade mot attrapper. Det enda
 * som avgör om de klickar rätt hos Blocket och Facebook är att låta dem göra det — på en annons, med en
 * ändring ingen köpare tar illa upp: ETT ORD I BESKRIVNINGEN BYTS MOT EN SYNONYM ("fin" → "snygg").
 *
 * Därför finns den här vägen, och därför ser den ut som den gör:
 *
 *  - ÄNDRINGEN ÄR RIKTIG. Den sparas som en rättelse i rättelselagret, precis som när en admin skriver
 *    om beskrivningen — så butiken, Blocket och Facebook visar samma text efteråt.
 *  - INGENTING TAS BORT. Blocket och Facebook redigeras på plats. TRADERA RÖRS INTE: där är vägen att
 *    ta ner annonsen och lägga upp den igen, och det är inte en provkörning. Tradera behåller alltså
 *    originalordet tills annonsen ändras på riktigt.
 *  - SKARPT FÖR JUST DEN HÄR ANNONSEN. Brytarna BLOCKET_REDIGERA/FACEBOOK_REDIGERA rörs inte; robotarna
 *    får `skarp: true` för det här anropet. Den automatiska uppdateringen (annonsUppdatering.ts) är
 *    fortsatt avstängd tills den slås på.
 *  - ÅNGRA LÄGGER TILLBAKA ORDET, med samma robotar. Värdet före provet sparas på jobbet.
 *  - KÖRS I SERVERN, inte i ett skript bredvid: jobben och rättelserna hålls i serverns minne, och en
 *    andra process hade skrivit över dem eller blivit överskriven.
 */

import { getJob, persist } from "../jobStore.js";
import { loopaIdFor } from "../loopaId.js";
import type { ConditionJob } from "../types.js";
import type { KanalUtfall } from "./annonsUppdatering.js";

/**
 * Ord som kan bytas utan att annonsen säger något annat. Båda riktningarna står inte med: provet
 * ska byta ETT ord, och ångra går genom det sparade värdet, inte genom listan baklänges.
 */
export const SYNONYMER: ReadonlyArray<readonly [string, string]> = [
  ["fin", "snygg"],
  ["fint", "snyggt"],
  ["fina", "snygga"],
  ["stabil", "stadig"],
  ["stabilt", "stadigt"],
  ["bekväm", "skön"],
  ["bekvämt", "skönt"],
  ["perfekt", "utmärkt"],
  ["vacker", "snygg"],
  ["vackra", "snygga"],
  ["rymlig", "stor"],
  ["praktisk", "smidig"],
  ["robust", "stadig"],
  ["tidlös", "klassisk"],
  ["helt", "fullt"],
  ["gott", "bra"],
  ["mycket", "väldigt"],
];

const BOKSTAV = "A-Za-zÅÄÖåäöÉéÜü";

export interface OrdByte {
  fran: string;
  till: string;
  /** Meningen runt ordet, för panelen. */
  fore: string;
  efter: string;
  text: string;
}

/** Första ordet i texten som har en synonym, med versalen bevarad. Null = inget att byta. */
export function synonymByte(text: string): OrdByte | null {
  let bast: { index: number; fran: string; till: string } | null = null;
  for (const [ord, syn] of SYNONYMER) {
    const m = new RegExp(`(?<![${BOKSTAV}])${ord}(?![${BOKSTAV}])`, "i").exec(text);
    if (m && (!bast || m.index < bast.index)) {
      const funnet = m[0];
      const till = funnet[0] === funnet[0].toUpperCase() ? syn[0].toUpperCase() + syn.slice(1) : syn;
      bast = { index: m.index, fran: funnet, till };
    }
  }
  if (!bast) return null;
  const ny = text.slice(0, bast.index) + bast.till + text.slice(bast.index + bast.fran.length);
  const fran = Math.max(0, bast.index - 60);
  return {
    fran: bast.fran,
    till: bast.till,
    fore: text.slice(fran, bast.index + bast.fran.length + 60),
    efter: ny.slice(fran, bast.index + bast.till.length + 60),
    text: ny,
  };
}

export interface ProvRedigering {
  status: "pagar" | "klar";
  riktning: "andra" | "angra";
  /** Fältet i rättelselagret som bär texten: den handskrivna annonsen om en sådan finns, annars stycket. */
  falt: "description" | "adText";
  fran: string;
  till: string;
  /** Rättelsens värde FÖRE provet. Null = fältet var inte rättat. Det ångra lägger tillbaka. */
  tidigare: string | null;
  av: string | null;
  startad: string;
  klar: string | null;
  kanaler: Partial<Record<"blocket" | "facebook", KanalUtfall & { at: string }>>;
}

export class ProvFel extends Error {}

const pagar = new Set<string>();

/** Vad ett prov skulle göra, utan att göra det. */
export async function provForslag(job: ConditionJob): Promise<{
  byte: OrdByte | null;
  falt: "description" | "adText";
  blocket: boolean;
  facebook: boolean;
  tradera: boolean;
}> {
  const overrides = await import("../butik/overrides.js");
  const o = await overrides.hamta(loopaIdFor(job.id));
  const falt = o?.adText?.trim() ? "adText" : "description";
  const text = falt === "adText" ? o!.adText! : (overrides.annonstext(job, o)?.description ?? "");
  const { allMarketplace, allGroupPublications } = await import("./facebook/store.js");
  const id = loopaIdFor(job.id);
  const facebook =
    (await allMarketplace()).some((p) => p.listingId === id && p.status === "PUBLISHED") ||
    (await allGroupPublications()).some((p) => p.listingId === id && p.status === "PUBLISHED");
  return {
    byte: synonymByte(text),
    falt,
    blocket: job.blocket?.status === "published",
    facebook,
    tradera: job.tradera?.status === "published",
  };
}

/**
 * Startar provet (eller ångrar det). Sparar texten direkt och kör robotarna i bakgrunden — de tar
 * minuter, längre än en förfrågan får hänga. Panelen läser utfallet ur `job.provRedigering`.
 */
export async function startaProv(job: ConditionJob, riktning: "andra" | "angra", adminId: string | null): Promise<ProvRedigering> {
  if (pagar.has(job.id)) throw new ProvFel("En provkörning pågår redan för annonsen.");
  const overrides = await import("../butik/overrides.js");
  const id = loopaIdFor(job.id);
  const nu = new Date().toISOString();
  let prov: ProvRedigering;

  if (riktning === "andra") {
    const forslag = await provForslag(job);
    if (!forslag.blocket && !forslag.facebook) throw new ProvFel("Annonsen ligger varken på Blocket eller Facebook.");
    if (!forslag.byte) throw new ProvFel("Beskrivningen har inget ord med en synonym att byta till. Välj en annan annons.");
    if (job.provRedigering?.riktning === "andra") throw new ProvFel("Annonsen har redan ett prov. Ångra det först.");
    const o = await overrides.hamta(id);
    const tidigare = forslag.falt === "adText" ? (o?.adText ?? null) : (o?.description ?? null);
    await overrides.satt(id, { [forslag.falt]: forslag.byte.text }, adminId);
    prov = { status: "pagar", riktning, falt: forslag.falt, fran: forslag.byte.fran, till: forslag.byte.till, tidigare, av: adminId, startad: nu, klar: null, kanaler: {} };
  } else {
    const fore = job.provRedigering;
    if (!fore || fore.riktning !== "andra") throw new ProvFel("Det finns inget prov att ångra.");
    if (fore.tidigare === null) await overrides.taBortFalt(id, [fore.falt], adminId);
    else await overrides.satt(id, { [fore.falt]: fore.tidigare }, adminId);
    prov = { ...fore, status: "pagar", riktning, fran: fore.till, till: fore.fran, av: adminId, startad: nu, klar: null, kanaler: {} };
  }

  // Butikens index hålls i minnet; den nya texten ska synas där direkt, som efter en adminrättelse.
  const { invalidate } = await import("../butik/inventory.js");
  invalidate();
  job.provRedigering = prov;
  await persist(job);
  pagar.add(job.id);
  void korRobotarna(job.id).finally(() => pagar.delete(job.id));
  return prov;
}

async function korRobotarna(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job?.provRedigering) return;
  const prov = job.provRedigering;
  const kor: Array<["blocket" | "facebook", () => Promise<KanalUtfall>]> = [
    ["blocket", async () => (await import("./blocket/redigera.js")).redigeraBlocketAnnons(job, undefined, { skarp: true })],
    ["facebook", async () => (await import("./facebook/redigera.js")).redigeraFacebook(job, undefined, { skarp: true })],
  ];
  for (const [kanal, fn] of kor) {
    let utfall: KanalUtfall;
    try {
      utfall = await fn();
    } catch (err) {
      utfall = { status: "fel", detalj: err instanceof Error ? err.message : String(err) };
    }
    if (utfall.status !== "ej_uppe") prov.kanaler[kanal] = { ...utfall, at: new Date().toISOString() };
    console.info(`[prov-redigering] ${jobId.slice(0, 8)} ${prov.riktning} ${kanal}: ${utfall.status} — ${utfall.detalj.slice(0, 200)}`);
    await persist(job);
  }
  prov.status = "klar";
  prov.klar = new Date().toISOString();
  await persist(job);
}

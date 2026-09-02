/**
 * Tömningar: efterfrågan mot ett lager som ännu inte finns.
 *
 * En kontorstömning eller ett dödsbo är känt DAGAR INNAN någon sett möblerna. Det som finns då är en
 * lista över vad som förväntas — "ca 20 kontorsstolar, 4 skrivbord, en soffgrupp" — och den listan
 * är tillräckligt för att säga något till den som väntat i tre veckor på just en kontorsstol.
 *
 * MEN VI VET INGENTING ÄN, och brevet måste bära det. Skillnaden mellan de här två meningarna är
 * hela skillnaden mellan förtroende och besvikelse:
 *
 *   "Din stol kommer på torsdag."                        — ett påstående vi inte kan hålla
 *   "En tömning nästa vecka innehåller troligen din      — ett löfte om ett BESKED, som vi kan hålla
 *    stol. Du får besked på torsdag."
 *
 * Därför bär varje tömningsnotis ett datum för BESKEDET, inte för möbeln. Löftet är att vi hör av
 * oss igen — inte att något visst dyker upp.
 *
 * MATCHNINGEN ÄR GROV MED FLIT. Före besiktningen finns inga mått, inga betyg och inga priser; att
 * pröva en efterlysnings hårda gränser mot en rad som lyder "ca 20 kontorsstolar" hade gett noll
 * träffar varje gång. Här matchas kategori och märke, och ingenting annat.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";
import { categoryLabel, categoryNoun } from "../butik/catalog.js";
import * as store from "./store.js";
import { deepLink, lastOf, push, sendLetter } from "./notify.js";

export interface ExpectedItem {
  categorySlug: string;
  brand: string | null;
  /** Ungefärligt antal. Bär ordet "ca" i texten — ingen har räknat än. */
  count: number;
  note: string | null;
}

export interface Clearance {
  id: string;
  name: string;
  /** När vi hämtar. Möblerna finns inte hos oss innan dess. */
  pickupDate: string;
  /**
   * När köparen får veta om deras möbel var med. ALLTID satt, och det är det datum breven lovar.
   * Förvalet är dagen efter hämtningen: besiktningen tar en dag.
   */
  verdictDate: string;
  expected: ExpectedItem[];
  createdAt: string;
  /** Sant när tömningen körts och beskeden gått ut. Hindrar ett andra varv brev. */
  settled: boolean;
}

const DIR = () => process.env.EFTERLYSNING_DATA_DIR?.trim() || path.join(DATA_DIR, "efterlysningar");
const FILE = () => path.join(DIR(), "tomningar.json");

let cache: Clearance[] | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function load(): Promise<Clearance[]> {
  if (cache) return cache;
  try { cache = JSON.parse(await readFile(FILE(), "utf-8")) as Clearance[]; } catch { cache = []; }
  return cache;
}

async function flush(): Promise<void> {
  await mkdir(DIR(), { recursive: true });
  await writeFile(FILE(), JSON.stringify(await load(), null, 2), "utf-8");
}

export async function create(input: {
  name: string;
  pickupDate: string;
  verdictDate?: string;
  expected: ExpectedItem[];
}): Promise<Clearance> {
  return serialize(async () => {
    const list = await load();
    const row: Clearance = {
      id: randomUUID(),
      name: input.name,
      pickupDate: input.pickupDate,
      // Dagen efter hämtningen: besiktningen tar en dag, och beskedet ska inte lovas tidigare än
      // det kan ges.
      verdictDate: input.verdictDate ?? new Date(new Date(input.pickupDate).getTime() + 86_400_000).toISOString().slice(0, 10),
      expected: input.expected,
      createdAt: new Date().toISOString(),
      settled: false,
    };
    list.push(row);
    await flush();
    return row;
  });
}

export async function list(): Promise<Clearance[]> {
  return [...(await load())].sort((a, b) => (a.pickupDate < b.pickupDate ? -1 : 1));
}

export async function settle(id: string): Promise<void> {
  return serialize(async () => {
    const row = (await load()).find((c) => c.id === id);
    if (!row) return;
    row.settled = true;
    await flush();
  });
}

/**
 * Passar en förväntad rad en efterlysning?
 *
 * GROVT: kategori och märke, ingenting annat. Före besiktningen finns inga mått, inga betyg och
 * inga priser att pröva mot — och en efterlysning med "max 210 cm bred" ska inte gå miste om
 * beskedet bara för att ingen mätt stolen än.
 *
 * Märket prövas bara när BÅDA har ett: en tömningsrad utan märke kan innehålla vad som helst, och
 * att fälla den mot en efterlysning som vill ha String vore att gissa åt köparen i fel riktning.
 */
function fits(item: ExpectedItem, wanted: { categorySlug?: string | null; brands?: string[] | null }): boolean {
  if (wanted.categorySlug && wanted.categorySlug !== item.categorySlug) return false;
  if (wanted.brands?.length && item.brand) {
    const want = wanted.brands.map((b) => b.toLowerCase());
    if (!want.includes(item.brand.toLowerCase())) return false;
  }
  return true;
}

export interface ClearanceNotice {
  efterlysningId: string;
  clearanceId: string;
  item: ExpectedItem;
}

/**
 * Matchar en tömning mot öppna efterlysningar och lovar ett besked.
 *
 * EN NOTIS PER TÖMNING OCH EFTERLYSNING. Den som väntar på en kontorsstol ska inte få fyra brev för
 * att listan råkar innehålla fyra rader som passar.
 */
export async function notifyForClearance(c: Clearance, now = Date.now()): Promise<ClearanceNotice[]> {
  if (c.settled) return [];
  const open = (await store.open()).filter((e) => e.userId);
  const sent: ClearanceNotice[] = [];

  for (const e of open) {
    const hit = c.expected.find((item) => fits(item, e.filter));
    if (!hit) continue;
    // Ett brev per tömning. `lastOf` bär inte tömnings-id, så nyckeln blir efterlysningen plus
    // sorten — och en andra tömning samma vecka ger därför inget andra brev till samma köpare.
    const already = await lastOf(e.id, "match");
    if (already && already.body.includes(c.name)) continue;

    /**
     * TVÅ FORMER, för två olika meningar.
     *
     * "din stol" är ental — det är EN möbel köparen väntar på. "ca 22 stolar" är plural — det är en
     * hög. Ett ord för båda gav antingen "din stolar" eller "ca 22 st stol", och båda hann gå ut i
     * skarp körning innan den här raden fanns.
     */
    const ental = categoryNoun(hit.categorySlug);
    // Ett stycke är inte en hög: "ca 1 förvaring" blir "1 hylla eller byrå".
    const flertal = hit.count === 1 ? ental : categoryLabel(hit.categorySlug).toLowerCase();
    const title = `En tömning nästa vecka innehåller troligen din ${ental}`;
    const body = [
      `Du efterlyste: ${e.summary}`,
      "",
      `Vi hämtar ${c.name} den ${c.pickupDate}. Enligt listan ska den innehålla ca ${hit.count} ${flertal}${hit.brand ? ` (${hit.brand})` : ""}.`,
      "",
      // Meningen som gör brevet hållbart: vi lovar ett BESKED, inte en möbel.
      `Vi vet inte skicket förrän vi sett dem. Du får besked den ${c.verdictDate} — då vet vi om något passar dig.`,
      "",
      `Din efterlysning: ${deepLink(e)}`,
    ].join("\n");

    await push({
      userId: e.userId!, efterlysningId: e.id, kind: "match",
      title, body, href: deepLink(e), productIds: [], source: "loopa_incoming",
    });
    if (e.email) await sendLetter({ to: e.email, subject: title, body, kind: "tomning" });
    // Räknas in i pulsens siffror: en genomgången tömning ÄR arbete gjort åt köparen.
    await store.recordSweep(e.id, 0, 1);
    sent.push({ efterlysningId: e.id, clearanceId: c.id, item: hit });
    void now;
  }
  return sent;
}

/** Kör alla tömningar som ännu inte hämtats. Idempotent per köpare — se notifyForClearance. */
export async function runClearanceMatching(now = Date.now()): Promise<number> {
  const kommande = (await list()).filter((c) => !c.settled && new Date(c.pickupDate).getTime() >= now - 86_400_000);
  let n = 0;
  for (const c of kommande) n += (await notifyForClearance(c, now)).length;
  return n;
}

export function reset(): void { cache = null; }

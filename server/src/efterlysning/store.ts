/**
 * Efterlysningarnas lager.
 *
 * FILER, som bevakningarna den ersätter — inte Supabase som butiken och affärerna. Skälet är att
 * ingenting här är en transaktion: två personer tävlar aldrig om samma efterlysning, och det finns
 * inget läge där ett läs-kontrollera-skriv kan tappa någons pengar. Butikens villkorade skrivningar
 * finns för dubbelförsäljningen; att kopiera dem hit hade varit maskineri utan ett problem att lösa.
 *
 * Skrivningarna serialiseras ändå. Sveparen och en HTTP-begäran kan skriva samtidigt, och två
 * `writeFile` mot samma fil i samma millisekund ger en halv fil.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";
import { EXPIRY_DAYS, type Efterlysning, type Match } from "./types.js";

const DIR = () => process.env.EFTERLYSNING_DATA_DIR?.trim() || path.join(DATA_DIR, "efterlysningar");
const FILE = () => path.join(DIR(), "efterlysningar.json");
const MATCH_FILE = () => path.join(DIR(), "matchningar.json");

let cache: Map<string, Efterlysning> | null = null;
let matchCache: Match[] | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function load(): Promise<Map<string, Efterlysning>> {
  if (cache) return cache;
  try {
    const rows = JSON.parse(await readFile(FILE(), "utf-8")) as Efterlysning[];
    cache = new Map(rows.map((e) => [e.id, e]));
  } catch {
    cache = new Map();
  }
  return cache;
}

async function loadMatches(): Promise<Match[]> {
  if (matchCache) return matchCache;
  try {
    matchCache = JSON.parse(await readFile(MATCH_FILE(), "utf-8")) as Match[];
  } catch {
    matchCache = [];
  }
  return matchCache;
}

async function flush(): Promise<void> {
  await mkdir(DIR(), { recursive: true });
  await writeFile(FILE(), JSON.stringify([...(await load()).values()], null, 2), "utf-8");
}

async function flushMatches(): Promise<void> {
  await mkdir(DIR(), { recursive: true });
  await writeFile(MATCH_FILE(), JSON.stringify(await loadMatches(), null, 2), "utf-8");
}

export type NewEfterlysning = Omit<
  Efterlysning,
  "id" | "createdAt" | "updatedAt" | "expiresAt" | "notifiedProductIds" | "scannedCount" | "scannedClearances" | "lastSweptAt" | "state"
> & { state?: Efterlysning["state"] };

export async function create(input: NewEfterlysning): Promise<Efterlysning> {
  return serialize(async () => {
    const map = await load();
    const now = new Date();
    const row: Efterlysning = {
      ...input,
      id: randomUUID(),
      state: input.state ?? "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + EXPIRY_DAYS * 86_400_000).toISOString(),
      notifiedProductIds: [],
      scannedCount: 0,
      scannedClearances: 0,
      lastSweptAt: null,
    };
    map.set(row.id, row);
    await flush();
    return row;
  });
}

export async function get(id: string): Promise<Efterlysning | null> {
  return (await load()).get(id) ?? null;
}

export async function forUser(userId: string): Promise<Efterlysning[]> {
  return [...(await load()).values()]
    .filter((e) => e.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Alla som fortfarande bevakas. Sveparen, väggen och efterfrågepanelen läser den här. */
export async function open(): Promise<Efterlysning[]> {
  return [...(await load()).values()].filter((e) => e.state === "active");
}

export async function all(): Promise<Efterlysning[]> {
  return [...(await load()).values()];
}

export async function update(id: string, patch: Partial<Efterlysning>): Promise<Efterlysning | null> {
  return serialize(async () => {
    const map = await load();
    const current = map.get(id);
    if (!current) return null;
    const next: Efterlysning = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    map.set(id, next);
    await flush();
    return next;
  });
}

export async function remove(id: string, userId: string): Promise<boolean> {
  return serialize(async () => {
    const map = await load();
    const row = map.get(id);
    // Ägarkontrollen ligger HÄR och inte bara i vägen: en radering är oåterkallelig, och den sortens
    // kontroll ska sitta så nära skrivningen som möjligt.
    if (!row || row.userId !== userId) return false;
    map.delete(id);
    await flush();
    return true;
  });
}

/** Förnyar 90 dagar framåt från nu. Ett klick ur påminnelsen, inte en ny efterlysning. */
export async function renew(id: string): Promise<Efterlysning | null> {
  return update(id, {
    state: "active",
    expiresAt: new Date(Date.now() + EXPIRY_DAYS * 86_400_000).toISOString(),
  });
}

/**
 * Räknar upp vad vi läst igenom åt en efterlysning.
 *
 * Pulsens siffror kommer HÄRIFRÅN och ingen annanstans. "Vi har bevakat 214 nya objekt" måste vara
 * 214 objekt vi faktiskt läst, annars är den meningen påhittad — och en påhittad siffra i ett brev
 * som ska bygga förtroende är värre än inget brev.
 */
export async function recordSweep(id: string, objects: number, clearances = 0): Promise<void> {
  const current = await get(id);
  if (!current) return;
  await update(id, {
    scannedCount: current.scannedCount + objects,
    scannedClearances: current.scannedClearances + clearances,
    lastSweptAt: new Date().toISOString(),
  });
}

export async function markNotified(id: string, productIds: string[]): Promise<void> {
  const current = await get(id);
  if (!current) return;
  const seen = new Set([...current.notifiedProductIds, ...productIds]);
  await update(id, { notifiedProductIds: [...seen] });
}

// ---------------------------------------------------------------------------
// Matchningar
// ---------------------------------------------------------------------------

export async function logMatches(rows: Omit<Match, "id" | "foundAt" | "purchasedAt">[]): Promise<Match[]> {
  return serialize(async () => {
    const list = await loadMatches();
    const seen = new Set(list.map((m) => `${m.efterlysningId}:${m.productId}`));
    const added: Match[] = [];
    for (const r of rows) {
      const key = `${r.efterlysningId}:${r.productId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row: Match = { ...r, id: randomUUID(), foundAt: new Date().toISOString(), purchasedAt: null };
      list.push(row);
      added.push(row);
    }
    if (added.length) await flushMatches();
    return added;
  });
}

export async function matchesFor(efterlysningId: string): Promise<Match[]> {
  return (await loadMatches()).filter((m) => m.efterlysningId === efterlysningId);
}

export async function allMatches(): Promise<Match[]> {
  return [...(await loadMatches())];
}

export async function markPurchased(efterlysningId: string, productId: string): Promise<void> {
  return serialize(async () => {
    const list = await loadMatches();
    const row = list.find((m) => m.efterlysningId === efterlysningId && m.productId === productId);
    if (!row) return;
    row.purchasedAt = new Date().toISOString();
    await flushMatches();
  });
}

/** Bara för tester. */
export function reset(): void {
  cache = null;
  matchCache = null;
}

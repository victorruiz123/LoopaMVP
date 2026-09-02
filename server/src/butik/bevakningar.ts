/**
 * Bevakningar: sparade sökningar som hör av sig när något matchande dyker upp.
 *
 * TVÅ SYFTEN, och det andra är det som gör dem värda att bygga i en MVP. Det första är uppenbart:
 * en köpare som inte hittade sin soffa i dag ska inte behöva komma tillbaka och leta varje vecka.
 * Det andra är att varje bevakning är en EFTERFRÅGAN skriven av en människa — "3-sitssoffa, max
 * 4000 kr, max 210 cm bred" — och den listan är det bästa underlaget som finns för vad
 * säljverktyget ska be folk filma. Därför sparas de, och därför sparas de även när de matchar.
 *
 * UTSKICKET ÄR INTE PÅKOPPLAT. Det finns ingen e-postavsändare i projektet — varken paket, nyckel
 * eller avsändaradress — och att välja en åt hela produkten är inte butikens beslut. Träffarna köas
 * därför och loggas, och `pendingNotifications()` är kroken den dag en avsändare finns. Alternativet,
 * att låtsas skicka, hade varit värre: en bevakning som tyst inte hör av sig är sämre än ingen.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";
import { fold } from "./catalog.js";
import type { Product } from "./types.js";

export interface Bevakning {
  id: string;
  userId: string;
  email: string | null;
  categorySlug: string | null;
  brand: string | null;
  maxPriceSek: number | null;
  maxWidthMm: number | null;
  maxDepthMm: number | null;
  maxHeightMm: number | null;
  createdAt: string;
  /** Produkt-ID:n vi redan hört av oss om, så samma möbel inte mejlas två gånger. */
  notifiedProductIds: string[];
}

/** En träff som väntar på att skickas. */
export interface PendingNotification {
  bevakning: Bevakning;
  product: Product;
}

const FILE = () =>
  path.join(process.env.BUTIK_DATA_DIR?.trim() || path.join(DATA_DIR, "butik"), "bevakningar.json");

let cache: Map<string, Bevakning> | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function load(): Promise<Map<string, Bevakning>> {
  if (cache) return cache;
  try {
    const rows = JSON.parse(await readFile(FILE(), "utf-8")) as Bevakning[];
    cache = new Map(rows.map((b) => [b.id, b]));
  } catch {
    cache = new Map();
  }
  return cache;
}

async function flush(): Promise<void> {
  const rows = [...(await load()).values()];
  await mkdir(path.dirname(FILE()), { recursive: true });
  await writeFile(FILE(), JSON.stringify(rows, null, 2), "utf-8");
}

export async function createBevakning(input: Omit<Bevakning, "id" | "createdAt" | "notifiedProductIds">): Promise<Bevakning> {
  return serialize(async () => {
    const map = await load();
    /**
     * En identisk bevakning skapas inte två gånger.
     *
     * Knappen står i varje tomt läge, och den som klickar i två kategorier och backar tillbaka ska
     * inte få tre mejl om samma soffa.
     */
    const existing = [...map.values()].find(
      (b) =>
        b.userId === input.userId &&
        b.categorySlug === input.categorySlug &&
        fold(b.brand ?? "") === fold(input.brand ?? "") &&
        b.maxPriceSek === input.maxPriceSek &&
        b.maxWidthMm === input.maxWidthMm &&
        b.maxDepthMm === input.maxDepthMm &&
        b.maxHeightMm === input.maxHeightMm,
    );
    if (existing) return existing;

    const bevakning: Bevakning = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      notifiedProductIds: [],
    };
    map.set(bevakning.id, bevakning);
    await flush();
    return bevakning;
  });
}

export async function listBevakningar(userId: string): Promise<Bevakning[]> {
  return [...(await load()).values()].filter((b) => b.userId === userId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function deleteBevakning(id: string, userId: string): Promise<boolean> {
  return serialize(async () => {
    const map = await load();
    const b = map.get(id);
    if (!b || b.userId !== userId) return false;
    map.delete(id);
    await flush();
    return true;
  });
}

/** Alla bevakningar — för matchningen. */
export async function allBevakningar(): Promise<Bevakning[]> {
  return [...(await load()).values()];
}

/**
 * Matchar en bevakning mot en möbel.
 *
 * BARA LOOPA-VAROR. En bevakning lovar "vi hör av oss när något dyker upp", och det löftet gäller
 * det vi själva lägger ut — Traderas utbud ändras hela tiden utan att vi gjort något, och att mejla
 * om varje ny auktion i Stockholm hade varit spam, inte en bevakning.
 *
 * MÅTT SOM SAKNAS DISKVALIFICERAR. Har köparen skrivit "max 210 cm bred" och möbeln saknar bredd,
 * matchar den inte. Ett mejl om en möbel som kanske inte får plats är ett mejl som inte hjälper.
 */
export function matches(b: Bevakning, p: Product): boolean {
  if (p.source !== "loopa") return false;
  if (p.state !== "live") return false;
  if (b.categorySlug && p.categorySlug !== b.categorySlug) return false;
  if (b.brand && fold(p.brand ?? "") !== fold(b.brand)) return false;
  if (b.maxPriceSek !== null && (p.priceSek === null || p.priceSek > b.maxPriceSek)) return false;
  const within = (max: number | null, actual: number | null) => max === null || (actual !== null && actual <= max);
  if (!within(b.maxWidthMm, p.dimensions.widthMm)) return false;
  if (!within(b.maxDepthMm, p.dimensions.depthMm)) return false;
  if (!within(b.maxHeightMm, p.dimensions.heightMm)) return false;
  return true;
}

/**
 * Träffar som ännu inte skickats, och märker dem som skickade.
 *
 * Märkningen sker HÄR och inte hos avsändaren, med flit: en avsändare som kraschar mitt i ska hellre
 * ha missat ett mejl än skicka samma mejl varje minut i evighet. Den dagen ett riktigt utskick finns
 * kan den här funktionen få ett `dryRun`-läge om avvägningen ska gå åt andra hållet.
 */
export async function takePendingNotifications(products: Product[]): Promise<PendingNotification[]> {
  return serialize(async () => {
    const map = await load();
    const pending: PendingNotification[] = [];
    let changed = false;

    for (const bevakning of map.values()) {
      for (const product of products) {
        if (bevakning.notifiedProductIds.includes(product.id)) continue;
        if (!matches(bevakning, product)) continue;
        pending.push({ bevakning, product });
        bevakning.notifiedProductIds.push(product.id);
        changed = true;
      }
    }
    if (changed) await flush();
    return pending;
  });
}

/**
 * Kroken där e-post ska kopplas in.
 *
 * Loggar i dag. Den som lägger till en avsändare byter ut kroppen här och rör inget annat — hela
 * matchningen, avdubbleringen och lagringen ovanför är redan på plats och testad.
 */
export async function notify(pending: PendingNotification[]): Promise<void> {
  for (const { bevakning, product } of pending) {
    console.info(
      `[bevakning] TRÄFF att mejla: ${bevakning.email ?? bevakning.userId} — "${product.title}" ` +
        `${product.priceSek} kr (${product.id}). Ingen avsändare konfigurerad, så inget mejl gick iväg.`,
    );
  }
}

/** Bara för tester. */
export function resetBevakningar(): void {
  cache = null;
}

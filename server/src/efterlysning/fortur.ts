/**
 * Förturen: köparen som efterlyst något får se det innan det går ut publikt.
 *
 * LIGGER UTANFÖR TILLSTÅNDSMASKINEN, och det är hela poängen med konstruktionen.
 *
 * Den uppenbara lösningen vore `draft -> reserved` i butikens ALLOWED_TRANSITIONS. Den är fel av två
 * skäl. Det första: `reserved` är det farliga läget som dubbelförsäljningsskyddet vaktar — det nås
 * både från vår kassa och från Tradera-pollningen, och att låta en tredje väg in dit vidgar precis
 * den yta `claimForSale` finns för att hålla smal. Det andra, och viktigare: kravet är att förturen
 * ALDRIG får blockera pipelinen. En reservation i tillståndsmaskinen är en regel någon måste komma
 * ihåg att lyfta; en post vid sidan om som grindar publiceringen är en regel som lyfter sig själv
 * när klockan går ut. Skillnaden mellan att minnas och att inte behöva minnas är hela skillnaden.
 *
 * Möbelns tillstånd är alltså `draft` hela tiden. Förturen säger bara: "publicera inte ännu, och
 * visa den för den här köparen under tiden".
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";

/** Hur länge en förtur håller. Config; ett dygn är nog för ett beslut och kort nog att inte stoppa lagret. */
export const FORTUR_HOURS = Number(process.env.EFTERLYSNING_FORTUR_HOURS ?? 24);

export interface Fortur {
  id: string;
  productId: string;
  efterlysningId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  /** Satt när köparen agerat, eller när klockan gick ut. En avslutad förtur grindar ingenting. */
  releasedAt: string | null;
  releasedReason: "expired" | "acted" | "manual" | null;
}

const DIR = () => process.env.EFTERLYSNING_DATA_DIR?.trim() || path.join(DATA_DIR, "efterlysningar");
const FILE = () => path.join(DIR(), "fortur.json");

let cache: Fortur[] | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function load(): Promise<Fortur[]> {
  if (cache) return cache;
  try { cache = JSON.parse(await readFile(FILE(), "utf-8")) as Fortur[]; } catch { cache = []; }
  return cache;
}

async function flush(): Promise<void> {
  await mkdir(DIR(), { recursive: true });
  await writeFile(FILE(), JSON.stringify(await load(), null, 2), "utf-8");
}

/**
 * Är förturen levande just nu?
 *
 * Prövar klockan vid VARJE läsning i stället för att lita på att någon städat. Det är det som gör
 * att en utgången förtur inte kan blockera publiceringen även om städjobbet aldrig kört: en process
 * som dött mitt i, en server som startats om, ett intervall som aldrig hann — inget av det kan
 * hålla en möbel gömd, för frågan "gäller den?" räknas om varje gång den ställs.
 */
function alive(f: Fortur, now: number): boolean {
  return f.releasedAt === null && new Date(f.expiresAt).getTime() > now;
}

export async function reserve(input: {
  productId: string;
  efterlysningId: string;
  userId: string;
  hours?: number;
}): Promise<Fortur | null> {
  return serialize(async () => {
    const list = await load();
    const now = Date.now();
    // En möbel har en förtur i taget. Två köpare som båda får "du får se den först" är ett löfte vi
    // brutit mot en av dem.
    if (list.some((f) => f.productId === input.productId && alive(f, now))) return null;

    const hours = input.hours ?? FORTUR_HOURS;
    const row: Fortur = {
      id: randomUUID(),
      productId: input.productId,
      efterlysningId: input.efterlysningId,
      userId: input.userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + hours * 3600_000).toISOString(),
      releasedAt: null,
      releasedReason: null,
    };
    list.push(row);
    await flush();
    return row;
  });
}

/** Den levande förturen för en möbel, eller null. */
export async function holdFor(productId: string, now = Date.now()): Promise<Fortur | null> {
  return (await load()).find((f) => f.productId === productId && alive(f, now)) ?? null;
}

/**
 * Grinden. Sant = möbeln ska INTE publiceras ännu.
 *
 * Läses av `syncFromJobs` före varje publicering. Faller uppslagningen svarar den `false` — en
 * trasig förturslista får hellre publicera för tidigt än stoppa lagret, eftersom det första är en
 * missad artighet och det andra är en möbel som aldrig kommer ut.
 */
export async function publishBlocked(productId: string, now = Date.now()): Promise<boolean> {
  try {
    return (await holdFor(productId, now)) !== null;
  } catch {
    return false;
  }
}

export async function release(id: string, reason: Fortur["releasedReason"]): Promise<void> {
  return serialize(async () => {
    const list = await load();
    const row = list.find((f) => f.id === id);
    if (!row || row.releasedAt) return;
    row.releasedAt = new Date().toISOString();
    row.releasedReason = reason;
    await flush();
  });
}

/**
 * Städar utgångna. En ren bokföringsåtgärd — grinden släpper redan av sig själv (se `alive`).
 *
 * Att den ändå finns är för att `releasedReason` ska stå rätt i historiken: en förtur som gick ut
 * ska gå att skilja från en köparen agerade på.
 */
export async function expireDue(now = Date.now()): Promise<number> {
  return serialize(async () => {
    const list = await load();
    let n = 0;
    for (const f of list) {
      if (f.releasedAt === null && new Date(f.expiresAt).getTime() <= now) {
        f.releasedAt = new Date(now).toISOString();
        f.releasedReason = "expired";
        n += 1;
      }
    }
    if (n) await flush();
    return n;
  });
}

export async function forUser(userId: string, now = Date.now()): Promise<Fortur[]> {
  return (await load()).filter((f) => f.userId === userId && alive(f, now));
}

export async function all(): Promise<Fortur[]> {
  return [...(await load())];
}

export function reset(): void { cache = null; }

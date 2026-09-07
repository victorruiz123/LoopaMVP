/**
 * Notiserna: kön, inkorgen och reglerna för när vi får höra av oss.
 *
 * IN-APP-INKORGEN ÄR PRIMÄR KANAL. Den når mottagaren oavsett om en e-postleverantör är vald, och
 * den är sann på ett sätt ett brev inte är: den ligger kvar, den går att läsa om, och den kan peka
 * rakt in i den efterlysning som orsakade den. Brevet är en påminnelse om inkorgen.
 *
 * FYRA REGLER, och var och en finns för att en bevakning ska vara värd att ha kvar:
 *
 *   1. STRIKT FÖR NOTISER. Bara exakta träffar väcker någon. En nära-träff är ett förslag att titta
 *      på när man ändå tittar — inte något att avbryta en middag för. De samlas till veckans brev.
 *   2. VÅRT EGET DIREKT, TRADERA SAMLAT. En Loopa-vara kan säljas i natt och förtjänar ett besked
 *      nu; Traderas utbud rör sig hela tiden och skulle ge ett brev i timmen. Max ett per dygn och
 *      efterlysning därifrån.
 *   3. SAMMA MÖBEL EN GÅNG. `notifiedProductIds` bär det, och märkningen sker när notisen SKAPAS —
 *      inte när brevet går. En avsändare som kraschar ska hellre ha missat ett brev än skicka samma
 *      brev varje minut.
 *   4. VARJE NOTIS BÄR SIN EFTERLYSNING. Länken går till /kop/mina-efterlysningar#<id>, aldrig till
 *      en naken produktsida: mottagaren ska veta VARFÖR de fick brevet.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";
import { sender, type Letter } from "../notify/outbox.js";
import * as store from "./store.js";
import type { Candidate } from "./match.js";
import type { Efterlysning, MatchSource } from "./types.js";
import { nabar } from "./types.js";
import { emit } from "./analytics.js";

export type NoticeKind = "match" | "fortur" | "puls" | "deadline" | "fornyelse";

export interface Notice {
  id: string;
  userId: string;
  efterlysningId: string;
  kind: NoticeKind;
  title: string;
  body: string;
  /** Djuplänk MED efterlysningens sammanhang. Se regel 4. */
  href: string;
  createdAt: string;
  readAt: string | null;
  /** Vad brevet handlade om, för analysen. Tomt för puls och deadline. */
  productIds: string[];
  source: MatchSource | null;
}

const DIR = () => process.env.EFTERLYSNING_DATA_DIR?.trim() || path.join(DATA_DIR, "efterlysningar");
const FILE = () => path.join(DIR(), "notiser.json");

let cache: Notice[] | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function load(): Promise<Notice[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE(), "utf-8")) as Notice[];
  } catch {
    cache = [];
  }
  return cache;
}

async function flush(): Promise<void> {
  await mkdir(DIR(), { recursive: true });
  await writeFile(FILE(), JSON.stringify(await load(), null, 2), "utf-8");
}

export async function push(n: Omit<Notice, "id" | "createdAt" | "readAt">): Promise<Notice> {
  return serialize(async () => {
    const list = await load();
    const row: Notice = { ...n, id: randomUUID(), createdAt: new Date().toISOString(), readAt: null };
    list.push(row);
    await flush();
    return row;
  });
}

export async function inbox(userId: string, limit = 50): Promise<Notice[]> {
  return (await load())
    .filter((n) => n.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

export async function markRead(userId: string, ids: string[]): Promise<void> {
  return serialize(async () => {
    const list = await load();
    const now = new Date().toISOString();
    let changed = false;
    for (const n of list) {
      if (n.userId === userId && ids.includes(n.id) && !n.readAt) { n.readAt = now; changed = true; }
    }
    if (changed) await flush();
  });
}

/** Senaste notisen av en viss sort för en efterlysning. Bär takten i regel 2. */
export async function lastOf(efterlysningId: string, kind: NoticeKind, source?: MatchSource): Promise<Notice | null> {
  const list = await load();
  const hits = list
    .filter((n) => n.efterlysningId === efterlysningId && n.kind === kind && (!source || n.source === source))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return hits[0] ?? null;
}

export function reset(): void { cache = null; }

// ---------------------------------------------------------------------------
// Reglerna
// ---------------------------------------------------------------------------

/** Ett dygn mellan Tradera-brev per efterlysning. Config, för att takten kommer att justeras. */
const TRADERA_COOLDOWN_MS = Number(process.env.EFTERLYSNING_TRADERA_COOLDOWN_MS ?? 24 * 3600_000);

/**
 * Adressen breven länkar till.
 *
 * `LOOPA_PUBLIC_URL` FÖRST. Här stod bara `PUBLIC_URL`, vilket var ett andra namn på samma sak —
 * resten av servern läser `LOOPA_PUBLIC_URL` (se butik/seo.ts, checkout.ts, adContent.ts). Vid en
 * domänflytt hade den som satte den ena fått notismejl som fortsatte peka på den gamla adressen,
 * tyst, och först märkt det när någon klagade på en död länk. Det gamla namnet läses fortfarande,
 * så en miljö som bara har det fungerar som förut.
 */
const BASE = () =>
  process.env.LOOPA_PUBLIC_URL?.trim() || process.env.PUBLIC_URL?.trim() || "https://app.loopa.nu";

export function deepLink(e: Efterlysning): string {
  return `${BASE()}/kop/mina-efterlysningar#${e.id}`;
}

/**
 * Får vi höra av oss om den här källan just nu?
 *
 * Vårt eget alltid; Tradera högst en gång per dygn. Skillnaden är inte godtycklig: en Loopa-vara
 * finns i ett exemplar och kan vara borta i morgon, medan Traderas utbud byts ut hela tiden och
 * skulle ge ett brev i timmen.
 */
export async function mayNotify(e: Efterlysning, source: MatchSource): Promise<boolean> {
  if (source !== "tradera") return true;
  const last = await lastOf(e.id, "match", "tradera");
  if (!last) return true;
  return Date.now() - new Date(last.createdAt).getTime() >= TRADERA_COOLDOWN_MS;
}

const SEK = (n: number | null) => (n === null ? "okänt pris" : `${n.toLocaleString("sv-SE")} kr`);

/** Brevets och notisens text. Samma ord i båda — mottagaren ska känna igen sig. */
function matchBody(e: Efterlysning, hits: Candidate[]): { title: string; body: string } {
  const one = hits.length === 1;
  const title = one
    ? `Vi hittade något: ${hits[0].product.title}`
    : `${hits.length} nya träffar på din efterlysning`;

  const lines = hits.map((h) => {
    const where = h.source === "tradera" ? "Säljs via Tradera" : h.source === "loopa_incoming" ? "På väg in till oss" : "Hos oss nu";
    return `• ${h.product.title} — ${SEK(h.product.priceSek)} (${where})\n  ${h.fitNote}`;
  });

  const body = [
    `Du efterlyste: ${e.summary}`,
    "",
    ...lines,
    "",
    `Se dem här: ${deepLink(e)}`,
    "",
    "Vill du inte längre leta? Pausa eller ta bort efterlysningen på samma sida.",
  ].join("\n");

  return { title, body };
}

/**
 * Skickar en träffnotis — inkorg alltid, brev om det finns någon att skriva till.
 *
 * MÄRKNINGEN SKER FÖRST. Möbeln räknas som notifierad i samma stund notisen skapas, inte när brevet
 * gått iväg. En avsändare som faller ska hellre ha missat ett brev än skicka samma brev varje minut.
 */
export async function notifyMatches(e: Efterlysning, hits: Candidate[]): Promise<Notice | null> {
  // Utan väg att nå personen finns inget att skicka. Se `nabar` — konto ELLER e-post duger.
  if (!nabar(e) || hits.length === 0) return null;

  const fresh = hits.filter((h) => !e.notifiedProductIds.includes(h.product.id));
  if (fresh.length === 0) return null;

  await store.markNotified(e.id, fresh.map((h) => h.product.id));

  const { title, body } = matchBody(e, fresh);
  /**
   * Inkorgen är personlig och slås upp på konto.
   *
   * En efterlysning som bara har en e-postadress får därför sitt besked som BREV och ingen rad i
   * inkorgen — vilket är den kanal personen valde när de skrev sin adress i stället för att skapa
   * ett konto. Att lägga notisen på en tom sträng hade gjort den synlig för fel personer.
   */
  const notice = e.userId ? await push({
    userId: e.userId,
    efterlysningId: e.id,
    kind: "match",
    title,
    body,
    href: deepLink(e),
    productIds: fresh.map((h) => h.product.id),
    source: fresh[0].source,
  }) : null;

  emit("notification_sent", {
    kind: "match", source: fresh[0].source, antal: fresh.length,
    efterlysning: e.id, brev: e.email ? true : false,
  });
  if (e.email) await sendLetter({ to: e.email, subject: title, body, kind: "match" });
  return notice;
}

export async function sendLetter(letter: Letter): Promise<void> {
  try {
    await sender().send(letter);
  } catch (err) {
    // Ett fallet brev får aldrig fälla den körning som skapade det. Notisen ligger redan i inkorgen.
    console.warn(`[utskick] brevet "${letter.subject}" gick inte iväg:`, err instanceof Error ? err.message : err);
  }
}

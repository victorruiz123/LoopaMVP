/**
 * Googles omdirigeringsadresser, lösta till sidorna de pekar på.
 *
 * Sökverktyget ger inga riktiga adresser. Varje källa som modellen citerar, och varje sida den läser, kommer som
 * `vertexaisearch.cloud.google.com/grounding-api-redirect/…` med domännamnet som titel — och modellens egna `sourceUrl`-fält upprepar samma
 * långa adress. Koden kasserade därför alla (`isRedirectUrl`), vilket hade två följder som syntes först 2026-10-25:
 *
 *   1. REFERENSBILDERNA. Sidorna modellen hittat — tillverkarens produktsida, återförsäljarens, katalogen — nådde aldrig bildletaren, som
 *      bara fick en tom källista. Säljaren fick sin egen bild på varje kandidat ("Ingen produktbild hittades").
 *   2. VERIFIERINGEN. Ett mått vars källa var en omdirigering kunde aldrig kontrolleras mot sidan, och blev för alltid bara "citerat av
 *      modellen".
 *
 * En omdirigering är ett vanligt HTTP-svar: GET ger 302 med `Location` — den riktiga adressen (mätt: 90–630 ms, IKEA:s produktsidor, återförsäljare,
 * kataloger). Det här löser dem EN gång efter anropet, utan att hämta sidan som pekas ut: bara adressen läses. Begagnatsajterna (Blocket,
 * Tradera, Facebook) hämtas aldrig av oss — de får stå kvar som länkar, och filtreras ur bildletandet som förut (`isMarketplace`).
 */

import { isRedirectUrl } from "./normalize.js";
import type { InteractionOutcome } from "./geminiInteractions.js";
import type { ResearchTrace } from "./types.js";

export type UrlResolver = (urls: string[]) => Promise<Map<string, string>>;

const PER_URL_MS = 5_000;
/** Allt i en omgång får ta så här lång tid i sin helhet: lösningen ligger efter modellanropet och får aldrig äta av livslängden. */
const TOTAL_MS = 3_000;
const MAX_URLS = 24;
const CONCURRENCY = 6;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { to: string | null; at: number }>();

async function resolveOne(url: string): Promise<string | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.to;
  let to: string | null = null;
  try {
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (compatible; LoopaBot/1.0)" }, signal: AbortSignal.timeout(PER_URL_MS) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      const abs = new URL(loc, url).toString();
      if (/^https?:\/\//i.test(abs) && !isRedirectUrl(abs)) to = abs;
    }
  } catch {
    to = null;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(url, { to, at: Date.now() });
  return to;
}

/** De omdirigeringsadresser som finns i listan, lösta. Misslyckade lämnas ur kartan — de behålls som de var. */
export const resolveGroundingRedirects: UrlResolver = async (urls) => {
  const todo = [...new Set(urls.filter(isRedirectUrl))].slice(0, MAX_URLS);
  const out = new Map<string, string>();
  if (todo.length === 0) return out;
  const queue = [...todo];
  const worker = async () => {
    for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
      const to = await resolveOne(u);
      if (to) out.set(u, to);
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, TOTAL_MS)))]);
  if (timer) clearTimeout(timer);
  return out;
};

/** Alla omdirigeringsadresser ett anrop bär: citat, lästa sidor och varje sträng i modellens JSON. */
export function collectRedirects(out: Pick<InteractionOutcome, "json" | "trace">): string[] {
  const found = new Set<string>();
  for (const c of out.trace.citations) if (isRedirectUrl(c.url)) found.add(c.url);
  for (const f of out.trace.fetchedUrls) if (isRedirectUrl(f.url)) found.add(f.url);
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v == null) return;
    if (typeof v === "string") {
      if (isRedirectUrl(v)) found.add(v);
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(out.json, 0);
  return [...found];
}

function remap<T>(v: T, map: Map<string, string>, depth = 0): T {
  if (depth > 8 || v == null) return v;
  if (typeof v === "string") return (map.get(v) ?? v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => remap(x, map, depth + 1)) as unknown as T;
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, remap(x, map, depth + 1)])) as unknown as T;
  return v;
}

function dedupeBy<T extends { url: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(x.url) && seen.add(x.url));
}

/**
 * Anropets svar med omdirigeringarna utbytta mot de riktiga adresserna — i spåret (citat, lästa sidor) och i modellens JSON. Spåret på disk är
 * orört (det skrevs före detta, med råa adresser); det här är bara vad resten av pipelinen läser.
 */
export async function withResolvedUrls(out: InteractionOutcome, resolve: UrlResolver): Promise<InteractionOutcome> {
  const redirects = collectRedirects(out);
  if (redirects.length === 0) return out;
  const map = await resolve(redirects);
  if (map.size === 0) return out;
  const trace: ResearchTrace = {
    ...out.trace,
    citations: dedupeBy(out.trace.citations.map((c) => ({ ...c, url: map.get(c.url) ?? c.url }))),
    fetchedUrls: dedupeBy(out.trace.fetchedUrls.map((f) => ({ ...f, url: map.get(f.url) ?? f.url }))),
  };
  console.info(`[research] ${out.trace.label ?? ""} ${out.trace.purpose}: ${map.size}/${redirects.length} omdirigeringar lösta till riktiga sidor`);
  return { ...out, json: remap(out.json, map), trace };
}

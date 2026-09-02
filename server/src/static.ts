import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { injectSeo, seoFor } from "./butik/seo.js";

/**
 * Serverar det byggda UI:t.
 *
 * I utveckling kommer sidan från vite, som proxar /api hit. I drift finns ingen vite — och att lägga
 * frontend hos en statisk värd och API:t här hade betytt två ursprung, alltså CORS och kakor över
 * korsvis ursprung för bildvägarna. Samma server för båda gör i stället /api relativt, precis som
 * koden redan skriver det, och bildkakan blir en vanlig förstapartskaka.
 */
const ROOT = path.resolve(import.meta.dirname, "..", "..", "web", "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** Byggda tillgångar bär innehållshash i namnet och kan cachas för alltid. index.html får aldrig. */
const IMMUTABLE = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

async function fileAt(rel: string): Promise<string | null> {
  // path.resolve normaliserar bort "..", och kontrollen fångar det som ändå pekar ut ur roten.
  const abs = path.resolve(ROOT, "." + (rel.startsWith("/") ? rel : `/${rel}`));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  try {
    return (await stat(abs)).isFile() ? abs : null;
  } catch {
    return null;
  }
}

export async function distExists(): Promise<boolean> {
  return (await fileAt("/index.html")) !== null;
}

/**
 * Sant om svaret skickades. Falskt betyder att vägen inte fanns — anroparen får själv avgöra vad
 * det innebär.
 */
export async function serveStatic(pathname: string, res: ServerResponse, search = ""): Promise<boolean> {
  const direct = await fileAt(pathname);
  // Enkelsidig app: allt som inte är en fil är en vy, och vyer renderas av index.html.
  const file = direct ?? (await fileAt("/index.html"));
  if (!file) return false;

  /**
   * Sidor som ska gå att hitta får sitt huvud ifyllt innan de skickas.
   *
   * TVÅ ADRESSRYMDER: butiken (möbler till salu) och efterlysningsväggen (möbler folk söker). Den
   * andra kom till med köpsidan och är minst lika viktig för sökmotorer — "sökes string hylla
   * stockholm" är en fråga folk ställer, och varje kategori är en sida som svarar.
   *
   * Säljflödets skärmar ska ingen hitta via en sökmotor, och en riktig fil serveras som den är.
   * Faller uppslaget skickas skalet orört — en trasig titel får aldrig bli en trasig sida.
   */
  if (!direct && (pathname.startsWith("/butik") || pathname.startsWith("/efterlyses"))) {
    try {
      const head = await seoFor(pathname, search);
      if (head) {
        const html = injectSeo(await readFile(file, "utf-8"), head);
        res.setHeader("Content-Type", TYPES[".html"]);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "no-cache");
        res.writeHead(200);
        res.end(html);
        return true;
      }
    } catch (err) {
      console.warn("[butik] kunde inte bygga sidhuvudet:", err instanceof Error ? err.message : err);
    }
  }

  const ext = path.extname(file).toLowerCase();
  res.setHeader("Content-Type", TYPES[ext] ?? "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Cache-Control",
    direct && IMMUTABLE.test(pathname) ? "public, max-age=31536000, immutable" : "no-cache",
  );
  res.writeHead(200);
  createReadStream(file).pipe(res);
  return true;
}

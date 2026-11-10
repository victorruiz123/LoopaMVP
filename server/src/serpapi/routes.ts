/**
 * HTTP-vägarna för SerpApi-flödet. Webbens brygga (web/src/lib/serpApiBridge.ts) anropar dem på samma sätt som appskalets brygga anropar Electron:
 *
 *   POST /api/serpapi/prepare   { images: [dataUrl] }                                  → { sid }
 *   POST /api/serpapi/identify  { sid, brand, furnitureType }                          → { answer, links }
 *   POST /api/serpapi/specs     { sid, brand, model, furnitureType }                   → { answer, links }
 *   POST /api/serpapi/images    { sid, brand, queries }                                → [{ model, rows }]
 *   GET  /api/serpapi/session/:sid                                                     → samtalet hittills (frågor och svar)
 *   POST /api/serpapi/end       { sid }                                                → bilden och samtalet glöms
 *   GET  /api/serpapi/status                                                           → { enabled, … }: ska webben använda flödet nu? (nyckel, publik adress och dygnstak, se serpApiEnabled)
 *
 * Alla dessa ligger INNANFÖR inloggningsgrinden (varje anrop kostar en sökning hos SerpApi). Enda undantaget är bildadressen, /api/serpapi/img/<nyckel>, som SerpApi själv hämtar
 * bilden från och som därför måste vara öppen — den går inte att gissa och gäller en halvtimme (session.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { askSpecs, findImages, identify, prepare, transcript, type ImageQuery } from "./aimode.js";
import { serpApiKey } from "./client.js";
import { dailyCap, endSession, getImage, getSession, publicBase, searchesToday, serpApiEnabled } from "./session.js";

type Send = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = <T>(req: IncomingMessage, maxBytes?: number) => Promise<T>;

const text = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Bildadressen, före grinden: SerpApi har inget konto hos oss. */
export function handleSerpApiImage(name: string, req: IncomingMessage, res: ServerResponse): void {
  const im = /^[A-Za-z0-9_-]{20,64}\.(jpg|png|webp)$/.test(name) ? getImage(name) : null;
  if (!im) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Vi hittade ingen sådan bild." }));
    return;
  }
  res.writeHead(200, { "Content-Type": im.mime, "Content-Length": im.buf.length, "Cache-Control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : im.buf);
}

/** Svarar true när vägen var vår. `owner` är den inloggades id. */
export async function handleSerpApi(segments: string[], req: IncomingMessage, res: ServerResponse, owner: string, send: Send, readBody: ReadBody): Promise<boolean> {
  const route = segments[0];
  try {
    if (route === "status" && req.method === "GET") {
      // `enabled` är det webben läser vid varje uppladdning. Anledningen när det är av (nyckel saknas, tak nått) står i serverloggen, inte i svaret.
      const { enabled, reason } = serpApiEnabled();
      if (!enabled) console.info(`[serpapi] flödet är av: ${reason}`);
      send(res, 200, { enabled, keySet: !!serpApiKey(), publicUrlSet: !!publicBase(), searchesToday: searchesToday(), dailyCap: dailyCap() });
      return true;
    }
    if (route === "prepare" && req.method === "POST") {
      const body = await readBody<{ images?: unknown }>(req, 40 * 1024 * 1024);
      const images = Array.isArray(body.images) ? body.images.filter((i): i is string => typeof i === "string") : [];
      const { sid } = await prepare(owner, images);
      send(res, 200, { sid });
      return true;
    }
    if (route === "session" && segments.length === 2 && req.method === "GET") {
      const s = getSession(segments[1], owner);
      if (!s) send(res, 404, { error: "Samtalet finns inte." });
      else send(res, 200, transcript(s));
      return true;
    }
    if (req.method !== "POST" || !["identify", "specs", "images", "end"].includes(route ?? "")) return false;
    const body = await readBody<{ sid?: unknown; brand?: unknown; model?: unknown; furnitureType?: unknown; queries?: unknown }>(req, 256 * 1024);
    const s = getSession(body.sid, owner);
    if (!s) {
      send(res, 404, { error: "Samtalet finns inte (har det gått mer än två timmar, eller startades servern om?)." });
      return true;
    }
    const brand = text(body.brand, 80);
    const furnitureType = text(body.furnitureType, 40) || null;
    if (route === "identify") send(res, 200, await identify(s, brand, furnitureType));
    else if (route === "specs") {
      const model = text(body.model, 120);
      if (!model) send(res, 400, { error: "model krävs" });
      else send(res, 200, await askSpecs(s, brand, model, furnitureType));
    } else if (route === "images") {
      const queries: ImageQuery[] = Array.isArray(body.queries)
        ? (body.queries as Array<Record<string, unknown>>)
            .filter((q) => typeof q?.model === "string" && (q.model as string).trim())
            .slice(0, 12)
            .map((q) => ({ model: text(q.model, 120), productType: text(q.productType, 40) || null, undertyp: text(q.undertyp, 40) || null, retry: q.retry === true }))
        : [];
      send(res, 200, await findImages(s, brand, queries));
    } else {
      endSession(s.id);
      send(res, 200, { ok: true });
    }
    return true;
  } catch (err) {
    // Meddelandet är våra egna (SerpApiError bär aldrig nyckeln) eller kommer från skalets motsvarande kontroller; 502 för att felet ligger uppströms.
    send(res, 502, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}

import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadImageAsBase64 } from "./imageUtils.js";
import type { CapturedImage, FurnitureIdentity, ListingResult } from "./types.js";

/**
 * Annonsgeneratorn bor i loopa-landing-page-main och ANROPAS, inte kopieras.
 *
 * `functions/api/seller/generate.ts` är en Cloudflare Pages Function, men den är skriven mot
 * webbstandard — den tar en `Request` och returnerar en `Response`, och läser sin enda hemlighet ur ett
 * `env`-objekt den får in. Node har båda globalt, så handlern går att anropa rakt av. En portad kopia
 * hade fungerat i dag och glidit isär i morgon; det här kan inte glida.
 *
 * Sökvägen är byggd vid körning med flit: en statisk import hade dragit in landningssidans egen
 * TypeScript-uppsättning (annan `lib`, annan version) i skickmotorns typkontroll utan att tillföra
 * något — kontraktet nedan är ändå vårt eget.
 */
const GENERATE_MODULE = pathToFileURL(
  path.resolve(import.meta.dirname, "..", "..", "loopa-landing-page-main", "functions", "api", "seller", "generate.ts"),
).href;

/** Hur länge vi väntar. Generatorn har en egen inre deadline på 26 s; det här är bara ett skyddsnät. */
const LISTING_TIMEOUT_MS = Number(process.env.LISTING_TIMEOUT_MS ?? 45000);
/** Generatorn tar högst 10 och beskär själv per steg. Fler bildrutor gör bara nyttolasten dyr. */
const MAX_LISTING_IMAGES = 6;

type Handler = (context: { request: Request; env: { GEMINI_API_KEY?: string } }) => Promise<Response>;

function unavailable(reason: string, startedAt: number): ListingResult {
  return { status: "unavailable", unavailableReason: reason, result: null, latencyMs: Date.now() - startedAt };
}

/**
 * Modell, specifikationer och färdig annonstext för möbeln.
 *
 * Kastar aldrig. Annonsen är ett tillägg till besiktningen, och en generator som ligger nere får inte
 * kosta säljaren den skanning de redan betalat ett Gemini-anrop för — samma regel som priset lyder
 * under. Generatorn själv svarar dessutom hellre degraderat än med fel, så ett `status: "fallback"`
 * med bara färg och en titel är ett giltigt svar och inte ett misslyckande.
 */
export async function generateListing(
  identity: FurnitureIdentity | null,
  images: CapturedImage[],
  jobDir: string,
): Promise<ListingResult | null> {
  if (!identity) return null;
  const startedAt = Date.now();

  // Generatorn kräver ett märke. Har säljaren bara skrivit modellnamn är DET den bästa söknyckeln
  // vi har — bättre än att hoppa över annonsen helt.
  const brand = identity.brand?.trim() || identity.model.trim();
  const fullName = [identity.brand, identity.model].filter(Boolean).join(" ").trim();

  let onRequestPost: Handler;
  try {
    ({ onRequestPost } = (await import(GENERATE_MODULE)) as { onRequestPost: Handler });
  } catch (err) {
    return unavailable(
      `Annonsgeneratorn gick inte att ladda: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
      startedAt,
    );
  }

  let payloadImages: Array<{ mimeType: string; dataBase64: string }>;
  try {
    payloadImages = await Promise.all(
      images.slice(0, MAX_LISTING_IMAGES).map(async (img) => {
        const part = await loadImageAsBase64(path.join(jobDir, "originals", img.path));
        return { mimeType: part.mimeType, dataBase64: part.base64 };
      }),
    );
  } catch {
    return unavailable("Bildrutorna gick inte att läsa.", startedAt);
  }
  if (payloadImages.length === 0) return unavailable("Inga bildrutor att skicka.", startedAt);

  try {
    const response = await Promise.race([
      onRequestPost({
        request: new Request("http://condition.local/api/seller/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand,
            productHint: identity.model,
            // Det säljaren faktiskt skrev, ordagrant. Generatorn söker på det.
            sellerNote: fullName,
            images: payloadImages,
          }),
        }),
        env: { GEMINI_API_KEY: process.env.GEMINI_API_KEY },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), LISTING_TIMEOUT_MS),
      ),
    ]);

    const body = (await response.json()) as { ok?: boolean; error?: string; result?: unknown };
    if (!body.ok || !body.result) {
      return unavailable(body.error ?? `Annonsgeneratorn svarade ${response.status}.`, startedAt);
    }
    return { status: "ok", unavailableReason: null, result: body.result as ListingResult["result"], latencyMs: Date.now() - startedAt };
  } catch (err) {
    const reason =
      err instanceof Error && err.message === "timeout"
        ? `Annonsgeneratorn svarade inte inom ${Math.round(LISTING_TIMEOUT_MS / 1000)} s.`
        : `Annonsgeneratorn misslyckades: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`;
    console.warn(`[condition-grading] listing unavailable — ${reason}`);
    return unavailable(reason, startedAt);
  }
}

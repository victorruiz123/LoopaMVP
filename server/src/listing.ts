import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadImageAsBase64 } from "./imageUtils.js";
import type { CapturedImage, FurnitureIdentity, ListingResult, ModelCandidate } from "./types.js";
import type { SourceRef } from "./candidateImages.js";

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
const LISTING_TIMEOUT_MS = Number(process.env.LISTING_TIMEOUT_MS ?? 70000);

/**
 * Rundligare budgetar än loopa.nu kör med, av en enda anledning: identifieringen ligger INTE på vår
 * kritiska väg. Den löper parallellt med skickbedömningen, som tar 20-40 s ändå.
 *
 * Deras 9 s mot en uppmätt latens på 6,2 s lämnade ingen marginal, och en fallen sökning kostar
 * källorna — och därmed måtten, som bara får läsas ur grundad text. Att spara sekunder som ändå går
 * åt någon annanstans var att betala med hela funktionen.
 */
// Sätts i process.env, INTE i request-env. Generatorns budgetar är konstanter som utvärderas när
// modulen laddas, och modulen laddas dynamiskt först vid första anropet — alltså efter de här raderna.
// Skickade som request-env hade de aldrig fått någon effekt alls.
process.env.SELLER_RESEARCH_BUDGET_MS ??= "24000";
process.env.SELLER_RESEARCH_RETRY_BUDGET_MS ??= "16000";
process.env.SELLER_OVERALL_DEADLINE_MS ??= "60000";
// Bildtaket lämnas på generatorns 3. Att höja det till 6 såg ut som en gratis förbättring — fler
// vinklar åt identifieringen, betald av en budget vi ändå inte använde. Mätt på samma IKEA-stol,
// tio körningar per läge, gav taket 3 kandidater i 8 fall av 10 och taket 6 bara i 2 av 10: den
// tyngre nyttolasten får den grundade sökningen att falla (sources=0), och utan grundad text finns
// inga kandidater alls. Budgeten var aldrig det som begränsade.
/** Generatorn tar högst 10 och beskär själv per steg. Fler bildrutor gör bara nyttolasten dyr. */
const MAX_LISTING_IMAGES = 6;

type Handler = (context: { request: Request; env: Record<string, string | undefined> }) => Promise<Response>;

/** Vad ett anrop mot annonsgeneratorn kan svara. `needs_selection` är ett giltigt svar, inte ett fel. */
export type SellerCall =
  | { kind: "needs_selection"; candidates: ModelCandidate[]; sources: SourceRef[]; researchText: string }
  | { kind: "ok"; listing: ListingResult }
  | { kind: "unavailable"; reason: string };

/** Andra anropets identitetsbesked: säljarens val, ett handskrivet namn, eller uttalat okänt. */
export type Resolution =
  | { kind: "seller_selected"; selected: ModelCandidate }
  | { kind: "manual"; manualModel: string }
  | { kind: "unknown" };

/** Vad generatorn tar emot. Utbrutet ur anropet för att vägvalet ska gå att testa utan Gemini. */
export type SellerRequest = {
  brand: string;
  productHint?: string;
  sellerNote: string;
  images: Array<{ mimeType: string; dataBase64: string }>;
  resolution?: Resolution;
  priorResearch?: string;
  priorSources?: SourceRef[];
  /** Förslag säljaren redan avfärdat. Satt bara på ett omval — se `findMoreCandidates` i pipeline/identify.ts. */
  excludeModels?: string[];
  /**
   * Namn som redan står i den lista omvalet håller på att fylla.
   *
   * Skilt från `excludeModels` därför att generatorns prompt säger olika saker om de två: det ena är
   * möbler säljaren sagt nej till, det andra är platser som redan är tagna. Båda sållas bort ur
   * svaret; bara det första bär beskedet "de var fel".
   */
  alreadySuggested?: string[];
};

/**
 * Bygger kroppen till ett generatoranrop.
 *
 * Generatorn kräver ett märke; har säljaren bara skrivit modellnamn är DET den bästa söknyckeln.
 * Tidigare underlag skickas med oavsett väg — det är belagt material, och vilken väg identiteten kom
 * in genom säger inget om dess giltighet.
 */
export function buildSellerRequest(
  identity: FurnitureIdentity,
  resolution?: Resolution,
  prior?: { researchText: string; sources: SourceRef[] },
  images: Array<{ mimeType: string; dataBase64: string }> = [],
  excludeModels: string[] = [],
  alreadySuggested: string[] = [],
): SellerRequest {
  const brand = identity.brand?.trim() || identity.model.trim();
  const fullName = [identity.brand, identity.model].filter(Boolean).join(" ").trim();
  return {
    brand,
    productHint: identity.model || undefined,
    sellerNote: fullName || brand,
    images,
    ...(resolution ? { resolution } : {}),
    ...(prior?.sources.length ? { priorResearch: prior.researchText, priorSources: prior.sources } : {}),
    ...(excludeModels.length ? { excludeModels } : {}),
    ...(alreadySuggested.length ? { alreadySuggested } : {}),
  };
}

function unavailable(reason: string, startedAt: number): ListingResult {
  return { status: "unavailable", unavailableReason: reason, result: null, latencyMs: Date.now() - startedAt };
}

/**
 * Ett anrop mot annonsgeneratorn.
 *
 * UTAN `resolution` är det fas 1 — identifieringen. Den svarar antingen med en färdig annons (märket
 * och bilderna räckte för att avgöra modellen själv) eller med `needs_selection` och upp till fyra
 * kandidater som säljaren får välja mellan.
 *
 * MED `resolution` är det fas 2 — annonsen, byggd på den valda modellen.
 *
 * MED `excludeModels` och utan `resolution` är det ett OMVAL: säljaren avfärdade alla fyra förslagen
 * och bad om nya. Generatorn svarar då alltid `needs_selection`, aldrig med en annons — de avfärdade
 * namnen sållas bort i dess egen kandidatläsning, inte bara i dess prompt.
 *
 * Kastar aldrig. Generatorn svarar hellre degraderat än med fel, och en generator som ligger nere får
 * inte kosta säljaren den skanning de redan betalat ett Gemini-anrop för.
 */
export async function callSellerGenerate(
  brandOrIdentity: FurnitureIdentity | string | null,
  images: CapturedImage[],
  jobDir: string,
  resolution?: Resolution,
  /** Grundat underlag från identifieringen — träder in när fas 2:s egen sökning ger noll. */
  prior?: { researchText: string; sources: SourceRef[] },
  /** Redan avfärdade förslag, som "IKEA SÖDERHAMN". Får aldrig komma tillbaka som kandidater. */
  excludeModels: string[] = [],
  /** Förslag omgången redan lämnat. Sållas likadant, men säljaren har inte sagt nej till dem. */
  alreadySuggested: string[] = [],
): Promise<SellerCall> {
  const startedAt = Date.now();
  const identity = typeof brandOrIdentity === "string" ? { brand: brandOrIdentity, model: "" } : brandOrIdentity;
  if (!identity) return { kind: "unavailable", reason: "Inget märke angavs, så det fanns inget att söka på." };

  // Generatorn kräver ett märke. Har säljaren bara skrivit modellnamn är DET den bästa söknyckeln.
  const brand = identity.brand?.trim() || identity.model.trim();
  if (!brand) return { kind: "unavailable", reason: "Inget märke angavs." };

  let onRequestPost: Handler;
  try {
    ({ onRequestPost } = (await import(GENERATE_MODULE)) as { onRequestPost: Handler });
  } catch (err) {
    return { kind: "unavailable", reason: `Annonsgeneratorn gick inte att ladda: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` };
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
    return { kind: "unavailable", reason: "Bildrutorna gick inte att läsa." };
  }
  if (payloadImages.length === 0) return { kind: "unavailable", reason: "Inga bildrutor att skicka." };

  try {
    const response = await Promise.race([
      onRequestPost({
        request: new Request("http://condition.local/api/seller/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildSellerRequest(identity, resolution, prior, payloadImages, excludeModels, alreadySuggested)),
        }),
        env: {
          GEMINI_API_KEY: process.env.GEMINI_API_KEY,
          // Alltid fråga säljaren vilken modell det är, aldrig avgöra själv — se generate.ts.
          SELLER_ALWAYS_ASK: process.env.SELLER_ALWAYS_ASK ?? "1",
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), LISTING_TIMEOUT_MS)),
    ]);

    const body = (await response.json()) as {
      ok?: boolean;
      kind?: string;
      error?: string;
      candidates?: ModelCandidate[];
      sources?: SourceRef[];
      researchText?: string;
      provenance?: ListingResult["provenance"];
      timings?: ListingResult["timings"];
      result?: unknown;
    };

    // `ok: true, kind: "needs_selection"` — tvetydighet mellan riktiga produkter. Bryggan krävde
    // tidigare `body.result` och rapporterade därför just det här som "Annonsen kunde inte skapas".
    if (body.ok && body.kind === "needs_selection") {
      return {
        kind: "needs_selection",
        candidates: (body.candidates ?? []).slice(0, 4),
        sources: body.sources ?? [],
        researchText: body.researchText ?? "",
      };
    }
    if (!body.ok || !body.result) {
      return { kind: "unavailable", reason: body.error ?? `Annonsgeneratorn svarade ${response.status}.` };
    }
    return {
      kind: "ok",
      listing: {
        status: "ok",
        unavailableReason: null,
        result: body.result as ListingResult["result"],
        provenance: body.provenance ?? null,
        // Stegtiderna sparas på jobbet. Utan dem säger en körning bara "det tog 34 sekunder"; med dem
        // säger den vilket av stegen som gjorde det.
        timings: body.timings,
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    const reason =
      err instanceof Error && err.message === "timeout"
        ? `Annonsgeneratorn svarade inte inom ${Math.round(LISTING_TIMEOUT_MS / 1000)} s.`
        : `Annonsgeneratorn misslyckades: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`;
    console.warn(`[condition-grading] listing unavailable — ${reason}`);
    return { kind: "unavailable", reason };
  }
}

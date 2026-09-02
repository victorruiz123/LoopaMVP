/**
 * Var annonsinnehållet kommer ifrån — och varför det är två adaptrar och inte en if-sats.
 *
 * MANUAL_CONTENT: köparen laddar upp sina egna skärmbilder av annonsen och klistrar in texten.
 * Servern rör aldrig annonsens adress; den sparas som köparens egen anteckning om var möbeln stod.
 *
 * LINK_FETCH: servern hämtar annonssidan själv. STUBBAD MED FLIT, och flaggan är av. Att hämta en
 * främmande sida från vår server är ett helt annat läge än att ta emot en bild någon själv laddat
 * upp — tekniskt (SSRF, robots, rate limits) och rättsligt (vem kopierar vad, och från vem). Den
 * skillnaden ska gå att slå på och av utan att bedömningen nedströms ändrar form, och det är hela
 * skälet att gränssnittet finns innan den andra implementationen gör det.
 *
 * ALLT NEDSTRÖMS TAR EMOT `AdSubmission`. Bedömningen, affärsrummet och säljarens förifyllning vet
 * aldrig vilken adapter som svarade. Om de visste det skulle en flaggändring bli en ändring på tolv
 * ställen i stället för en.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getImageDimensions } from "../imageUtils.js";
import { maskPersonalData } from "./state.js";
import { submissionDir } from "./store.js";
import type { AdSourceKind, AdSubmission } from "./types.js";
import { fetchAd, fetchImages, LinkFetchError } from "./linkFetch.js";

/** Hur många bilder en annons får bidra med. En Blocket-annons har sällan fler som säger något nytt. */
export const MAX_AD_IMAGES = 8;

/** Det köparen skickar in, oavsett adapter. */
export interface IntakeRequest {
  /** Bilder som data-URL:er, samma form som säljflödets uppladdning. */
  images?: string[];
  adUrl?: string | null;
  description?: string | null;
  askingPriceSek?: number | null;
}

export interface AdSourceAdapter {
  kind: AdSourceKind;
  /** Sant när adaptern får användas i den här miljön. */
  available(): boolean;
  collect(dealId: string, req: IntakeRequest): Promise<AdSubmission>;
}

/**
 * Adressen sparas, men aldrig som något att hämta.
 *
 * Den är köparens egen referens — det som gör att de känner igen sin affär bland flera. Vi
 * kontrollerar bara att det ÄR en adress, så att fältet inte blir ett fritextfält med vad som helst
 * i, och att den inte pekar på något som bara är meningsfullt inifrån vårt eget nät.
 */
export function normalizeAdUrl(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Inte för att vi hämtar den — utan för att en sparad adress mot 127.0.0.1 eller 10.x är ett
  // tecken på att någon testar vad fältet gör, och den dagen LINK_FETCH slås på är den redan sparad.
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.|\[?::1)/.test(host)) return null;
  return url.toString().slice(0, 500);
}

function priceOf(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  // Ett rimlighetstak: begärda priser över en halv miljon är inte en möbel på Blocket, de är ett
  // felskrivet fält, och ett sådant tal skulle förstöra prisjämförelsen längre fram.
  return raw > 0 && raw <= 500_000 ? Math.round(raw) : null;
}

/**
 * Köparens egna skärmbilder. Standardvägen, alltid på.
 *
 * BILDERNA HAMNAR I AFFÄRENS EGEN MAPP, aldrig i server/data/jobs. Skälet är retention: en
 * jobbmapp lever så länge jobbet gör, medan annonsunderlaget ska gå att städa bort när affären är
 * klar utan att röra något annat. Se purgeSubmissionMedia.
 */
export const manualContent: AdSourceAdapter = {
  kind: "MANUAL_CONTENT",
  available: () => true,

  async collect(dealId, req) {
    const dir = submissionDir(dealId);
    await mkdir(dir, { recursive: true });

    const imagePaths: string[] = [];
    for (const [i, dataUrl] of (req.images ?? []).slice(0, MAX_AD_IMAGES).entries()) {
      const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
      if (!base64) continue;
      const filename = `ad_${i}.jpg`;
      const abs = path.join(dir, filename);
      try {
        await writeFile(abs, Buffer.from(base64, "base64"));
        // Läser måtten som en kontroll att filen ÄR en bild. En trasig data-URL går igenom
        // base64-avkodningen utan att klaga och blir en fil som kraschar Gemini-anropet i stället.
        await getImageDimensions(abs);
        imagePaths.push(filename);
      } catch {
        // En bild som inte gick att läsa hoppas över. Köparen laddade upp flera.
      }
    }

    return {
      source: "MANUAL_CONTENT",
      adUrl: normalizeAdUrl(req.adUrl),
      imagePaths,
      // Maskningen sker HÄR, före lagring. Se maskPersonalData.
      description: maskPersonalData(req.description ?? null)?.slice(0, 4000) ?? null,
      askingPriceSek: priceOf(req.askingPriceSek),
      submittedAt: new Date().toISOString(),
    };
  },
};

/** Flaggan som styr om servern får hämta annonssidor själv. AV som förval. */
export function linkFetchEnabled(): boolean {
  return process.env.AFFAR_LINK_FETCH === "1";
}

/**
 * Serverhämtning av annonsen.
 *
 * Läser annonssidan, plockar ut rubrik, beskrivning, pris, skickuppgift och bilder, och lämnar dem i
 * exakt samma `AdSubmission` som köparens egna skärmbilder ger. Allt nedströms — bedömningen,
 * affärsrummet, säljarens förifyllning — märker aldrig skillnaden. Det var hela poängen med att
 * bygga gränssnittet innan implementationen.
 *
 * TVÅ SAKER STYR OM DEN FÅR KÖRA, och de är olika slags gränser:
 *
 *   robots.txt   — sidans egen regel. Blocket förbjuder uttryckligen automatisk hämtning utan
 *                  skriftligt tillstånd. Respekteras som förval; se linkFetch.ts.
 *   SSRF         — vår egen säkerhet. Adressen kommer från en användare, och kontrollen sitter på
 *                  den uppslagna IP-adressen, inte på värdnamnet.
 *
 * Kastar hellre än att returnera ett magert underlag: anroparen ska kunna säga till köparen VARFÖR
 * det inte gick, och be om skärmbilder i stället. Ett tomt resultat som ser ut som en lyckad
 * hämtning är det enda utfallet som är sämre än ett fel.
 */
export const linkFetch: AdSourceAdapter = {
  kind: "LINK_FETCH",
  available: linkFetchEnabled,

  async collect(dealId, req) {
    const adUrl = normalizeAdUrl(req.adUrl);
    if (!adUrl) throw new LinkFetchError("Klistra in en giltig länk till annonsen.", "unsupported");

    const ad = await fetchAd(adUrl);
    // Bilderna hämtas som data-URL:er och sparas sedan av MANUAL_CONTENT-vägen, så att lagringen och
    // städningen är EN implementation. Skillnaden mellan adaptrarna är varifrån innehållet kom —
    // inte var det hamnar.
    const images = await fetchImages(ad.imageUrls);

    const collected = await manualContent.collect(dealId, {
      images,
      adUrl,
      // Rubriken först: den bär oftast märke och modell, vilket är det bedömningen behöver mest.
      description: [ad.title, ad.description, ad.condition ? `Skick enligt annonsen: ${ad.condition}` : null]
        .filter(Boolean)
        .join("\n\n"),
      askingPriceSek: ad.priceSek ?? req.askingPriceSek ?? null,
    });

    return { ...collected, source: "LINK_FETCH" };
  },
};

/**
 * Adaptern för den här inlämningen.
 *
 * Väljer MANUAL_CONTENT om inte flaggan uttryckligen är på OCH köparen bara lämnat en adress. En
 * köpare som laddat upp bilder ska få dem använda även när flaggan är på — deras egna skärmbilder är
 * ett bättre underlag än vad vi kan skrapa, och de har redan gjort arbetet.
 */
export function adapterFor(req: IntakeRequest): AdSourceAdapter {
  const hasOwnContent = (req.images?.length ?? 0) > 0;
  if (!hasOwnContent && linkFetch.available() && normalizeAdUrl(req.adUrl)) return linkFetch;
  return manualContent;
}

/**
 * Hämtar annonsen, med köparens egna bilder som reservväg.
 *
 * DEN HÄR FUNKTIONEN ÄR VAD ANROPARE SKA ANVÄNDA. Skillnaden mot `adapterFor` är att den hanterar
 * det vanligaste utfallet: hämtningen får inte, eller går inte. Då ska köparen inte mötas av ett
 * fel utan av en förklaring och en väg vidare — och den vägen är den som redan fungerar.
 *
 * `fallbackReason` är till för gränssnittet: "vi fick inte läsa annonsen" och "sidan svarade inte"
 * leder till olika saker att säga, och köparen som får veta vilket slipper prova samma sak igen.
 */
export async function collectAd(
  dealId: string,
  req: IntakeRequest,
): Promise<{ submission: AdSubmission; fallbackReason: string | null }> {
  const adapter = adapterFor(req);
  if (adapter.kind !== "LINK_FETCH") {
    return { submission: await adapter.collect(dealId, req), fallbackReason: null };
  }
  try {
    return { submission: await adapter.collect(dealId, req), fallbackReason: null };
  } catch (err) {
    const reason =
      err instanceof LinkFetchError && err.reason === "robots"
        ? `${err.message} Ladda upp skärmbilder av annonsen i stället, så bedömer vi dem.`
        : "Vi kunde inte läsa annonsen automatiskt. Ladda upp skärmbilder av den i stället.";
    console.info(`[affär] hämtningen föll för ${dealId}: ${err instanceof Error ? err.message : err}`);
    return { submission: await manualContent.collect(dealId, req), fallbackReason: reason };
  }
}

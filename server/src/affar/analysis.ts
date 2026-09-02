/**
 * Köparens analys av en inklistrad annons — SAMMA pipeline som när någon säljer.
 *
 * Här låg tidigare ett eget, mindre Gemini-anrop som svarade med några iakttagelser och ett spann.
 * Det gav en bedömning men inte ett underlag: inga mått, inga egenskaper, ingen annonstext, inget
 * pris räknat på skicket. Köparen fick alltså mindre än säljaren av samma sorts bilder.
 *
 * Nu skapas ett riktigt besiktningsjobb av annonsens bilder och den vanliga pipelinen kör på det:
 * besiktning, identifiering, sidskörd, annonsgenerering, prismotor. Resultatet är en ConditionResult
 * som ListingView ritar — samma annonskort som säljaren ser.
 *
 * MÄRKET ÄR NYCKELN SOM STARTAR ALLT. `createConditionJob` startar identifieringen och därmed
 * annonsen och priset bara när ett märke följer med; utan det körs enbart skickbedömningen. I
 * säljflödet väljer säljaren märket på startsidan. Här spelar ANNONSTEXTEN den rollen — det är den
 * som säger "IKEA EKTORP 3-sits soffa" — och `identifyFromAd` är den lilla översättningen däremellan.
 *
 * VAD SOM ÄNDÅ SKILJER, och som aldrig får suddas ut: underlaget är bilder SÄLJAREN valt, ofta just
 * för att slitaget inte syns. Kortet är detsamma, men det är inte ett attest. Jobbet märks
 * `adDerived`, vilket håller det utanför Butik och det publika kortet — och klienten ramar in det som
 * preliminärt. Det verifierade kortet kommer först när säljaren filmat.
 */

import { callGeminiStructured, Type } from "../gemini.js";
import { createConditionJob } from "../jobCreate.js";
import { getJob } from "../jobStore.js";
import { fetchAd, fetchImages } from "./linkFetch.js";
import { maskPersonalData } from "./state.js";
import type { AdSubmission } from "./types.js";
import type { ConditionJob } from "../types.js";

/** Vad annonsen sade om vad möbeln ÄR. Motsvarar säljarens val på startsidan. */
export interface AdIdentity {
  brand: string | null;
  model: string | null;
}

const IDENTITY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    brand: { type: Type.STRING, description: "Möbelns märke, tomt om det inte framgår." },
    model: { type: Type.STRING, description: "Modellnamnet ensamt, utan märke och storlek. Tomt om det inte framgår." },
  },
} as const;

const IDENTITY_PROMPT = `Du läser en begagnadannons och ska svara på EN sak: vilket märke och vilken
modell möbeln är.

LÄS TEXTEN FÖRST. Säljare skriver nästan alltid ut det: "IKEA EKTORP 3-sits", "Swedese Lamino",
"NORDVIKEN barstol". Står det i texten är det svaret — det är säljarens egen uppgift om sin egen
möbel, och den är mer tillförlitlig än vad någon kan se på ett foto.

Kan du inte se märket, lämna fältet tomt. Gissa ALDRIG ett märke för att fältet ska bli ifyllt: ett
påhittat märke skickar hela värderingen fel, medan ett tomt fält bara ger en mindre komplett annons.

Modellen skrivs ensam: "EKTORP", inte "IKEA EKTORP 3-sits".`;

/**
 * Märke och modell ur annonsen.
 *
 * Ett litet anrop med ett smalt uppdrag, och det är hela skälet att det är skilt från besiktningen:
 * det som startar pipelinen får inte vänta på den. Faller det körs jobbet ändå — då blir det en
 * skickbedömning utan annons och pris, vilket är sämre men inte trasigt.
 */
export async function identifyFromAd(
  images: string[],
  adText: string | null,
): Promise<AdIdentity> {
  const parts = images.slice(0, 3).map((dataUrl) => ({
    mimeType: "image/jpeg",
    base64: dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl,
  }));
  if (parts.length === 0 && !adText) return { brand: null, model: null };

  try {
    const { data } = await callGeminiStructured<{ brand?: string; model?: string }>({
      purpose: "affar_identitet",
      systemPrompt: IDENTITY_PROMPT,
      userPrompt: adText ? `ANNONSENS TEXT:\n${adText.slice(0, 2000)}` : "Vad är det för möbel?",
      images: parts,
      responseSchema: IDENTITY_SCHEMA,
      // Låg upplösning räcker: frågan är vilket märke det är, inte var skavankerna sitter.
      resolution: "low",
      primaryTimeoutMs: 15_000,
      cacheMaxAgeMs: 24 * 60 * 60 * 1000,
    });
    const clean = (v: unknown, max: number) => {
      const t = typeof v === "string" ? v.trim() : "";
      return t && t.length <= max ? t : null;
    };
    return { brand: clean(data.brand, 60), model: clean(data.model, 80) };
  } catch {
    return { brand: null, model: null };
  }
}

export interface StartedAnalysis {
  jobId: string;
  submission: AdSubmission;
  identity: AdIdentity;
}

/**
 * Hämtar annonsen och startar den riktiga pipelinen på dess bilder.
 *
 * Returnerar så snart jobbet är igång — pipelinen tar en halv till en hel minut, precis som för en
 * säljare, och klienten pollar på samma sätt som säljflödet gör. Att vänta ut den i ett HTTP-svar
 * hade gjort en timeout till ett trasigt formulär.
 */
export async function startAdAnalysis(adUrl: string): Promise<StartedAnalysis> {
  const ad = await fetchAd(adUrl);
  const images = await fetchImages(ad.imageUrls);
  if (images.length === 0) {
    throw new Error("Vi kunde inte hämta några bilder ur annonsen.");
  }

  const adText = maskPersonalData(
    [ad.title, ad.description, ad.condition ? `Skick enligt annonsen: ${ad.condition}` : null]
      .filter(Boolean)
      .join("\n\n"),
  );

  const identity = await identifyFromAd(images, adText);

  const created = await createConditionJob(
    {
      images: images.map((dataUrl) => ({ dataUrl, source: "manual" as const })),
      brand: identity.brand,
      // MODELLEN SKICKAS INTE MED, även när annonstexten gav en.
      //
      // Med en modell hoppar pipelinen över kandidatsökningen och går rakt på annonsen — och då får
      // köparen aldrig modellförslagen att välja bland. Säljaren väljer sin modell ur en lista, och
      // köparen ska välja ur samma. Annonsens gissning bär vi i stället som `productContext`, där
      // den hjälper sökningen utan att avgöra den.
      model: null,
      productContext: [adText, identity.model ? `Annonsen anger modellen: ${identity.model}` : null]
        .filter(Boolean)
        .join("\n\n"),
    },
    // Ingen ägare: köparen har ännu inte skapat konto. Jobbet adopteras när affären skapas.
    null,
    null,
    // Märkningen som håller det utanför Butik och det publika kortet.
    true,
    // Inget skick: annonsbilder är valda av säljaren och bär inte ett betyg.
    true,
  );
  if ("error" in created) throw new Error(created.error);

  /**
   * Har annonsen ett märke startar identifieringen direkt.
   *
   * `createConditionJob` gör det redan när ett märke följer med — men bara då. Utan märke står
   * jobbet stilla tills köparen svarat på frågan (se /marke), vilket är samma ordning säljaren går:
   * märket först, modellförslagen sedan.
   */
  return {
    jobId: created.jobId,
    identity,
    submission: {
      source: "LINK_FETCH",
      adUrl: ad.finalUrl,
      // Bilderna ligger i jobbets egen mapp nu, inte i affärens underlagsmapp. En kopia till hade
      // varit samma bilder på två ställen med två städningar.
      imagePaths: [],
      description: adText,
      askingPriceSek: ad.priceSek,
      submittedAt: new Date().toISOString(),
    },
  };
}

/**
 * Analysens läge, som köparen får se det.
 *
 * Lämnar ut HELA jobbet, inte bara ett färdigt resultat. Köparen går samma skärmar som säljaren —
 * modellförslag, mått, pris — och de skärmarna läser jobbet allteftersom det fylls i, precis som i
 * säljflödet. Ett svar som bara kom när allt var klart hade gjort de tre stegen till en spinner.
 *
 * Bara ANNONSHÄRLEDDA jobb går den här vägen. Säljarnas ligger kvar bakom inloggningen där de hör
 * hemma; den här finns för att köparen ännu inte har ett konto.
 */
export async function analysisJob(jobId: string): Promise<ConditionJob | null> {
  const job = await getJob(jobId);
  if (!job || !job.adDerived) return null;
  return job;
}

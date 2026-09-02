/**
 * Trygg affärs HTTP-vägar.
 *
 * TRE GRINDAR, och skillnaden mellan dem är hela integritetsmodellen:
 *
 *   /api/affar/tolka        publik   — bedömer en annons utan att skapa något. Ingen affär, ingen ägare.
 *   /api/affar/inbjudan/:t  publik   — säljarens vy av inbjudan. Token ÄR åtkomsten, inget konto krävs.
 *   /api/affar/*            inloggad — affärsrummet. Bara köparen och säljaren, prövat per anrop.
 *
 * Den mittersta är den ovanliga: en okänd person med en länk får se en affär. Det är avsiktligt —
 * säljaren ska kunna bedöma erbjudandet innan de skapar konto — och det är därför token är 160 bitar
 * och vyn innehåller noll uppgifter om köparen.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createDeal, move, store, submissionDir } from "./store.js";
import { adapterFor, collectAd, type IntakeRequest } from "./intake.js";
import { assessSubmission, priceVerdict } from "./assess.js";
import { analysisJob, startAdAnalysis } from "./analysis.js";
import { publicInviteOf } from "./state.js";
import { joinAsSeller, prefillFor, syncScanState, verifiedCardFor } from "./scan.js";
import { acceptPrice, actionsFor, counterPrice, declineDeal, openPriceRound, PriceError } from "./price.js";
import { deliveryQuote } from "../butik/delivery.js";
import { feesFor } from "./fees.js";
import { categoryLabel } from "../butik/catalog.js";
import type { Deal } from "./types.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Kroppen. Annonsbilder är stora, så taket ligger högre än för vanliga JSON-anrop. */
const MAX_BODY = 30 * 1024 * 1024;

function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("För stor kropp"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
      } catch {
        reject(new Error("Ogiltig JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Vad affären ser ut som för den som frågar.
 *
 * Köparen ser allt. Säljaren ser allt UTOM den preliminära bedömningen: den är köparens eget
 * underlag inför ett bud, och att visa säljaren vad vi gissat om deras möbel innan de själva filmat
 * den vore att lägga vår tumme på deras våg. Efter skanningen har båda samma verifierade kort, och
 * då är det den som gäller.
 */
function dealFor(deal: Deal, viewer: "buyer" | "seller"): unknown {
  const base = {
    id: deal.id,
    state: deal.state,
    role: viewer,
    // Substantivet först: "soffa" läser som en mening, "Soffor & fåtöljer" gör det inte.
    what: deal.assessment?.categoryNoun ?? (deal.assessment?.categorySlug ? categoryLabel(deal.assessment.categorySlug) : "möbel"),
    askingPriceSek: deal.submission?.askingPriceSek ?? null,
    proposals: deal.proposals,
    awaiting: deal.awaiting,
    // Vilka som accepterat visas för BÅDA: den som väntar ska se att motparten redan sagt ja.
    acceptedBy: deal.acceptedBy,
    counterRounds: deal.counterRounds,
    agreedPriceSek: deal.agreedPriceSek,
    scanJobId: deal.scanJobId,
    expiresAt: deal.expiresAt,
    createdAt: deal.createdAt,
  };
  if (viewer === "seller") return base;
  return {
    ...base,
    /**
     * Hela uppdelningen, redan på kortet — INNAN säljaren bjuds in.
     *
     * Säljaren får sitt fulla pris; vår ersättning ligger på köparens sida och ska stå framme från
     * början. En köpare som upptäcker avgifter efter att ha dragit in en säljare i en affär har
     * blivit lurad, hur rimliga avgifterna än är. Se fees.ts.
     *
     * Räknas på det ÖVERENSKOMNA priset när det finns, annars det begärda: före prisrundan är det
     * begärda priset det enda tal som finns, och en total utan tal är ingen upplysning.
     */
    avgifter: feesFor(
      deal.agreedPriceSek ?? deal.submission?.askingPriceSek ?? null,
      deal.buyerPostalCode ?? null,
    ),
    inviteToken: deal.inviteToken,
    assessment: deal.assessment,
    submission: deal.submission ? { ...deal.submission, imagePaths: deal.submission.imagePaths.length } : null,
    priceVerdict: priceVerdict(
      deal.submission?.askingPriceSek ?? null,
      deal.assessment?.marketLowSek ?? null,
      deal.assessment?.marketHighSek ?? null,
    ),
  };
}

/** Köparens eller säljarens roll i affären, eller null för alla andra. */
function roleOf(deal: Deal, userId: string): "buyer" | "seller" | null {
  if (deal.buyerId === userId) return "buyer";
  if (deal.sellerId === userId) return "seller";
  return null;
}

// ---------------------------------------------------------------------------
// Publika vägar
// ---------------------------------------------------------------------------

export async function handleAffarPublic(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  /**
   * POST /api/affar/tolka — bedöm en annons UTAN att skapa en affär.
   *
   * Publik med flit: köparen ska få se vad vi kan säga om annonsen innan de bestämmer sig för att
   * skapa konto. Bedömningen sparas inte här — den lever i svaret, och köparen får den igen när de
   * skapar affären. Det är också vad briefen menar med att inte göra analyserna sökbara: den som
   * inte skapat en affär har inte lämnat något efter sig.
   */
  if (segments[0] === "tolka" && req.method === "POST") {
    try {
      const body = await readBody<IntakeRequest>(req);
      // EN LÄNK RÄCKER när hämtningen är på: då läser vi annonsen själva. Är den av, eller föll den,
      // behövs köparens egna bilder eller text — och `collectAd` säger vilket det blev.
      const hasLink = !!body.adUrl?.trim();
      if (!body.images?.length && !body.description?.trim() && !hasLink) {
        return json(res, 400, { error: "Klistra in länken till annonsen, eller ladda upp skärmbilder av den." }), true;
      }
      // Bedömningen behöver en plats att lägga bilderna på. Den är tillfällig: utan en affär att
      // knyta dem till städas mappen av samma retention som resten.
      /**
       * En LÄNK startar den riktiga pipelinen — samma som när någon säljer.
       *
       * Svaret kommer innan analysen är klar: besiktning, identifiering, sidskörd, annonsgenerering
       * och prismotor tar tillsammans en halv till en hel minut, precis som för en säljare. Klienten
       * pollar på jobb-id:t, som säljflödet redan gör.
       *
       * Egna skärmbilder går fortfarande den lätta vägen: de kommer utan adress att hämta, och att
       * köra hela pipelinen på ett gäng skärmdumpar av en annonssida ger sämre underlag än på
       * annonsens egna produktbilder.
       */
      if (body.adUrl?.trim() && !body.images?.length) {
        try {
          const started = await startAdAnalysis(body.adUrl.trim());
          return json(res, 202, {
            mode: "pipeline",
            jobId: started.jobId,
            identity: started.identity,
            submission: { ...started.submission, imagePaths: 0 },
          }), true;
        } catch (err) {
          // Hämtningen gick inte. Köparen ska få veta varför och kunna ladda upp bilder i stället.
          return json(res, 422, {
            error: err instanceof Error ? err.message : "Vi kunde inte läsa annonsen.",
            needsManual: true,
          }), true;
        }
      }

      const scratchId = `tolk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const { submission, fallbackReason } = await collectAd(scratchId, body);

      // Hämtningen gav varken bilder eller text: då finns inget att bedöma, och köparen ska få veta
      // det i stället för en tom bedömning.
      if (submission.imagePaths.length === 0 && !submission.description) {
        return json(res, 422, {
          error: fallbackReason ?? "Vi kunde inte läsa något ur annonsen. Ladda upp skärmbilder av den i stället.",
          needsManual: true,
        }), true;
      }

      const assessment = await assessSubmission(scratchId, submission);
      json(res, 200, {
        assessment,
        submission: { ...submission, imagePaths: submission.imagePaths.length },
        priceVerdict: priceVerdict(submission.askingPriceSek, assessment.marketLowSek, assessment.marketHighSek),
        scratchId,
        source: submission.source,
        // Null när hämtningen lyckades. Annars förklaringen köparen ska få se.
        fallbackReason,
      });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : "Kunde inte bedöma annonsen." });
    }
    return true;
  }

  /**
   * GET /api/affar/analys/:jobId — köparens analys medan den kör.
   *
   * Publik, som resten av köparens väg innan de skapat konto. Jobb-id:t är en UUID och därmed
   * nyckeln; och `analysisStatus` svarar bara för ANNONSHÄRLEDDA jobb — säljarnas ligger kvar bakom
   * inloggningen där de hör hemma.
   */
  if (segments[0] === "analys" && segments.length === 2 && req.method === "GET") {
    const job = await analysisJob(segments[1]);
    if (!job) return json(res, 404, { error: "Analysen finns inte." }), true;
    // Hela jobbet: köparen går samma skärmar som säljaren, och de läser jobbet medan det fylls i.
    json(res, 200, { job });
    return true;
  }

  /**
   * GET /api/affar/analys/:jobId/bild/:imageId — en bild ur annonsen.
   *
   * Bilderna är SÄLJARENS EGNA, hämtade ur annonsen köparen klistrade in — inte tillverkarens
   * katalogfoto. Det är precis den bilden annonssidan ska visa: en tio år gammal soffa fotograferad i
   * ett vardagsrum, inte en ny i studio.
   *
   * Publik av samma skäl som pollningen ovan, och lika smal: `analysisJob` svarar bara för
   * annonshärledda jobb, så vägen kan inte användas för att nå en säljares filmning. Bild-id:t måste
   * dessutom stå i jobbets egen lista — annars vore `path` en väg in i filsystemet.
   */
  if (segments[0] === "analys" && segments.length === 4 && segments[2] === "bild" && req.method === "GET") {
    const job = await analysisJob(segments[1]);
    const image = job?.images?.find((i) => i.id === segments[3]);
    if (!job || !image) return json(res, 404, { error: "Bilden finns inte." }), true;
    const { jobDir } = await import("../jobStore.js");
    try {
      const buf = await readFile(path.join(jobDir(job.id), "originals", image.path));
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" });
      res.end(buf);
    } catch {
      json(res, 404, { error: "Bilden finns inte." });
    }
    return true;
  }

  /**
   * POST /api/affar/analys/:jobId/marke — köparen anger märket.
   *
   * SAMMA FRÅGA SÄLJAREN FÅR FÖRST. Pipelinen startar kandidatsökningen bara med ett märke att söka
   * på (se runIdentify), och i säljflödet väljer säljaren det på startsidan. Kan vi läsa det ur
   * annonsen slipper köparen frågan; kan vi inte det får de svara på den, precis som säljaren.
   *
   * Mätt på en skarp annons: en Tradera-listning med rubriken "Madison 3-sits soffa" gav modell men
   * inget märke, och jobbet stod stilla — inget spår startade, och skärmen snurrade.
   */
  if (segments[0] === "analys" && segments.length === 3 && segments[2] === "marke" && req.method === "POST") {
    const job = await analysisJob(segments[1]);
    if (!job) return json(res, 404, { error: "Analysen finns inte." }), true;
    const body = await readBody<{ marke?: string }>(req);
    const brand = body.marke?.trim().slice(0, 60);
    if (!brand) return json(res, 400, { error: "Ange ett märke." }), true;
    if (job.identityStatus) return json(res, 409, { error: "Identifieringen har redan startat." }), true;

    const { runIdentify } = await import("../pipeline/identify.js");
    const { persist } = await import("../jobStore.js");
    job.identity = { brand, model: "" };
    job.identityStatus = "identifying";
    job.progress = { stage: "identifying" as never, message: "Letar efter modellen…" };
    await persist(job);
    void runIdentify(job.id, brand, job.images ?? []);
    json(res, 202, { ok: true });
    return true;
  }

  /**
   * POST /api/affar/analys/:jobId/fler — "Ingen av dem", köparens omgång.
   *
   * Samma knapp säljaren har, och samma funktion bakom (`findMoreCandidates` bär regeln om vad som
   * får sökas om och med vilken förbudslista). Den satt först död på köparens skärm med motiveringen
   * att en omgång kostar ett modellanrop — men knappen RENDERAS av den delade skärmen, och en knapp
   * som inte gör något är sämre än kostnaden den skulle spara.
   *
   * Behovet är dessutom skarpt: annonsen sade "Madison" och listan gav Town, Mila, Noma. Köparen som
   * inte känner igen någon av fyra har bara två utvägar — den här och att skriva namnet själv.
   */
  if (segments[0] === "analys" && segments.length === 3 && segments[2] === "fler" && req.method === "POST") {
    const job = await analysisJob(segments[1]);
    if (!job) return json(res, 404, { error: "Analysen finns inte." }), true;
    const { findMoreCandidates } = await import("../pipeline/identify.js");
    const out = await findMoreCandidates(job.id);
    if ("error" in out) return json(res, 409, out), true;
    json(res, 202, out);
    return true;
  }

  /**
   * POST /api/affar/analys/:jobId/modell — köparen väljer modell ur förslagen.
   *
   * Samma val säljaren gör på sin kandidatskärm, och samma funktion bakom: `finalizeWithModel` är
   * det som startar annonsen, måtten och priset. Publik av samma skäl som pollningen ovan.
   */
  if (segments[0] === "analys" && segments.length === 3 && segments[2] === "modell" && req.method === "POST") {
    const job = await analysisJob(segments[1]);
    if (!job) return json(res, 404, { error: "Analysen finns inte." }), true;
    const body = await readBody<{ index?: number; manuell?: string }>(req);
    const { finalizeWithModel } = await import("../pipeline/identify.js");
    if (typeof body.index === "number" && job.candidates?.[body.index]) {
      void finalizeWithModel(job.id, { kind: "seller_selected", selected: job.candidates[body.index] });
    } else if (body.manuell?.trim()) {
      void finalizeWithModel(job.id, { kind: "manual", manualModel: body.manuell.trim().slice(0, 80) });
    } else {
      return json(res, 400, { error: "Välj ett förslag eller skriv modellnamnet." }), true;
    }
    json(res, 202, { ok: true });
    return true;
  }

  // GET /api/affar/inbjudan/:token — säljarens vy. Token är åtkomsten; inget konto krävs.
  if (segments[0] === "inbjudan" && segments.length === 2 && req.method === "GET") {
    const deal = await store().byToken(segments[1]);
    // Samma svar för "finns inte" och "fel token": ett annat svar hade gjort adressen till ett
    // orakel man kan gissa mot.
    if (!deal) return json(res, 404, { error: "Inbjudan finns inte, eller har gått ut." }), true;
    const what = deal.assessment?.categoryNoun ?? (deal.assessment?.categorySlug ? categoryLabel(deal.assessment.categorySlug) : "möbel");
    json(res, 200, { invite: publicInviteOf(deal, what) });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Kontobundna vägar
// ---------------------------------------------------------------------------

export async function handleAffar(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  user: { userId: string; email: string | null },
): Promise<boolean> {
  /**
   * POST /api/affar — skapa affärsrummet.
   *
   * Postnumret kontrolleras HÄR, vid skapandet, och inte i kassan. En affär som visar sig ligga
   * utanför vårt leveransområde efter att säljaren filmat sin möbel är en affär vi kostat två
   * personer tid på i onödan.
   */
  if (segments.length === 0 && req.method === "POST") {
    try {
      const body = await readBody<IntakeRequest & { postnummer?: string; scratchId?: string }>(req);
      /**
       * Postnumret kontrolleras HÄR, vid skapandet.
       *
       * Egen text i stället för leveranssvarets: butikens meddelande erbjuder självhämtning, och det
       * går inte i en Trygg affär — hela produkten är att VI hämtar hos säljaren och kör hem till
       * köparen. En affär utanför området är inte en affär vi kan genomföra, och det ska sägas
       * innan säljaren blivit inbjuden och filmat sin möbel i onödan.
       */
      const quote = deliveryQuote(body.postnummer ?? "");
      if (!quote.deliverable) {
        const outside = quote.zone === null && (body.postnummer ?? "").replace(/\D/g, "").length >= 5;
        return json(res, 409, {
          error: outside
            ? "Trygg affär finns bara i Stockholms län än så länge. Vi hämtar hos säljaren och kör hem till dig, och den rutten kan vi inte köra utanför länet ännu."
            : "Skriv hela postnumret, fem siffror.",
          outsideArea: outside,
        }), true;
      }

      const deal = await createDeal({
        buyerId: user.userId,
        buyerEmail: user.email,
        buyerPostalCode: (body.postnummer ?? "").replace(/\D/g, "").slice(0, 5),
      });

      const { submission } = await collectAd(deal.id, body);
      const assessment = await assessSubmission(deal.id, submission);
      await store().put({ ...deal, submission, assessment });

      json(res, 201, { deal: dealFor({ ...deal, submission, assessment }, "buyer") });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : "Kunde inte skapa affären." });
    }
    return true;
  }

  /**
   * POST /api/affar/ga-med/:token — säljaren skapar konto och går med.
   *
   * Adresseras med TOKEN och inte med affärens id, för säljaren har aldrig sett id:t: de kom från en
   * länk i en chatt. Att öppna länken räknar inte som att gå med — det kräver ett konto, och det är
   * den skillnaden konverteringsmåttet inbjudan → säljaren med faktiskt mäter.
   */
  if (segments[0] === "ga-med" && segments.length === 2 && req.method === "POST") {
    const out = await joinAsSeller(segments[1], user.userId, user.email);
    if ("error" in out) return json(res, out.status, { error: out.error }), true;
    json(res, 200, { deal: dealFor(out.deal, "seller"), prefill: out.prefill });
    return true;
  }

  /**
   * GET /api/affar — mina affärer, som köpare eller säljare.
   *
   * HELA AFFÄREN, inte bara dess läge. Profilen ska kunna visa vad som väntar på vem och vad man
   * får göra åt det utan att först öppna affärsrummet — annars är listan en samling namn och
   * användaren får klicka sig igenom dem för att hitta den enda som väntar på ett svar.
   *
   * Därför följer `actions` och `card` med per affär. `actions` är samma funktion affärsrummet
   * använder, så knapparna i listan kan aldrig säga något annat än rummet gör. `card` är det
   * verifierade kortet när säljaren filmat — det finns inget att visa före det, och en preliminär
   * bedömning som såg ut som ett kort hade varit precis den förväxling resten av produkten undviker.
   */
  if (segments.length === 0 && req.method === "GET") {
    const mine = (await store().all())
      .filter((d) => roleOf(d, user.userId) !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const deals = await Promise.all(
      mine.map(async (d) => {
        const role = roleOf(d, user.userId)!;
        return {
          ...(dealFor(d, role) as Record<string, unknown>),
          actions: actionsFor(d, role),
          card: await verifiedCardFor(d),
        };
      }),
    );
    json(res, 200, { deals });
    return true;
  }

  if (segments.length >= 1) {
    const deal = await store().get(segments[0]);
    const role = deal ? roleOf(deal, user.userId) : null;
    // 404 och inte 403: ett annat svar hade bekräftat att affären finns för den som gissar id:n.
    if (!deal || !role) return json(res, 404, { error: "Affären finns inte." }), true;

    // GET /api/affar/:id
    if (segments.length === 1 && req.method === "GET") {
      /**
       * Skanningsläget kontrolleras vid läsningen, inte av pipelinen.
       *
       * Riktningen är vald: besiktningen vet ingenting om affärer och ska fortsätta göra det. Den
       * kör lika bra för en vanlig säljare, och en krok därifrån hade gjort den beroende av en
       * modul den inte behöver. Se syncScanState.
       */
      const scanned = await syncScanState(deal);
      /**
       * Prisrundan öppnas vid läsning, precis som skanningsläget synkas där.
       *
       * Ingen annan del av systemet behöver veta att en prisrunda finns, och den som först öppnar
       * affärsrummet efter en klar besiktning är också den som ska mötas av ett förslag. Idempotent.
       */
      const current = await openPriceRound(scanned);
      json(res, 200, {
        deal: dealFor(current, role),
        actions: actionsFor(current, role),
        // Det verifierade kortet är gemensamt. Efter skanningen ser båda parter exakt samma sak,
        // och det är det prisförhandlingen förs på.
        verified: await verifiedCardFor(current),
        prefill: role === "seller" ? prefillFor(current) : undefined,
        events: await store().events(current.id),
      });
      return true;
    }

    /**
     * POST /api/affar/:id/bjud-in — köparen har hämtat sin länk.
     *
     * VI KONTAKTAR ALDRIG SÄLJAREN. Anropet flyttar bara affären till `invited` och startar klockan;
     * själva meddelandet klistrar köparen in i Blockets chatt med sina egna händer. Att skicka det åt
     * dem hade gjort oss till en avsändare säljaren aldrig bett om.
     */
    if (segments.length === 2 && segments[1] === "bjud-in" && req.method === "POST") {
      if (role !== "buyer") return json(res, 403, { error: "Bara köparen kan bjuda in." }), true;
      const updated = await move(deal.id, ["created"], "invited", { kind: "buyer", userId: user.userId }, "Köparen hämtade sin inbjudningslänk.");
      if (!updated) return json(res, 409, { error: "Affären är inte i ett läge där den går att bjuda in till." }), true;
      json(res, 200, { deal: dealFor(updated, "buyer") });
      return true;
    }

    /**
     * POST /api/affar/:id/pris — acceptera, lägg ett motbud, eller tacka nej.
     *
     * EN väg för alla tre, för de är samma beslut med tre utfall och ska prövas mot samma tillstånd.
     * Tre slutpunkter hade betytt tre ställen som var för sig kan glömma att kontrollera vems tur
     * det är.
     */
    if (segments.length === 2 && segments[1] === "pris" && req.method === "POST") {
      try {
        const body = await readBody<{ handling?: string; belopp?: number }>(req);
        const fresh = (await store().get(deal.id))!;
        let updated;
        if (body.handling === "acceptera") updated = await acceptPrice(fresh, role);
        else if (body.handling === "motbud") updated = await counterPrice(fresh, role, Number(body.belopp));
        else if (body.handling === "avbryt") updated = await declineDeal(fresh, role);
        else return json(res, 400, { error: "handling måste vara acceptera, motbud eller avbryt." }), true;

        json(res, 200, {
          deal: dealFor(updated, role),
          actions: actionsFor(updated, role),
          verified: await verifiedCardFor(updated),
        });
      } catch (err) {
        const status = err instanceof PriceError ? err.status : 500;
        json(res, status, { error: err instanceof Error ? err.message : "Kunde inte uppdatera priset." });
      }
      return true;
    }

    // GET /api/affar/:id/underlag/:n — köparens egen bild av annonsen. Bara köparen, aldrig säljaren.
    if (segments.length === 3 && segments[1] === "underlag" && req.method === "GET") {
      if (role !== "buyer") return json(res, 404, { error: "Finns inte." }), true;
      const index = Number(segments[2]);
      const rel = deal.submission?.imagePaths[index];
      if (!rel) return json(res, 404, { error: "Finns inte." }), true;
      try {
        const buf = await readFile(path.join(submissionDir(deal.id), rel));
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300" });
        res.end(buf);
      } catch {
        json(res, 404, { error: "Finns inte." });
      }
      return true;
    }
  }

  return false;
}

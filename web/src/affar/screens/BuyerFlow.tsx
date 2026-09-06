import { useEffect, useRef, useState } from "react";
import { analysisJob, chooseBrand, chooseModel, createDeal, findMoreModels, startAnalysis } from "../api";
import type { ConditionJob, ModelCandidate } from "../../types";
import ModelSelectScreen from "../../screens/ModelSelectScreen";
import SpecsScreen from "../../screens/SpecsScreen";
import MarketPrice from "../components/MarketPrice";
import AdListing from "../components/AdListing";
import AuthScreen from "../../screens/AuthScreen";
import { useAuth } from "../../auth/AuthProvider";
import { navigate } from "../router";
import { fetchDelivery } from "../../butik/api";
import Stegrad from "../../kop/animation/Stegrad";
import Efterlysningsfangare from "../../kop/components/Efterlysningsfangare";

/**
 * Köparens väg genom en inklistrad annons — SAMMA steg som säljaren går.
 *
 *   annonsen läses  →  välj modell  →  mått & egenskaper  →  marknadspris  →  annonssidan
 *
 * De två mittersta skärmarna ÄR säljflödets egna komponenter, återanvända rakt av: en köpare som
 * väljer modell ur förslagen ska se exakt samma lista som en säljare, för det är samma fråga med
 * samma svar. Ett andra kandidatgränssnitt hade blivit ett andra sätt att presentera samma sökning.
 *
 * TVÅ SAKER SKILJER, och båda är avsiktliga:
 *
 * INGET SKICK. Säljaren filmar ett varv med kända vinklar; annonsbilderna är valda av säljaren, ofta
 * just för att slitaget inte syns. Ett betyg härifrån hade lånat besiktningens auktoritet till en
 * gissning — och det är precis den förväxlingen som gör säljarens verifierade kort värt något. Se
 * `skipGrading` i jobCreate.ts.
 *
 * PRISET ÄR EN ANNAN FRÅGA. Säljarens prisskärm är en stege: "vad vill du sälja för". Köparen sätter
 * inget pris — de vill veta om det begärda är rimligt. Därför en egen vy där, och inte PriceScreen.
 */

type Step = "starting" | "brand" | "model" | "specs" | "price" | "listing" | "invite";

export default function BuyerFlow({
  adUrl,
  onNeedsManual,
}: {
  adUrl: string;
  /** Hämtningen gick inte. Köparen ska få ladda upp skärmbilder i stället för att köra i väggen. */
  onNeedsManual: (reason: string) => void;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<ConditionJob | null>(null);
  const [step, setStep] = useState<Step>("starting");
  const [askingPriceSek, setAskingPriceSek] = useState<number | null>(null);
  /** Annonsens egen text, som säljaren skrev den. Visas på annonssidan i stället för generatorns. */
  const [adText, setAdText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  /**
   * Vilken kandidatomgång vi väntar på efter ett "Hitta nya".
   *
   * Utan den flimrade skärmen tillbaka till de gamla förslagen: pollningen hinner svara med jobbet
   * som det såg ut FÖRE omvalet — `needs_selection` och fyra kandidater — innan servern hunnit tömma
   * listan. Omgångsnumret är det enda som skiljer den gamla listan från den nya.
   */
  const awaitingRound = useRef<number | null>(null);

  // Starta analysen en gång. StrictMode kör effekten dubbelt i utvecklingsläget, och två anrop hade
  // blivit två jobb på samma annons.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startAnalysis(adUrl)
      .then((r) => {
        setJobId(r.jobId);
        setAskingPriceSek(r.submission.askingPriceSek);
        setAdText(r.submission.description);
      })
      .catch((e: unknown) => onNeedsManual(e instanceof Error ? e.message : "Vi kunde inte läsa annonsen."));
  }, [adUrl]);

  /**
   * Pollar jobbet medan pipelinen fyller i det.
   *
   * Samma kadens som säljflödets useJobPoll (lib/useJobPoll.ts). Egen implementation bara för att
   * den hämtar från den publika analysvägen — köparen har inget konto, och den delade kroken bär
   * alltid en token.
   */
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const { job: fresh } = await analysisJob(jobId);
        if (!live) return;
        setJob(fresh);
        if (fresh.progress.stage === "error") {
          setError(fresh.error ?? "Analysen kunde inte slutföras.");
          return;
        }
      } catch {
        // En tappad pollning är inte ett fel — nästa försök kommer om två sekunder.
      }
      if (live) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
  }, [jobId]);

  // Steget följer jobbet: märke -> kandidater -> val -> annons klar.
  useEffect(() => {
    if (!job) return;
    /**
     * Inget märke ur annonsen, och inget spår igång: då står jobbet stilla tills köparen svarar.
     *
     * Samma fråga säljaren får först. Mätt på en skarp annons — en Tradera-listning som hette
     * "Madison 3-sits soffa" — gav rubriken en modell men inget märke, och skärmen snurrade i
     * evighet eftersom kandidatsökningen aldrig startade.
     */
    if (step === "starting" && !job.identityStatus && !job.identity?.brand) setStep("brand");
    if (
      step === "starting" &&
      job.identityStatus === "needs_selection" &&
      job.candidates?.length &&
      (awaitingRound.current === null || (job.candidateRound ?? 0) >= awaitingRound.current)
    ) {
      awaitingRound.current = null;
      setStep("model");
    }
    if (step === "starting" && job.identityStatus === "resolved" && job.result?.listing?.result) setStep("specs");
    if (step === "brand" && job.identityStatus === "needs_selection" && job.candidates?.length) setStep("model");
    if (step === "model" && job.identityStatus === "resolved") setStep("specs");
    /**
     * Hittade sökningen ingenting alls: visa modellskärmen ändå, tom.
     *
     * Den har en utväg för precis det här — "Skriv modellnamnet" — och den är bättre än en spinner
     * som står kvar tills jobbets klocka löper ut. Köparen har dessutom annonsen framför sig och kan
     * ofta läsa modellen ur den.
     */
    if (job.identityStatus === "unavailable" && (step === "starting" || step === "brand")) setStep("model");
  }, [job, step]);

  if (error) {
    return (
      <div className="affar-page">
        <section className="affar-card">
          <h2>Analysen gick inte igenom</h2>
          <p className="affar-hint">{error}</p>
          <button type="button" className="btn btn-outline btn-small" onClick={() => onNeedsManual(error)}>
            Ladda upp skärmbilder i stället
          </button>
        </section>

        {/*
          UTVÄGEN, inte en återvändsgränd.
          Den som just fick veta att vi inte kunde läsa deras annons ska mötas av något att göra. Samma
          komponent som fotblocket på köpsidan — ett formulär som fungerar utan konto och utan tolkning.
        */}
        <Efterlysningsfangare
          kompakt
          rubrik="Ska vi hålla utkik i stället?"
          ingress="Säg vad du letar efter, så hör vi av oss när något som stämmer dyker upp."
        />
      </div>
    );
  }

  const card = job?.result?.listing?.result ?? job?.pendingListing?.result ?? null;

  if (step === "brand" && job) {
    return <BrandStep jobId={job.id} hint={job.productContext} onChosen={() => setStep("starting")} />;
  }

  if (step === "model" && job) {
    return (
      <ModelSelectScreen
        brand={job.identity?.brand ?? null}
        // Tom lista är ett giltigt läge: skärmen erbjuder då att skriva modellnamnet själv.
        candidates={job.candidates ?? []}
        round={job.candidateRound ?? 0}
        searchingImages={(job.candidates ?? []).some((c: ModelCandidate) => c.imageUrl === undefined)}
        onSelect={(candidate) => {
          const index = (job.candidates ?? []).indexOf(candidate);
          void chooseModel(job.id, { index });
          setStep("starting");
        }}
        onManual={(model) => {
          void chooseModel(job.id, { manuell: model });
          setStep("starting");
        }}
        /**
         * "Ingen av dem" — fyra andra förslag, precis som säljaren får.
         *
         * Satt först som en no-op med motiveringen att omgången kostar ett modellanrop. Men knappen
         * renderas av den delade skärmen, och en knapp som inte gör något är sämre än sin kostnad —
         * särskilt här, där annonsen kan säga "Madison" och listan ge Town, Mila och Noma.
         */
        onFindNew={() => {
          awaitingRound.current = (job.candidateRound ?? 0) + 1;
          setStep("starting");
          void findMoreModels(job.id).catch(() => {
            // Föll anropet: tillbaka till listan som står kvar. Bättre än en skärm som snurrar.
            awaitingRound.current = null;
            setStep("model");
          });
        }}
      />
    );
  }

  if (step === "specs" && card) {
    return <SpecsScreen card={card} onNext={() => setStep("price")} onBack={() => setStep("starting")} />;
  }

  if (step === "price" && job) {
    return (
      <MarketPrice
        card={card}
        askingPriceSek={askingPriceSek}
        onNext={() => setStep("listing")}
        onBack={() => setStep("specs")}
      />
    );
  }

  if (step === "listing" && job && card) {
    return (
      <AdListing
        job={job}
        card={card}
        askingPriceSek={askingPriceSek}
        adText={adText}
        onInvite={() => setStep("invite")}
      />
    );
  }

  if (step === "invite") {
    return (
      <InviteStep
        adUrl={adUrl}
        adText={adText}
        askingPriceSek={askingPriceSek}
        onBack={() => setStep("listing")}
      />
    );
  }

  /**
   * Väntskärmen säger vad vi faktiskt gör.
   *
   * En ny kandidatomgång ("Hitta nya") landar här medan den söker, och rubriken "Vi läser annonsen"
   * var då direkt fel — annonsen var läst för länge sedan. Omgångsnumret skiljer de två lägena åt
   * och kommer ur jobbet, så rubriken följer sökningen i stället för en flagga vid sidan om.
   */
  const searchingMore = (job?.candidateRound ?? 0) > 0 && job?.identityStatus === "identifying";

  return (
    <div className="affar-page">
      <section className="affar-card">
        <h2>{searchingMore ? "Letar efter fler modeller" : "Vi läser annonsen"}</h2>
        <p className="affar-hint">
          {searchingMore
            ? "De du sagt nej till kommer inte tillbaka."
            : (job?.progress?.message ?? "Hämtar bilder och text…")}
        </p>
        <div className="affar-skeleton" style={{ height: 160 }} />
      </section>
    </div>
  );
}

/**
 * Märkesfrågan, när annonsen inte svarade på den.
 *
 * Medvetet mager: säljaren väljer märke ur en lista på 204 för att de ska filma något av dem. Köparen
 * har en annons framför sig och vet redan vad det står — de behöver ett fält, inte en katalog.
 */
function BrandStep({
  jobId,
  hint,
  onChosen,
}: {
  jobId: string;
  /** Annonstexten. Står märket där hjälper det köparen att svara utan att byta flik. */
  hint: string | null;
  onChosen: () => void;
}) {
  const [brand, setBrand] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="affar-page">
      <header className="affar-hero">
        {/* Delad stegrad — samma ikoner som köpsidan visar i rörelse. */}
        <Stegrad nu={1} />
        <h1>Vilket märke är möbeln?</h1>
        <p>Annonsen säger det inte. Står det i texten hjälper det oss hitta rätt modell och pris.</p>
      </header>
      <section className="affar-card">
        <label className="affar-label" htmlFor="brand">Märke</label>
        <input
          id="brand"
          className="affar-input"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          placeholder="IKEA, Mio, Swedese…"
          autoComplete="off"
        />
        {hint && (
          <details className="affar-hint" style={{ marginTop: 12 }}>
            <summary>Visa annonsens text</summary>
            <p style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{hint.slice(0, 600)}</p>
          </details>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !brand.trim()}
          onClick={() => {
            setBusy(true);
            void chooseBrand(jobId, brand.trim()).then(onChosen).catch(() => setBusy(false));
          }}
        >
          {busy ? "Söker modeller…" : "Fortsätt"}
        </button>
      </section>
    </div>
  );
}

/**
 * Från annonssidan till länken köparen skickar säljaren.
 *
 * TRE SAKER I ORDNING, och ordningen är vald:
 *
 *   1. Postnumret. Trygg affär bygger på att VI hämtar hos säljaren och kör hem till köparen, och
 *      den rutten går inte utanför Stockholms län. Frågan ligger först för att ett nej ska komma
 *      innan vi bett om ett konto — och långt innan en säljare filmat sin möbel i onödan.
 *   2. Kontot. Affären är ett rum med två parter och behöver en ägare. `AuthScreen` med
 *      `intent="flow"` är byggd för precis det här: en grind mitt i ett flöde, på samma sida, så att
 *      analysen bakom inte går förlorad i en omdirigering.
 *   3. Affären. Sedan bär affärsrummet inbjudan — meddelandet och länken — i `InviteMessage`.
 */
function InviteStep({
  adUrl,
  adText,
  askingPriceSek,
  onBack,
}: {
  adUrl: string;
  adText: string | null;
  askingPriceSek: number | null;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const [postal, setPostal] = useState("");
  const [needsAccount, setNeedsAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Postnumret prövas HÄR, före kontogrinden.
   *
   * Servern prövar det igen när affären skapas — det är den kontrollen som gäller. Men den ligger
   * bakom inloggningen, och en köpare i Göteborg fick då skapa ett konto först och nekas sedan. Ett
   * nej ska komma innan vi bett om någonting. Leveransvägen är publik just för att den ska kunna
   * svara på den frågan utan ett konto.
   */
  const checkArea = async (): Promise<boolean> => {
    const digits = postal.replace(/\D/g, "").slice(0, 5);
    try {
      const quote = await fetchDelivery(digits);
      if (quote.deliverable) return true;
      // Egen text och inte leveranssvarets: butikens erbjuder självhämtning, och det går inte i en
      // Trygg affär — hela produkten är att vi hämtar hos säljaren och kör hem till köparen.
      setError(
        quote.zone === null
          ? "Trygg affär finns bara i Stockholms län än så länge. Vi hämtar hos säljaren och kör hem till dig, och den rutten kan vi inte köra utanför länet ännu."
          : "Skriv hela postnumret, fem siffror.",
      );
      return false;
    } catch {
      // Föll kontrollen: låt servern avgöra i stället för att stoppa köparen på en tappad förfrågan.
      return true;
    }
  };

  const proceed = async () => {
    setBusy(true);
    setError(null);
    const ok = await checkArea();
    setBusy(false);
    if (!ok) return;
    if (user) void create();
    else setNeedsAccount(true);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { deal } = await createDeal({
        // Bilderna ligger redan på analysjobbet. Servern läser annonsen igen på adressen.
        images: [],
        adUrl,
        description: adText,
        askingPriceSek,
        postnummer: postal.replace(/\D/g, "").slice(0, 5),
      });
      navigate({ name: "deal", id: deal.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte skapa affären.");
      setBusy(false);
    }
  };

  if (needsAccount && !user) {
    return (
      /* `intent="account"` och inte `"flow"`: flödesgrindens rubrik lyder "Bilderna är klara", och
         den är säljarens — köparen har inte filmat någonting. Fliken öppnas ändå på registrering,
         för den som kommer hit är ny för oss. */
      <AuthScreen
        inbaddad
        intent="account"
        initialTab="signup"
        onDone={() => { setNeedsAccount(false); void create(); }}
        onBack={() => setNeedsAccount(false)}
      />
    );
  }

  const ready = postal.replace(/\D/g, "").length === 5;

  return (
    <div className="affar-page">
      <header className="affar-hero">
        <span className="affar-geo">📍 Just nu i Stockholm</span>
        <h1>Vart ska möbeln?</h1>
        <p>Vi hämtar hos säljaren och kör hem till dig. Postnumret avgör om vi kan köra sträckan.</p>
      </header>

      <section className="affar-card">
        <label className="affar-label" htmlFor="postnummer">Ditt postnummer</label>
        <input
          id="postnummer"
          className="affar-input"
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="112 34"
          value={postal}
          onChange={(e) => setPostal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && ready && !busy) void proceed(); }}
        />
        {error && <p className="affar-hint affar-error">{error}</p>}

        <div className="affar-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready || busy}
            onClick={() => void proceed()}
          >
            {busy ? "Skapar affären…" : user ? "Hämta länken till säljaren" : "Fortsätt"}
          </button>
          <button type="button" className="btn btn-text btn-small" onClick={onBack}>Tillbaka</button>
        </div>

        <p className="affar-hint">
          {user
            ? "Sedan får du en färdig text med din länk att klistra in där du redan pratar med säljaren."
            : "Nästa steg är ett konto — affären är ett rum med två parter och behöver en ägare."}
        </p>
      </section>
    </div>
  );
}

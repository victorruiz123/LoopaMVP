import { useEffect, useRef, useState } from "react";
import HomeScreen from "./screens/HomeScreen";
import CaptureScreen from "./screens/CaptureScreen";
import AnalysisScreen from "./screens/AnalysisScreen";
import ModelSelectScreen from "./screens/ModelSelectScreen";
import SpecsScreen from "./screens/SpecsScreen";
import PriceScreen from "./screens/PriceScreen";
import ResultScreen from "./screens/ResultScreen";
import TruthCardScreen from "./screens/TruthCardScreen";
import AuthScreen from "./screens/AuthScreen";
import ProfileScreen from "./screens/ProfileScreen";
import AdminScreen from "./screens/AdminScreen";
import AdminUserScreen from "./screens/AdminUserScreen";
import PublicCardScreen from "./screens/PublicCardScreen";
import { loopaIdFromPath } from "./lib/loopaId";
import { useAuth } from "./auth/AuthProvider";
import ModelSearchLoader from "./components/ModelSearchLoader";
import { getJob, selectModel, type CapturedShot, ensureMediaSession } from "./api";
import type { AdminUser, ConditionJob, ConditionResult, FurnitureIdentity, ModelCandidate } from "./types";

type Screen =
  | { name: "home" }
  | { name: "capture"; identity: FurnitureIdentity }
  | { name: "identify"; jobId: string; identity: FurnitureIdentity; previewShots: CapturedShot[] }
  | { name: "specs"; jobId: string; identity: FurnitureIdentity; previewShots: CapturedShot[] }
  | { name: "price"; jobId: string; identity: FurnitureIdentity; previewShots: CapturedShot[] }
  | { name: "analysis"; jobId: string; previewShots: CapturedShot[]; identity: FurnitureIdentity }
  | { name: "result"; jobId: string }
  // `back` finns för att kortet numera nås från två håll: säljarens egen profil och adminpanelen.
  // Utan det landade en admin på skickvyn för någon annans möbel när de backade ur kortet.
  | { name: "truthcard"; jobId: string; result: ConditionResult; loopaId?: string; back?: Screen }
  | { name: "lookup" }
  | { name: "profile" }
  | { name: "admin" }
  | { name: "adminUser"; user: AdminUser };

/**
 * Flödet: märke -> bilder -> VÄLJ MODELL -> specifikationer -> pris -> skick -> truth-card.
 *
 * Truth-cardet är inte ett tillval sist i kedjan utan det enda steget efter skicket: skickvyn har en
 * väg vidare och den leder hit. Se ResultScreen.
 *
 * Modellvalet ligger först av allt som händer efter bilderna, för att allt därefter hänger på det:
 * prismotorn söker på modellnamnet, och annonsen byggs runt den. Tidigare låg identifieringen sist,
 * där den ibland kom fram till att säljaren angett fel möbel efter att skick och pris redan räknats.
 */
export default function App() {
  const { user, loading } = useAuth();

  /**
   * /c/LP-XXXX-XXXX — det publika kortet, FÖRE inloggningen.
   *
   * Den som kommer hit har läst ett Loopa-ID i en Tradera-annons och har inget konto. Att först visa
   * en inloggningsruta vore att stänga det enda som gör annonsens skickpåstående kontrollerbart.
   * Läses ur adressen en gång: appen har ingen router, och den här vägen har ingen väg vidare in i
   * flödet.
   */
  const publicId = loopaIdFromPath(window.location.pathname);
  if (publicId) return <PublicCardScreen initialId={publicId} />;

  // Inloggningen ligger FÖRE flödet, inte inuti det. Ett truth-card som skapas utan konto har ingen
  // profil att hamna i, och att fråga efter inloggning först när kortet är klart hade betytt att
  // säljaren filmar ett varv och sedan får veta att resultatet inte kan sparas.
  if (loading) {
    return (
      <div className="screen screen-light center-column">
        <div className="spinner" />
      </div>
    );
  }
  if (!user) return <AuthScreen />;

  return <SignedInApp />;
}

/**
 * Bildkakan hämtas innan något som visar bilder ritas.
 *
 * Misslyckas den blockeras inte flödet — besiktningen fungerar ändå, det är bara bildrutorna som
 * uteblir, och att fälla hela appen för det vore fel avvägning.
 */
function useMediaSession(userId: string | undefined): boolean {
  // Samma svar bär adminrollen. Den avgörs av servern på adressen Supabase bekräftat — klienten
  // ritar bara ingången efter beskedet, och varje adminväg prövar rollen igen på sin egen sida.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!userId) return;
    void ensureMediaSession()
      .then((session) => setIsAdmin(session.isAdmin))
      .catch((err) => console.warn("[loopa] bildsession:", err));
  }, [userId]);
  return isAdmin;
}

function SignedInApp() {
  const { user } = useAuth();
  const isAdmin = useMediaSession(user?.id);
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const homeKey = useRef(0);

  const goHome = () => {
    homeKey.current += 1;
    setScreen({ name: "home" });
  };

  switch (screen.name) {
    case "home":
      return (
        <HomeScreen
          key={homeKey.current}
          onStartScan={(identity) => setScreen({ name: "capture", identity })}
          onOpenJob={(jobId) => setScreen({ name: "result", jobId })}
          onOpenProfile={() => setScreen({ name: "profile" })}
          onOpenLookup={() => setScreen({ name: "lookup" })}
        />
      );
    case "capture":
      return (
        <CaptureScreen
          identity={screen.identity}
          onBack={goHome}
          onCaptured={(jobId, previewShots) =>
            setScreen({ name: "identify", jobId, identity: screen.identity, previewShots })
          }
        />
      );
    case "identify":
      return (
        <IdentifyGate
          jobId={screen.jobId}
          identity={screen.identity}
          onResolved={() =>
            setScreen({
              name: "specs",
              jobId: screen.jobId,
              identity: screen.identity,
              previewShots: screen.previewShots,
            })
          }
        />
      );
    case "specs":
      return (
        <SpecsGate
          jobId={screen.jobId}
          onNext={() => setScreen({ ...screen, name: "price" })}
          onBack={() => setScreen({ ...screen, name: "identify" })}
        />
      );
    case "price":
      return (
        <PriceScreen
          identity={screen.identity}
          jobId={screen.jobId}
          onSeeCondition={() =>
            setScreen({ name: "analysis", jobId: screen.jobId, previewShots: screen.previewShots, identity: screen.identity })
          }
        />
      );
    case "analysis":
      return (
        <AnalysisScreen
          jobId={screen.jobId}
          previewShots={screen.previewShots}
          identity={screen.identity}
          onDone={() => setScreen({ name: "result", jobId: screen.jobId })}
          onAbort={goHome}
        />
      );
    case "result":
      return (
        <ResultScreen
          jobId={screen.jobId}
          onHome={goHome}
          // Resultatet kommer från skärmen själv, som redan har det. ID:t bor på jobbet och hämtas
          // här — men faller den hämtningen går kortet ändå fram: det som saknas då är chatten, inte
          // kortet, och steget efter skicket får aldrig sluta i ett tryck som inte gör något.
          onContinue={async (result) => {
            const loopaId = await getJob(screen.jobId)
              .then((job) => job.loopaId)
              .catch(() => undefined);
            setScreen({ name: "truthcard", jobId: screen.jobId, result, loopaId });
          }}
        />
      );
    case "truthcard": {
      const back = screen.back ?? { name: "result" as const, jobId: screen.jobId };
      return (
        <TruthCardScreen
          result={screen.result}
          loopaId={screen.loopaId}
          onBack={() => setScreen(back)}
          onHome={goHome}
        />
      );
    }
    case "lookup":
      // Uppslaget på ett Loopa-ID, samma skärm som den publika sidan — inifrån appen med en väg
      // tillbaka. Kortet som visas kan vara vems som helst; det är vad publikt betyder.
      return <PublicCardScreen onBack={goHome} />;
    case "profile":
      return (
        <ProfileScreen
          onBack={goHome}
          isAdmin={isAdmin}
          onOpenAdmin={() => setScreen({ name: "admin" })}
          // Profilen öppnar kortet, inte fyndlistan: det är truth-cardet som sparats, och vägen
          // tillbaka till skicket finns kvar inifrån det.
          onOpenJob={async (jobId) => {
            const job = await getJob(jobId);
            if (job.result) setScreen({ name: "truthcard", jobId, result: job.result, loopaId: job.loopaId });
            else setScreen({ name: "result", jobId });
          }}
        />
      );
    case "admin":
      return <AdminScreen onBack={() => setScreen({ name: "profile" })} onOpenUser={(u) => setScreen({ name: "adminUser", user: u })} />;
    case "adminUser": {
      const from = screen;
      return (
        <AdminUserScreen
          user={screen.user}
          onBack={() => setScreen({ name: "admin" })}
          // Kortet och inte skickvyn: adminvägarna är läsande, och skickvyn är den som har knappar
          // som skriver. Vägen tillbaka går till samma användare, inte till säljarflödet.
          onOpenJob={async (jobId) => {
            const job = await getJob(jobId);
            if (job.result) setScreen({ name: "truthcard", jobId, result: job.result, loopaId: job.loopaId, back: from });
          }}
        />
      );
    }
  }
}

/**
 * Klientens egen bortre gräns.
 *
 * Servern kan dö mellan två pollningar — den lever i minnet, så en omstart tar varje pågående körning
 * med sig. Skärmen ska då sluta snurra och säga det, inte vänta för evigt på ett jobb ingen längre
 * arbetar med. Rundligare än serverns deadline, så serverns felmeddelande hinner fram först.
 */
const CLIENT_GIVE_UP_MS = 300_000;

function useJobPoll(jobId: string, done: (job: ConditionJob) => boolean, intervalMs = 1200) {
  const [job, setJob] = useState<ConditionJob | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const until = Date.now() + CLIENT_GIVE_UP_MS;
    const poll = async () => {
      if (Date.now() > until) return setGaveUp(true);
      try {
        const j = await getJob(jobId);
        if (cancelled) return;
        setJob(j);
        // Ett fällt jobb är ett svar. Att fortsätta polla på det är att snurra på ett dött jobb.
        if (j.progress.stage === "error" || done(j)) return;
        setTimeout(poll, intervalMs);
      } catch {
        if (!cancelled) setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
  return { job, gaveUp, failed: job?.progress.stage === "error" };
}

/** Väntar in identifieringen och visar kandidaterna. Hoppas över när den kunde avgöra modellen själv. */
function IdentifyGate({
  jobId,
  identity,
  onResolved,
}: {
  jobId: string;
  identity: FurnitureIdentity;
  onResolved: () => void;
}) {
  const [sent, setSent] = useState(false);
  const { job, gaveUp, failed } = useJobPoll(
    jobId,
    // Slutar först när bilderna landat också — annars stannar pollningen i samma ögonblick som
    // kandidaterna kommer, och bilderna som hämtas strax efter når aldrig skärmen.
    (j) =>
      j.identityStatus === "unavailable" ||
      j.identityStatus === "resolved" ||
      (j.identityStatus === "needs_selection" && (j.candidates ?? []).every((c) => c.imageUrl !== undefined)),
    // Tätare än standardintervallet. Det här är den enda skärm där pollningen ÄR väntan: kandidaterna
    // ligger färdiga på servern och syns först vid nästa hämtning, så halva intervallet är halva den
    // sista fördröjningen. Ett jobb som identifieras är kortlivat, så det blir ett fåtal extra GET.
    600,
  );

  async function choose(choice: { candidate?: ModelCandidate; manualModel?: string }) {
    setSent(true);
    // Servern svarar 202 och arbetar vidare i bakgrunden; specifikationsskärmen pollar själv. Att
    // vänta in hela annonsen här hade gjort valet till en tyst paus på tjugo sekunder.
    await selectModel(jobId, choice);
    onResolved();
  }

  if (sent || job?.identityStatus === "resolved") {
    return (
      <div className="screen screen-light center-column">
        <div className="spinner" />
        <p>Bygger annonsen…</p>
        <p className="muted small">Hämtar mått, material och specifikationer</p>
      </div>
    );
  }
  // Ö.6: identifieringen får aldrig sluta i en återvändsgränd. Faller den — eller dör jobbet, eller
  // ger klienten upp — landar säljaren på samma skärm med noll kandidater och kan skriva namnet själv.
  // En misslyckad identifiering ska kosta ett handgrepp, inte en omstart.
  const stalled = gaveUp || failed || job?.identityStatus === "unavailable";
  if (!stalled && (!job || job.identityStatus === "identifying" || !job.identityStatus)) {
    return (
      <div className="screen screen-light center-column">
        <ModelSearchLoader />
        <p className="identify-waiting-title">Letar upp modellen…</p>
        <p className="muted small">Söker efter {identity.brand}-modeller som stämmer med bilderna</p>
      </div>
    );
  }
  return (
    <>
      {stalled && (
        <p className="identify-fallback-note identify-fallback-floating">
          {gaveUp
            ? "Vi fick inget svar från servern."
            : failed
              ? job?.error ?? "Analysen avbröts."
              : "Vi kunde inte söka fram några modeller just nu."}
        </p>
      )}
      <ModelSelectScreen
        brand={identity.brand}
        candidates={job?.candidates ?? []}
        onSelect={(candidate) => choose({ candidate })}
        onManual={(manualModel) => choose({ manualModel })}
      />
    </>
  );
}

/** Väntar in annonsen efter modellvalet. */
function SpecsGate({ jobId, onNext, onBack }: { jobId: string; onNext: () => void; onBack: () => void }) {
  const { job, gaveUp, failed } = useJobPoll(jobId, (j) => {
    const l = j.result?.listing ?? j.pendingListing;
    // `improving` betyder att fas 2 fortfarande söker vidare på egen hand. Skärmen visar det den har
    // med en gång — säljaren ska aldrig vänta på ett omförsök — men pollningen får inte sluta här,
    // för då fryser kortet på det första svaret och ett bättre landar osett i jobbet.
    return !!l && l.status !== "pending" && !l.improving;
  });

  // `pendingListing` finns för att annonsen kan bli klar innan skickresultatet — och när skicket FALLER
  // kommer resultatet aldrig. Att bara läsa `result.listing` betydde att en färdig annons låg
  // oåtkomlig medan skärmen snurrade i evighet.
  const listing = job?.result?.listing ?? job?.pendingListing;
  if (!listing && (gaveUp || failed)) {
    return (
      <div className="screen screen-light center-column">
        <h2 className="failure-title">Annonsen blev inte klar</h2>
        <p className="muted small">{gaveUp ? "Vi fick inget svar från servern." : job?.error}</p>
        <button className="btn btn-primary" onClick={onNext}>
          Fortsätt ändå
        </button>
        <button className="btn btn-text" onClick={onBack}>
          Byt modell
        </button>
      </div>
    );
  }
  if (!listing || listing.status === "pending") {
    return (
      <div className="screen screen-light center-column">
        <div className="spinner" />
        <p>Bygger annonsen…</p>
        <p className="muted small">Hämtar mått, material och specifikationer</p>
      </div>
    );
  }
  if (!listing.result) {
    return (
      <div className="screen screen-light center-column">
        <h2 className="failure-title">Annonsen kunde inte skapas</h2>
        <p className="muted small">{listing.unavailableReason}</p>
        <button className="btn btn-primary" onClick={onNext}>
          Fortsätt till priset ändå
        </button>
        <button className="btn btn-text" onClick={onBack}>
          Byt modell
        </button>
      </div>
    );
  }
  return <SpecsScreen card={listing.result} onNext={onNext} onBack={onBack} />;
}

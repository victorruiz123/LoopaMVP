import { useEffect, useRef, useState } from "react";
import HomeScreen from "./screens/HomeScreen";
import CaptureScreen from "./screens/CaptureScreen";
import AnalysisScreen from "./screens/AnalysisScreen";
import ModelSelectScreen from "./screens/ModelSelectScreen";
import SpecsScreen from "./screens/SpecsScreen";
import PriceScreen from "./screens/PriceScreen";
import ResultScreen from "./screens/ResultScreen";
import ListingScreen from "./screens/ListingScreen";
import AuthScreen from "./screens/AuthScreen";
import ProfileScreen from "./screens/ProfileScreen";
import AdminScreen from "./screens/AdminScreen";
import AdminUserScreen from "./screens/AdminUserScreen";
import AdminAdScreen from "./screens/AdminAdScreen";
import PublicCardScreen from "./screens/PublicCardScreen";
import { loopaIdFromPath } from "./lib/loopaId";
import ButikApp from "./butik/ButikApp";
import KopApp from "./kop/KopApp";
import { isButikPath } from "./butik/router";
import { isKopPath } from "./kop/router";
import AffarApp from "./affar/AffarApp";
import { isAffarPath } from "./affar/router";
import { legalDocFromPath } from "./lib/legal";
import LegalScreen from "./screens/LegalScreen";
import CookieConsent from "./components/CookieConsent";
import { useAuth } from "./auth/AuthProvider";
import ModelSearchLoader from "./components/ModelSearchLoader";
import ListingBuildLoader from "./components/ListingBuildLoader";
import { AuthRequiredError, createJob, getJob, selectModel, findMoreModels, type CapturedShot, ensureMediaSession } from "./api";
import { useJobPoll } from "./lib/useJobPoll";
import { useT } from "./lib/i18n";
import type { AdminUser, ConditionJob, ConditionResult, FurnitureIdentity, ModelCandidate } from "./types";
import type { AdminFlik } from "./screens/AdminScreen";

type Screen =
  | { name: "home" }
  // `shots` bara på vägen TILLBAKA, ur inloggningen: varvet är då redan filmat och skärmen ska öppna
  // på bilderna i stället för på kameran.
  | { name: "capture"; identity: FurnitureIdentity; shots?: CapturedShot[] }
  // Grinden: bilderna finns, kontot saknas. Ligger mellan filmningen och jobbet — se App nedan.
  // `resume` = sessionen tog slut med bilderna i handen, inte en ny säljare. Kontot finns redan,
  // så inloggningen ska öppna på rätt flik och inte be dem skapa ett till.
  // `shots` saknas när grinden slog till redan på märkesvalet — då finns ingen film att bära, och
  // vägen ut ur inloggningen är kameran i stället för uppladdningen.
  | { name: "signup"; identity: FurnitureIdentity; shots?: CapturedShot[]; resume?: boolean }
  // Uppladdningen. Egen skärm för att den kan följa direkt på en registrering.
  | { name: "starting"; identity: FurnitureIdentity; shots: CapturedShot[] }
  | { name: "identify"; jobId: string; identity: FurnitureIdentity; previewShots: CapturedShot[] }
  | { name: "specs"; jobId: string; identity: FurnitureIdentity; previewShots: CapturedShot[] }
  | { name: "price"; jobId: string; identity: FurnitureIdentity; previewShots: CapturedShot[] }
  | { name: "analysis"; jobId: string; previewShots: CapturedShot[]; identity: FurnitureIdentity }
  | { name: "result"; jobId: string }
  // `back` finns för att kortet numera nås från två håll: säljarens egen profil och adminpanelen.
  // Utan det landade en admin på skickvyn för någon annans möbel när de backade ur kortet.
  | { name: "listing"; jobId: string; result: ConditionResult; loopaId?: string; back?: Screen }
  // Inloggningen utanför flödet: den som vill åt sin profil innan de filmat något.
  | { name: "login" }
  | { name: "profile" }
  // `flik` bärs i skärmen och inte inuti panelen, för att vägen tillbaka från en annons ska landa i
  // annonsfliken. Utan den hade varje besök i en annons kastat tillbaka en till förvalet.
  | { name: "admin"; flik?: AdminFlik }
  | { name: "adminUser"; user: AdminUser }
  // Den enskilda annonsen, i redigeringsvyn. Nås ur panelens annonsflik, aldrig direkt — rollen
  // prövas på servern vid varje anrop.
  | { name: "adminAd"; loopaId: string };

/**
 * Flödet: märke -> bilder -> VÄLJ MODELL -> specifikationer -> pris -> skick -> annons.
 *
 * Annonsen är inte ett tillval sist i kedjan utan det enda steget efter skicket: skickvyn har en
 * väg vidare och den leder hit. Se ResultScreen.
 *
 * Modellvalet ligger först av allt som händer efter bilderna, för att allt därefter hänger på det:
 * prismotorn söker på modellnamnet, och annonsen byggs runt den. Tidigare låg identifieringen sist,
 * där den ibland kom fram till att säljaren angett fel möbel efter att skick och pris redan räknats.
 *
 * INLOGGNINGEN ligger inuti flödet, mellan bilderna och analysen. Den låg tidigare före allt: ett
 * formulär som mötte den som ännu inte sett vad appen gör. Nu väljs märket och varvet filmas utan
 * konto, och frågan kommer första gången den betyder något — bilderna ska laddas upp till ett konto,
 * och annonsen ska ha en profil att ligga i. Senare än så går inte: allt efter bilderna är
 * kontobundet. Se `capture` i FlowApp.
 *
 * Efter kontot händer ingenting som säljaren behöver bevittna: uppladdningen och bildsessionen körs
 * i bakgrunden och skärmen går rakt in i väntan på modellen — samma väg som en redan inloggad
 * säljare tar, utan kvittensskärm och utan ett extra tryck.
 */
/**
 * Adressen appen läser sitt vägval ur — som ett tillstånd, inte som en engångsläsning.
 *
 * VARFÖR EN LYSSNARE. Vägvalet i App nedan är fyra läsningar av `window.location.pathname` i
 * renderkroppen, och en läsning som ingenting prenumererar på uppdateras aldrig. Undersidorna har
 * egna routrar som byter adress med pushState följt av en PopStateEvent (butik/router.ts,
 * kop/router.ts). Så länge en sådan navigering håller sig inom SIN app märks det inte — appen är
 * redan monterad och har sin egen lyssnare.
 *
 * Den går sönder när navigeringen korsar gränsen mellan två av apparna, vilket toppradens
 * profilknapp gör: den står i den delade ramen på /kop och pekar på /butik/profil. Adressen byttes,
 * men App räknade aldrig om sitt vägval — KopApp satt kvar, fick en adress den inte känner igen och
 * föll tillbaka på sin landningssida. Knappen såg död ut, och det var precis vad den var.
 *
 * popstate täcker båda hållen: webbläsarens bakåtknapp och de egna routrarnas pushState, som
 * uttryckligen skickar samma händelse efter sig just för att kunna läsas här.
 */
function usePathname(): string {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const las = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", las);
    // Adressen kan ha hunnit bytas mellan första renderingen och att lyssnaren satt på plats.
    las();
    return () => window.removeEventListener("popstate", las);
  }, []);
  return pathname;
}

export default function App() {
  /**
   * /c/LP-XXXX-XXXX — det publika kortet, FÖRE inloggningen.
   *
   * Den som kommer hit har läst ett Loopa-ID i en Tradera-annons och har inget konto. Att först visa
   * en inloggningsruta vore att stänga det enda som gör annonsens skickpåstående kontrollerbart.
   * Läses ur adressen en gång: appen har ingen router, och den här vägen har ingen väg vidare in i
   * flödet.
   */
  const pathname = usePathname();

  const publicId = loopaIdFromPath(pathname);

  /**
   * /integritetspolicy, /cookies, /villkor — utanför flödet, och före allt annat.
   *
   * Läses ur adressen på samma sätt som det publika kortet och av samma skäl: appen har ingen
   * router. De ligger FÖRE kortet i ordningen bara för att de är exakta adresser medan kortets är
   * ett mönster — inte för att de kan krocka.
   */
  const legalDoc = legalDocFromPath(pathname);

  /**
   * /butik/** — köpsidan.
   *
   * Läses här av samma skäl som kortet och de juridiska sidorna: valet mellan butik och säljflöde är
   * ett vägval på adressen. Till skillnad från dem har butiken en EGEN router inuti sig (se
   * butik/router.ts) — den har många adresser som ska gå att dela och backa i, medan säljflödet
   * medvetet inte har någon.
   */
  const butik = isButikPath(pathname);

  /**
   * /kop — köpsidan.
   *
   * Prövas EFTER Trygg affär i ordningen nedan, för att `/kop/analysera` tillhör den routern sedan
   * tidigare och redan finns i delade länkar. `isKopPath` undantar den vägen uttryckligen; ordningen
   * här är bältet till de hängslena.
   */
  const kop = isKopPath(pathname);

  /**
   * /kop/analysera, /a/:token, /affar/:id — Trygg affär.
   *
   * Läses här av samma skäl som butiken: det är ett vägval på adressen. Inbjudan (/a/:token) är den
   * enda sidan i produkten en okänd person når utan konto, och den måste därför ligga FÖRE varje
   * inloggningsgrind — precis som det publika kortet gör.
   */
  const affar = isAffarPath(pathname);

  return (
    <>
      {affar ? (
        <AffarApp />
      ) : kop ? (
        <KopApp />
      ) : butik ? (
        <ButikApp />
      ) : legalDoc ? (
        <LegalScreen doc={legalDoc} />
      ) : publicId ? (
        <PublicCardScreen initialId={publicId} />
      ) : (
        <FlowApp />
      )}
      {/* Utanför växlingen ovan: rutan ska finnas på varje väg in i appen — även på det publika
          kortet, som är det enda stället där något funktionellt faktiskt lagras. */}
      <CookieConsent />
    </>
  );
}

/**
 * Skärmarna som klarar sig utan konto.
 *
 * Allt annat är kontobundet: jobbet ägs av en säljare, annonsen ligger i en profil, adminvyerna
 * frågar efter en roll. Listan är därför liten med flit — den är villkoret för att appen ska gå att
 * öppna utloggad, inte en uppräkning av undantag.
 */
const OPEN_SCREENS = new Set<Screen["name"]>(["home", "capture", "signup", "login"]);

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

function FlowApp() {
  const { user } = useAuth();
  const isAdmin = useMediaSession(user?.id);
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const homeKey = useRef(0);

  const goHome = () => {
    homeKey.current += 1;
    setScreen({ name: "home" });
  };

  /**
   * En utloggning — eller en session som tog slut — drar undan underlaget för allt kontobundet. De
   * skärmarna har inget att rita då, och att lämna dem stående tomma är sämre än att gå hem: hemma
   * finns märkeslistan, och den fungerar utan konto.
   *
   * Villkoret är att kontot FÖRSVANN, inte att det saknas. Skillnaden är hela grinden: `signUp` följt
   * av `signIn` lämnar sessionen färdig i supabase-klienten, men beskedet hit går via en lyssnare och
   * kan komma ett ögonblick senare. Den som just skapat sitt konto står då på uppladdningen med
   * `user` fortfarande null — och en regel som läser det som "utloggad" hade kastat hem dem mitt i
   * det flöde hela ändringen finns för att hålla ihop. Anropen bär sin token från klienten, inte
   * härifrån, så uppladdningen påverkas inte av att React ligger efter.
   */
  /**
   * Affären säljaren kom hit från (Trygg affär), läst ur adressen EN gång.
   *
   * Säljaren landar på `/?affar=<id>` från inbjudan. Id:t hålls i en ref och inte i skärmens
   * tillstånd, för det överlever hela flödet — märke, filmning, inloggning, uppladdning — och ska
   * inte behöva bäras vidare av varje skärmbyte. Det används på två ställen: förifyllningen på
   * startsidan, och märkningen av jobbet vid uppladdningen.
   *
   * Adressen städas efteråt så att en omladdning mitt i flödet inte startar om från inbjudan.
   */
  const dealId = useRef<string | null>(null);
  if (dealId.current === null) {
    const fromUrl = new URLSearchParams(window.location.search).get("affar");
    if (fromUrl) {
      dealId.current = fromUrl;
      window.history.replaceState({}, "", window.location.pathname);
    }
  }

  /**
   * `/?admin=1` öppnar adminpanelen direkt.
   *
   * Panelen har ingen egen adress — säljverktyget väljer skärm i tillstånd och saknar router med
   * flit. Butikens profil behöver ändå en väg hit, och en frågeparameter läst en gång vid start är
   * den minsta som inte kräver en router. Samma mönster som `?affar=` ovan, städas likadant.
   *
   * INGEN GRIND HÄR. Flaggan säger bara vilken skärm som ritas; panelens data ligger bakom
   * /api/admin, som prövar rollen på varje anrop. Den som gissar adressen ser en tom panel.
   */
  const [openAdmin] = useState(() => {
    const vill = new URLSearchParams(window.location.search).get("admin") === "1";
    if (vill) window.history.replaceState({}, "", window.location.pathname);
    return vill;
  });
  useEffect(() => {
    if (openAdmin && isAdmin) setScreen({ name: "admin" });
  }, [openAdmin, isAdmin]);

  const hadAccount = useRef(false);
  useEffect(() => {
    if (user) {
      hadAccount.current = true;
      return;
    }
    if (!hadAccount.current || OPEN_SCREENS.has(screen.name)) return;
    /**
     * Uppladdningen är undantaget: där ligger säljarens ENDA kopia av varvet, i minnet, och att gå
     * hem därifrån är att be dem filma om möbeln för att sessionen tog slut. De skickas till
     * inloggningen med bildrutorna kvar i skärmens tillstånd, och kommer tillbaka hit efteråt.
     */
    if (screen.name === "starting") {
      setScreen({ name: "signup", identity: screen.identity, shots: screen.shots, resume: true });
      return;
    }
    goHome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, screen.name]);

  switch (screen.name) {
    case "home":
      return (
        <HomeScreen
          key={homeKey.current}
          dealId={dealId.current}
          // Grinden ligger på märkesvalet: att välja märke är att börja sälja, och att sälja kräver
          // ett konto. Den utloggade möts av inloggningen med registreringsfliken uppe, och märket
          // följer med — efteråt öppnas kameran på det märke de redan tryckt på.
          onStartScan={(identity) =>
            setScreen(user ? { name: "capture", identity } : { name: "signup", identity })
          }
          // Utan konto finns ingen profil att öppna, och då är knappen vägen in i inloggningen.
          onOpenProfile={() => setScreen(user ? { name: "profile" } : { name: "login" })}
        />
      );
    case "capture":
      return (
        <CaptureScreen
          identity={screen.identity}
          initialShots={screen.shots}
          onBack={goHome}
          // HÄR ligger grinden. Jobbet knyts till en säljare på servern, så det kan inte skapas utan
          // konto — men det är också först nu det saknas något. Den som har konto märker inget.
          onCaptured={(shots) =>
            setScreen(
              user
                ? { name: "starting", identity: screen.identity, shots }
                : { name: "signup", identity: screen.identity, shots },
            )
          }
        />
      );
    case "signup":
      return (
        <AuthScreen
          intent="flow"
          // Den som tappat sin session har redan ett konto — då är "logga in" fliken de behöver.
          initialTab={screen.resume ? "signin" : undefined}
          // Rakt in i uppladdningen. Sessionen finns när det här anropas, så jobbet får sin token —
          // och säljaren får ingen kvittensskärm att trycka bort, bara flödet de redan var i.
          onDone={() =>
            setScreen(
              screen.shots
                ? { name: "starting", identity: screen.identity, shots: screen.shots }
                : { name: "capture", identity: screen.identity },
            )
          }
          onBack={() => {
            // Utan film kom de hit från märkeslistan, och då är startsidan vägen tillbaka —
            // kameran har de aldrig sett.
            if (screen.shots) setScreen({ name: "capture", identity: screen.identity, shots: screen.shots });
            else goHome();
          }}
        />
      );
    case "login":
      return <AuthScreen onDone={goHome} onBack={goHome} />;
    case "starting":
      return (
        <StartingJob
          dealId={dealId.current}
          identity={screen.identity}
          shots={screen.shots}
          onStarted={(jobId) =>
            setScreen({ name: "identify", jobId, identity: screen.identity, previewShots: screen.shots })
          }
          onBack={() => setScreen({ name: "capture", identity: screen.identity, shots: screen.shots })}
          onNeedsLogin={() =>
            setScreen({ name: "signup", identity: screen.identity, shots: screen.shots, resume: true })
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
            // Jobbet hämtas om, och kortet får den FÄRSKA versionen. Skickvyn slutar polla när
            // fyndlistan och annonsen står — priset kan skrivas in en stund efter det, och kortet
            // visar det som "Inget prisförslag" om det byggs på skärmens gamla ögonblicksbild.
            const job = await getJob(screen.jobId).catch(() => undefined);
            setScreen({ name: "listing", jobId: screen.jobId, result: job?.result ?? result, loopaId: job?.loopaId });
          }}
        />
      );
    case "listing": {
      const back = screen.back ?? { name: "result" as const, jobId: screen.jobId };
      // Adminvägen öppnar samma skärm för någon annans möbel. "Till dina annonser" hade tagit
      // adminen till sin EGEN profil därifrån — så den vägen finns bara för säljarens eget kort.
      const ownCard = screen.back?.name !== "adminUser";
      return (
        <ListingScreen
          result={screen.result}
          loopaId={screen.loopaId}
          onBack={() => setScreen(back)}
          onHome={goHome}
          onMyListings={ownCard ? () => setScreen({ name: "profile" }) : undefined}
        />
      );
    }
    case "profile":
      return (
        <ProfileScreen
          onBack={goHome}
          isAdmin={isAdmin}
          onOpenAdmin={() => setScreen({ name: "admin" })}
          // Profilen öppnar kortet, inte fyndlistan: det är annonsen som sparats, och vägen
          // tillbaka till skicket finns kvar inifrån det.
          onOpenJob={async (row) => {
            const job = await getJob(row.id);
            if (job.result) setScreen({ name: "listing", jobId: row.id, result: job.result, loopaId: job.loopaId });
            else setScreen({ name: "result", jobId: row.id });
          }}
        />
      );
    case "admin":
      return (
        <AdminScreen
          flik={screen.flik}
          onBack={() => setScreen({ name: "profile" })}
          onOpenUser={(u) => setScreen({ name: "adminUser", user: u })}
          onOpenAd={(rad) => setScreen({ name: "adminAd", loopaId: rad.id })}
          onOpenAdId={(loopaId) => setScreen({ name: "adminAd", loopaId })}
        />
      );
    case "adminAd":
      return (
        <AdminAdScreen loopaId={screen.loopaId} onBack={() => setScreen({ name: "admin", flik: "annonser" })} />
      );
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
            if (job.result) setScreen({ name: "listing", jobId, result: job.result, loopaId: job.loopaId, back: from });
          }}
        />
      );
    }
  }
}

/**
 * Väntan medan annonsen byggs. Ligger här och inte i respektive grind för att den syns TVÅ gånger:
 * en gång direkt efter modellvalet, medan servern arbetar vidare i bakgrunden, och en gång i
 * specifikationsgrinden som pollar in samma annons. Två skärmar som menar samma sak ska inte kunna
 * glida isär.
 */
function BuildingListing() {
  const t = useT();
  return (
    <div className="screen screen-light center-column">
      <ListingBuildLoader />
      <p className="wait-title">{t("Bygger annonsen…")}</p>
      <p className="muted small">{t("Hämtar mått, material och specifikationer")}</p>
    </div>
  );
}

/**
 * Uppladdningen: bilderna blir ett jobb, och jobbet börjar leta modell.
 *
 * Ligger på en egen skärm och inte kvar i kameran, för att den kan följa direkt på en registrering.
 * Den som just skapat sitt konto ska inte skickas tillbaka till granskningsvyn för att trycka
 * "starta" en gång till — steget de redan tagit ska inte behöva tas om för att kontot kom emellan.
 * Skärmen startar därför jobbet själv och lämnar över till identifieringen i samma stund som
 * servern svarat.
 */
function StartingJob({
  identity,
  shots,
  dealId,
  onStarted,
  onBack,
  onNeedsLogin,
}: {
  identity: FurnitureIdentity;
  shots: CapturedShot[];
  /**
   * Affären skanningen tillhör, när säljaren kommit hit via en inbjudan (Trygg affär).
   *
   * Följer med ända hit och inte bara till startsidan: märkningen måste sitta på jobbet från
   * skapandet, annars är skanningen publik i glappet — se createJob.
   */
  dealId: string | null;
  onStarted: (jobId: string) => void;
  onBack: () => void;
  /** Sessionen bar inte hela vägen. Bilderna ligger kvar — säljaren ska logga in, inte filma om. */
  onNeedsLogin: () => void;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /**
   * Ett anrop per försök, aldrig två: StrictMode kör effekten dubbelt i utvecklingsläget, och sex
   * bilder som laddas upp två gånger blir två jobb på samma varv.
   *
   * Spärren är en räknare och inte en flagga, för att omtaget efter ett fel ska släppas igenom. Och
   * effekten har ingen avbrottsstädning: den hade i StrictMode avbrutit just det anrop spärren låter
   * passera, och skärmen blivit stående på spinnern.
   */
  const startedAttempt = useRef(-1);

  useEffect(() => {
    if (startedAttempt.current === attempt) return;
    startedAttempt.current = attempt;
    createJob(shots, identity, dealId)
      .then(({ jobId }) => onStarted(jobId))
      .catch((err) => {
        /**
         * "Bilderna kom inte fram" är fel besked när sessionen är det som saknas: bildrutorna ligger
         * kvar, ingenting behöver göras om, och "försök igen" hade gett exakt samma svar varje gång.
         * Den vägen leder till inloggningen i stället — och tillbaka hit när den är klar.
         */
        if (err instanceof AuthRequiredError) return onNeedsLogin();
        setError(err instanceof Error ? err.message : t("Kunde inte starta analysen."));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  if (error) {
    return (
      <div className="screen screen-light center-column">
        <h2 className="failure-title">{t("Bilderna kom inte fram")}</h2>
        <p className="muted small">{error}</p>
        {/* Bildrutorna ligger kvar i minnet, så omtaget skickar samma varv igen. Ingen filmar om. */}
        <button
          className="btn btn-primary"
          onClick={() => {
            setError(null);
            setAttempt((n) => n + 1);
          }}
        >
          {t("Försök igen")}
        </button>
        <button className="btn btn-text" onClick={onBack}>
          {t("Tillbaka till bilderna")}
        </button>
      </div>
    );
  }
  return (
    <div className="screen screen-light center-column">
      <div className="spinner" />
      <p className="wait-title">{t("Laddar upp bilder…")}</p>
      <p className="muted small">{t("Analysen startar av sig själv när de är uppe")}</p>
    </div>
  );
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
  const t = useT();
  const [sent, setSent] = useState(false);
  /**
   * Ett omval startar om pollningen.
   *
   * Den stannade när kandidaterna landade — det var hela dess villkor — och skärmen som ber om nya
   * förslag har inget som hämtar dem utan den här nyckeln.
   */
  const [searchKey, setSearchKey] = useState(0);
  /** Bryggar glappet mellan trycket på "hitta nya" och serverns besked om att sökningen börjat. */
  const [starting, setStarting] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
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
    searchKey,
  );

  // Servern flippar jobbet till sökläge INNAN den svarar, så det beskedet är allt som behövs för att
  // lämna över väntan till pollningen.
  useEffect(() => {
    if (job?.identityStatus === "identifying") setStarting(false);
  }, [job?.identityStatus]);

  /** "Ingen av dem" — be om fyra andra. De avfärdade ligger kvar på jobbet och kommer inte igen. */
  async function findNew() {
    setStarting(true);
    setSearchError(null);
    try {
      await findMoreModels(jobId);
      setSearchKey((n) => n + 1);
    } catch (err) {
      setStarting(false);
      setSearchError(err instanceof Error ? err.message : t("Vi kunde inte söka efter fler modeller just nu."));
    }
  }

  async function choose(choice: { candidate?: ModelCandidate; manualModel?: string }) {
    setSent(true);
    // Servern svarar 202 och arbetar vidare i bakgrunden; specifikationsskärmen pollar själv. Att
    // vänta in hela annonsen här hade gjort valet till en tyst paus på tjugo sekunder.
    await selectModel(jobId, choice);
    onResolved();
  }

  if (sent || job?.identityStatus === "resolved") {
    return <BuildingListing />;
  }
  // Ö.6: identifieringen får aldrig sluta i en återvändsgränd. Faller den — eller dör jobbet, eller
  // ger klienten upp — landar säljaren på samma skärm med noll kandidater och kan skriva namnet själv.
  // En misslyckad identifiering ska kosta ett handgrepp, inte en omstart.
  const stalled = gaveUp || failed || job?.identityStatus === "unavailable";
  const round = job?.candidateRound ?? 0;
  const brandModels = identity.brand ? t("{märke}-modeller", { märke: identity.brand }) : t("modeller");
  if (starting || (!stalled && (!job || job.identityStatus === "identifying" || !job.identityStatus))) {
    // Samma väntan, annan mening: första gången letas modellen upp, sedan letas den vidare bland de
    // som blir kvar. Att säga "Letar upp modellen…" en andra gång hade sett ut som att inget hänt.
    const again = starting || round > 0;
    return (
      <div className="screen screen-light center-column">
        <ModelSearchLoader />
        <p className="wait-title">{again ? t("Letar efter andra modeller…") : t("Letar upp modellen…")}</p>
        <p className="muted small">
          {again
            ? t("Söker vidare bland {modeller} — de du sagt nej till räknas bort", { modeller: brandModels })
            : t("Söker efter {modeller} som stämmer med bilderna", { modeller: brandModels })}
        </p>
      </div>
    );
  }
  // Ett fallet omval säger det med en rad, inte med en tom skärm: säljaren ska veta varför de inte
  // fick några nya förslag.
  const note = searchError ?? (stalled ? null : job?.identityError ?? null);
  return (
    <>
      {(stalled || note) && (
        <p className="identify-fallback-note identify-fallback-floating">
          {note ??
            (gaveUp
              ? t("Vi fick inget svar från servern.")
              : failed
                ? job?.error ?? t("Analysen avbröts.")
                : t("Vi kunde inte söka fram några modeller just nu."))}
        </p>
      )}
      <ModelSelectScreen
        brand={identity.brand}
        candidates={job?.candidates ?? []}
        round={round}
        // Bilderna fylls i av pollningen ovan, och den slutar när den fått sitt sista besked eller
        // gett upp. Efter det ska ingen ruta stå och skimra som om något vore på väg.
        searchingImages={!stalled}
        onSelect={(candidate) => choose({ candidate })}
        onManual={(manualModel) => choose({ manualModel })}
        onFindNew={findNew}
      />
    </>
  );
}

/** Väntar in annonsen efter modellvalet. */
function SpecsGate({ jobId, onNext, onBack }: { jobId: string; onNext: () => void; onBack: () => void }) {
  const t = useT();
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
        <h2 className="failure-title">{t("Annonsen blev inte klar")}</h2>
        <p className="muted small">{gaveUp ? t("Vi fick inget svar från servern.") : job?.error}</p>
        <button className="btn btn-primary" onClick={onNext}>
          {t("Fortsätt ändå")}
        </button>
        <button className="btn btn-text" onClick={onBack}>
          {t("Byt modell")}
        </button>
      </div>
    );
  }
  if (!listing || listing.status === "pending") {
    return <BuildingListing />;
  }
  if (!listing.result) {
    return (
      <div className="screen screen-light center-column">
        <h2 className="failure-title">{t("Annonsen kunde inte skapas")}</h2>
        <p className="muted small">{listing.unavailableReason}</p>
        <button className="btn btn-primary" onClick={onNext}>
          {t("Fortsätt till priset ändå")}
        </button>
        <button className="btn btn-text" onClick={onBack}>
          {t("Byt modell")}
        </button>
      </div>
    );
  }
  return <SpecsScreen card={listing.result} onNext={onNext} onBack={onBack} />;
}

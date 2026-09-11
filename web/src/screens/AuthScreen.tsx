import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { ArrowLeftIcon, EyeIcon, EyeOffIcon, LockIcon, MailIcon } from "../components/icons";
import { usePageTitle } from "../lib/pageTitle";
import { t as translate, useT } from "../lib/i18n";
import LegalLink from "../components/LegalLink";

/**
 * Inloggningen: ordmärket, två fält, en knapp.
 *
 * Ett konto som redan finns i Vips fungerar här utan registrering — det är samma Supabase-projekt.
 *
 * Skärmen har tre lägen, och skillnaden är var i besöket den dyker upp. `account` är den som öppnas
 * ur topplisten av någon som vill åt sin profil. `flow` är grinden mitt i säljflödet: varvet är
 * filmat, bilderna ligger och väntar, och det enda som saknas är ett konto att hänga annonsen på.
 * `sale` är grinden FÖRE flödet: säljaren har tryckt på sitt märke och ingenting är filmat än.
 *
 * `kop` är grinden i KASSAN, och den enda som inte handlar om att sälja: köparen har valt en möbel,
 * skrivit sitt postnummer och tryckt "Logga in och betala". Texten måste säga vad kontot är till för
 * i just det ärendet — ordern, leveranstiden, kvittot — och framför allt att möbeln ligger kvar.
 *
 * De två föregående är samma grind på två olika ställen, och texten måste säga vilket. "Bilderna är klara"
 * är sant efter filmningen och en ren gåta före den — den som just tryckt på IKEA har inga bilder och
 * undrar vems de är. I båda lägena är registrering det troliga ärendet, så den fliken ligger uppe från
 * början — den som redan har ett konto byter med ett tryck, medan den som inte har det annars hade
 * mötts av fel formulär.
 */
export default function AuthScreen({
  intent = "account",
  initialTab,
  inbaddad = false,
  onDone,
  onBack,
}: {
  intent?: "account" | "flow" | "sale" | "kop";
  /**
   * Skärmen ligger INUTI en annan sida — butikens spalt, ett ark ovanpå köpsidan.
   *
   * Den är ritad som en helsida: full skärmhöjd och en bakgrund som tonar ut mot kanterna. Släppt i
   * en spalt med maxbredd klipps den bakgrunden till en rektangel med synliga kanter mitt på sidan,
   * och blocket får en tomhet under sig som ingen bett om. Flaggan tar bort helsidesdelarna och
   * lämnar formuläret.
   */
  inbaddad?: boolean;
  /** Fliken skärmen öppnar på. Utelämnad följer den `intent` — se `tab` nedan. */
  initialTab?: "signin" | "signup";
  /** Inloggningen gick igenom. Anropas när sessionen finns, så det som följer kan bära dess token. */
  onDone?: () => void;
  /** Vägen ur inloggningen. Utelämnad betyder att skärmen är en återvändsgränd med flit. */
  onBack?: () => void;
}) {
  const { signIn, signUp } = useAuth();
  /** Grinden i eller före flödet — båda öppnar på registreringsfliken. */
  const flow = intent === "flow" || intent === "sale";
  /** Grinden FÖRE filmningen. Samma grind, men ingenting är gjort än, och det ska texten säga. */
  const sale = intent === "sale";
  /** Grinden i kassan. Köparens ärende, inte säljarens — se resonemanget överst. */
  const kop = intent === "kop";
  const [tab, setTab] = useState<"signin" | "signup">(initialTab ?? (flow ? "signup" : "signin"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  const t = useT();
  const isSignup = tab === "signup";
  // Inbäddad rör vi inte fliktiteln: sidan bakom arket äger den. Se usePageTitle.
  usePageTitle(inbaddad ? undefined : isSignup ? "Skapa konto" : "Logga in");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (isSignup) {
        const { error } = await signUp(email, password);
        if (error) throw error;
        // Kontot är skapat — logga in direkt i stället för att skicka säljaren tillbaka till
        // formuläret med samma uppgifter en gång till.
        const { error: signInError } = await signIn(email, password);
        if (signInError) {
          setTab("signin");
          setMessage({ tone: "info", text: t("Kontot är skapat. Logga in för att fortsätta.") });
          return;
        }
        onDone?.();
      } else {
        const { error } = await signIn(email, password);
        if (error) throw error;
        onDone?.();
      }
    } catch (err) {
      setMessage({ tone: "error", text: readError(err, isSignup) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={inbaddad ? "auth-screen auth-inbaddad" : "auth-screen"}>
      {/* Utanför .auth-inner: den är ett rutnät i datorvyn där varje del har sin ruta utpekad, och
          ett barn till hade auto-placerats i någon annans. */}
      {onBack && (
        <button type="button" className="btn btn-text btn-back auth-back" onClick={onBack}>
          <ArrowLeftIcon /> {t("Tillbaka")}
        </button>
      )}
      <div className="auth-inner">
        <div className="auth-wordmark">Loopa</div>

        <div className="auth-hero">
          <h1 className="auth-title">
            {kop ? (
              isSignup ? (
                <>
                  {t("Skapa konto och")} <span className="auth-wordmark-inline">{t("betala")}</span>
                </>
              ) : (
                <>
                  {t("Logga in och")} <span className="auth-wordmark-inline">{t("betala")}</span>
                </>
              )
            ) : sale ? (
              <>
                {t("Sälj din")} <span className="auth-wordmark-inline">{t("möbel")}</span>
              </>
            ) : flow ? (
              <>
                {t("Bilderna är")} <span className="auth-wordmark-inline">{t("klara")}</span>
              </>
            ) : isSignup ? (
              <>
                {t("Välkommen till")} <span className="auth-wordmark-inline">Loopa</span>
              </>
            ) : (
              <>
                {t("Välkommen")} <span className="auth-wordmark-inline">{t("tillbaka")}</span>
              </>
            )}
          </h1>
          {/* Leden säger vad som händer NÄST, inte vad appen gör. Efter filmningen är det beskedet att
              steget är det sista före resultatet och att varvet inte ska göras om. Före den är det
              motsatta beskedet som behövs: ingenting är gjort än, och det som väntar är kameran. */}
          <p className="auth-lede">
            {kop
              ? isSignup
                ? t("Kontot är där ordern, leveranstiden och kvittot hamnar. Möbeln ligger kvar medan du skapar det.")
                : t("Logga in, så fortsätter vi till betalningen. Möbeln ligger kvar i kassan.")
              : sale
              ? isSignup
                ? t("Skapa ett konto, så filmar du ett varv runt möbeln — sedan gör vi annonsen och säljer den.")
                : t("Logga in, så fortsätter vi till filmningen av din möbel.")
              : flow
              ? isSignup
                ? t("Skapa ett konto, så sätter vi igång på en gång. Du behöver inte filma om.")
                : t("Logga in, så fortsätter vi där du var. Bilderna ligger kvar.")
              : isSignup
                ? t("Filma ett varv runt möbeln. Vi gör annonsen, säljer den och hör av oss när den är såld.")
                : t("Dina annonser finns kvar där du lämnade dem.")}
          </p>
        </div>

        <div className="auth-tabs">
          <div className={`auth-tabs-thumb ${isSignup ? "auth-tabs-thumb-right" : ""}`} aria-hidden />
          <button type="button" className={!isSignup ? "auth-tab auth-tab-active" : "auth-tab"} onClick={() => setTab("signin")}>
            {t("Logga in")}
          </button>
          <button type="button" className={isSignup ? "auth-tab auth-tab-active" : "auth-tab"} onClick={() => setTab("signup")}>
            {t("Skapa konto")}
          </button>
        </div>

        <div className="auth-card">
          <form className="auth-form" onSubmit={submit}>
            <label className="auth-field">
              <span className="auth-label">{t("E-post")}</span>
              <span className="auth-input-wrap">
                <span className="auth-input-icon">
                  <MailIcon />
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  placeholder="din@email.se"
                />
              </span>
            </label>

            <label className="auth-field">
              <span className="auth-label">{t("Lösenord")}</span>
              <span className="auth-input-wrap">
                <span className="auth-input-icon">
                  <LockIcon />
                </span>
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={isSignup ? 6 : undefined}
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  placeholder={isSignup ? t("Minst 6 tecken") : "••••••••"}
                />
                <button
                  type="button"
                  className="auth-input-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t("Dölj lösenord") : t("Visa lösenord")}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </span>
            </label>

            {message && <p className={`auth-message auth-message-${message.tone}`}>{message.text}</p>}

            <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
              {busy
                ? isSignup
                  ? t("Skapar konto…")
                  : t("Loggar in…")
                : isSignup
                  ? t("Skapa konto")
                  : t("Logga in")}
            </button>
          </form>

          <div className="auth-tagline">{t("Secondhand på autopilot")}</div>
        </div>

        {/* Meningen har stått här sedan skärmen skrevs, men dokumenten den hänvisade till fanns inte
            — och ett godkännande av något som inte går att läsa är inget godkännande. Länkarna
            öppnas i en ny flik med flit: i `flow`-läget ligger säljarens filmade bildrutor i minnet
            och en vanlig navigering härifrån hade kastat bort dem. Se lib/legal.ts. */}
        <p className="auth-terms">
          {t("Samma konto som på Vips. Genom att fortsätta godkänner du")}{" "}
          <LegalLink doc="terms">{t("användarvillkoren")}</LegalLink> {t("och")}{" "}
          <LegalLink doc="privacy">{t("integritetspolicyn")}</LegalLink>.
        </p>
      </div>
    </div>
  );
}

function readError(err: unknown, isSignup: boolean): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : (err as { message?: string })?.message;
  if (!raw) return isSignup ? translate("Kontot kunde inte skapas.") : translate("Inloggningen misslyckades.");
  if (/invalid login credentials/i.test(raw)) return translate("Fel e-post eller lösenord.");
  if (/already registered|email_exists|EMAIL_EXISTS/i.test(raw)) {
    return translate("E-postadressen används redan — logga in i stället.");
  }
  if (/password/i.test(raw)) return translate("Lösenordet måste vara minst 6 tecken.");
  if (/email/i.test(raw)) return translate("Ogiltig e-postadress.");
  return raw;
}

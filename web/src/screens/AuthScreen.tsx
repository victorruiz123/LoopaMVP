import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { EyeIcon, EyeOffIcon, LockIcon, MailIcon } from "../components/icons";

/**
 * Inloggningen: ordmärket, två fält, en knapp.
 *
 * Ett konto som redan finns i Vips fungerar här utan registrering — det är samma Supabase-projekt.
 */
export default function AuthScreen() {
  const { signIn, signUp } = useAuth();
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  const isSignup = tab === "signup";

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
          setMessage({ tone: "info", text: "Kontot är skapat. Logga in för att fortsätta." });
        }
      } else {
        const { error } = await signIn(email, password);
        if (error) throw error;
      }
    } catch (err) {
      setMessage({ tone: "error", text: readError(err, isSignup) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-inner">
        <div className="auth-wordmark">Loopa</div>

        <div className="auth-hero">
          <h1 className="auth-title">
            {isSignup ? (
              <>
                Välkommen till <span className="auth-wordmark-inline">Loopa</span>
              </>
            ) : (
              <>
                Välkommen <span className="auth-wordmark-inline">tillbaka</span>
              </>
            )}
          </h1>
          <p className="auth-lede">
            {isSignup
              ? "Filma ett varv runt möbeln. Du får skick, pris och färdig annons."
              : "Dina truth-cards finns kvar där du lämnade dem."}
          </p>
        </div>

        <div className="auth-tabs">
          <div className={`auth-tabs-thumb ${isSignup ? "auth-tabs-thumb-right" : ""}`} aria-hidden />
          <button type="button" className={!isSignup ? "auth-tab auth-tab-active" : "auth-tab"} onClick={() => setTab("signin")}>
            Logga in
          </button>
          <button type="button" className={isSignup ? "auth-tab auth-tab-active" : "auth-tab"} onClick={() => setTab("signup")}>
            Skapa konto
          </button>
        </div>

        <div className="auth-card">
          <form className="auth-form" onSubmit={submit}>
            <label className="auth-field">
              <span className="auth-label">E-post</span>
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
              <span className="auth-label">Lösenord</span>
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
                  placeholder={isSignup ? "Minst 6 tecken" : "••••••••"}
                />
                <button
                  type="button"
                  className="auth-input-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Dölj lösenord" : "Visa lösenord"}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </span>
            </label>

            {message && <p className={`auth-message auth-message-${message.tone}`}>{message.text}</p>}

            <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
              {busy ? (isSignup ? "Skapar konto…" : "Loggar in…") : isSignup ? "Skapa konto" : "Logga in"}
            </button>
          </form>

          <div className="auth-tagline">Secondhand på autopilot</div>
        </div>

        <p className="auth-terms">
          Samma konto som på Vips. Genom att fortsätta godkänner du användarvillkoren och
          integritetspolicyn.
        </p>
      </div>
    </div>
  );
}

function readError(err: unknown, isSignup: boolean): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : (err as { message?: string })?.message;
  if (!raw) return isSignup ? "Kontot kunde inte skapas." : "Inloggningen misslyckades.";
  if (/invalid login credentials/i.test(raw)) return "Fel e-post eller lösenord.";
  if (/already registered|email_exists|EMAIL_EXISTS/i.test(raw)) return "E-postadressen används redan — logga in i stället.";
  if (/password/i.test(raw)) return "Lösenordet måste vara minst 6 tecken.";
  if (/email/i.test(raw)) return "Ogiltig e-postadress.";
  return raw;
}

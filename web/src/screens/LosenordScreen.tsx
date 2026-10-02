import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { EyeIcon, EyeOffIcon, LockIcon, MailIcon } from "../components/icons";
import { usePageTitle } from "../lib/pageTitle";
import { t as translate, useT } from "../lib/i18n";

/**
 * Glömt lösenord: e-posten, en knapp, och beskedet att länken är på väg.
 *
 * Används på två ställen — i inloggningen bakom "Glömt lösenordet?", och på sidan nedan när länken
 * i mejlet redan hunnit gå ut. Formuläret är detsamma; det är bara vägen dit som skiljer.
 *
 * BESKEDET SÄGER "OM DET FINNS ETT KONTO". Supabase svarar likadant för en adress utan konto, med
 * flit: annars hade rutan gått att använda för att pröva vilka adresser som är kunder hos oss. Att
 * påstå "vi har skickat" vore att ljuga om varje stavfel.
 */
export function GlomtLosenordForm({ startEpost = "", onTillbaka }: { startEpost?: string; onTillbaka?: () => void }) {
  const { skickaAterstallning } = useAuth();
  const t = useT();
  const [email, setEmail] = useState(startEpost);
  const [busy, setBusy] = useState(false);
  const [skickad, setSkickad] = useState<string | null>(null);
  const [fel, setFel] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFel(null);
    setBusy(true);
    try {
      const { error } = await skickaAterstallning(email);
      if (error) throw error;
      setSkickad(email.trim());
    } catch (err) {
      setFel(lasFel(err));
    } finally {
      setBusy(false);
    }
  }

  return (
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
            onChange={(e) => {
              setEmail(e.target.value);
              setSkickad(null);
            }}
            required
            autoComplete="email"
            placeholder="din@email.se"
          />
        </span>
      </label>

      {skickad && (
        <p className="auth-message auth-message-info" role="status">
          {t("Om det finns ett konto för {epost} har vi skickat en länk dit. Öppna den för att välja ett nytt lösenord. Hittar du inget mejl, titta i skräpposten.", { epost: skickad })}
        </p>
      )}
      {fel && <p className="auth-message auth-message-error">{fel}</p>}

      <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
        {busy ? t("Skickar…") : skickad ? t("Skicka igen") : t("Skicka länk")}
      </button>
      {onTillbaka && (
        <button type="button" className="btn btn-text auth-lank" onClick={onTillbaka}>
          {t("Tillbaka till inloggningen")}
        </button>
      )}
    </form>
  );
}

/**
 * Hit kommer den som öppnat länken i återställningsmejlet.
 *
 * Länken har redan loggat in besökaren — det är så Supabase gör det — men inloggningen är bara till
 * för att få byta lösenordet. Därför ligger sidan FÖRE allt annat i App och släpper inte fram något
 * förrän lösenordet är bytt eller besökaren uttryckligen hoppar över.
 *
 * "Hoppa över" loggar ut. Den som ångrar sig har ändå inte kvar sitt gamla lösenord i huvudet, och
 * att släppa in dem på en session de fick via ett mejl — utan att lösenordet ändrats — gör mejlet
 * till ett lösenord i sig.
 */
export default function NyttLosenordScreen() {
  const { losenordslage, bytLosenord, avslutaAterstallning, signOut, user } = useAuth();
  const t = useT();
  const [password, setPassword] = useState("");
  const [visa, setVisa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [klart, setKlart] = useState(false);
  const utgangen = losenordslage === "utgangen";
  usePageTitle(utgangen ? "Länken har gått ut" : "Nytt lösenord");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFel(null);
    setBusy(true);
    try {
      const { error } = await bytLosenord(password);
      if (error) throw error;
      setKlart(true);
    } catch (err) {
      setFel(lasFel(err));
    } finally {
      setBusy(false);
    }
  }

  async function avbryt() {
    avslutaAterstallning();
    if (!utgangen) await signOut();
  }

  return (
    <div className="auth-screen">
      <div className="auth-inner">
        <div className="auth-wordmark">Loopa</div>

        <div className="auth-hero">
          <h1 className="auth-title">
            {utgangen ? (
              <>
                {t("Länken har")} <span className="auth-wordmark-inline">{t("gått ut")}</span>
              </>
            ) : klart ? (
              <>
                {t("Lösenordet är")} <span className="auth-wordmark-inline">{t("bytt")}</span>
              </>
            ) : (
              <>
                {t("Välj ett nytt")} <span className="auth-wordmark-inline">{t("lösenord")}</span>
              </>
            )}
          </h1>
          <p className="auth-lede">
            {utgangen
              ? t("Länken i mejlet gäller en gång och bara en stund. Skriv din e-post så skickar vi en ny.")
              : klart
                ? t("Du är inloggad. Nästa gång loggar du in med det nya lösenordet.")
                : user?.email
                  ? t("För {epost}. Du loggas in direkt när det är bytt.", { epost: user.email })
                  : t("Du loggas in direkt när det är bytt.")}
          </p>
        </div>

        <div className="auth-card">
          {utgangen ? (
            <GlomtLosenordForm onTillbaka={avslutaAterstallning} />
          ) : klart ? (
            <div className="auth-form">
              <button className="btn btn-primary auth-submit" type="button" onClick={avslutaAterstallning}>
                {t("Fortsätt")}
              </button>
            </div>
          ) : (
            <form className="auth-form" onSubmit={submit}>
              <label className="auth-field">
                <span className="auth-label">{t("Nytt lösenord")}</span>
                <span className="auth-input-wrap">
                  <span className="auth-input-icon">
                    <LockIcon />
                  </span>
                  <input
                    type={visa ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete="new-password"
                    placeholder={t("Minst 6 tecken")}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="auth-input-toggle"
                    onClick={() => setVisa((v) => !v)}
                    aria-label={visa ? t("Dölj lösenord") : t("Visa lösenord")}
                  >
                    {visa ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </span>
              </label>

              {fel && <p className="auth-message auth-message-error">{fel}</p>}

              <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
                {busy ? t("Sparar…") : t("Spara lösenordet")}
              </button>
              <button type="button" className="btn btn-text auth-lank" onClick={() => void avbryt()}>
                {t("Avbryt")}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function lasFel(err: unknown): string {
  const raw = err instanceof Error ? err.message : (err as { message?: string })?.message ?? "";
  if (/same.?password|different from the old/i.test(raw)) return translate("Det nya lösenordet måste skilja sig från det gamla.");
  if (/at least|too short|weak/i.test(raw)) return translate("Lösenordet måste vara minst 6 tecken.");
  if (/security purposes|rate limit|too many/i.test(raw)) {
    return translate("Vänta en minut innan du ber om en ny länk.");
  }
  if (/session|jwt|not authenticated/i.test(raw)) {
    return translate("Länken har gått ut. Be om en ny från inloggningen.");
  }
  if (/email/i.test(raw)) return translate("Ogiltig e-postadress.");
  return raw || translate("Något gick fel. Försök igen.");
}

import { useEffect, useState } from "react";
import { getMinInbjudan, loggaLankKopierad } from "../api";
import { useLang, useT } from "../lib/i18n";
import type { MinInbjudan } from "../types";

/**
 * Inbjudan: länken, knapparna, och vad den gett.
 *
 * REGELN står i server/src/referral/regler.ts: den som bjuder in en ny säljare får en försäljning
 * utan Loopas avgift när den inbjudna lägger upp sin första annons. Texten här lovar exakt det och
 * inget mer — inte "när din vän registrerar sig", för det är inte då krediten kommer.
 */

/** Kopierar länken. Faller urklippet (osäker kontext, gammal webbläsare) visas länken markerbar. */
async function kopiera(lank: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(lank);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rutan med länken och de två knapparna. Används i profilen, under de sålda möblerna.
 *
 * "Dela" öppnar telefonens delningsmeny när den finns (Web Share API) och kopierar annars — en knapp
 * som inte gör något på en dator vore sämre än en som gör samma sak som grannen.
 */
export function BjudInRuta({ lank }: { lank: string }) {
  const t = useT();
  const [kopierad, setKopierad] = useState(false);
  const [visaLank, setVisaLank] = useState(false);

  async function onKopiera(kanal: "kopiera" | "dela") {
    const ok = await kopiera(lank);
    setVisaLank(!ok);
    if (ok) {
      setKopierad(true);
      window.setTimeout(() => setKopierad(false), 3000);
    }
    loggaLankKopierad(kanal);
  }

  async function onDela() {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: "Loopa AI",
          text: t("Jag säljer mina möbler med Loopa AI. Du filmar, de sköter resten."),
          url: lank,
        });
        loggaLankKopierad("dela");
      } catch {
        // Stängd delningsmeny. Inget att säga om.
      }
      return;
    }
    await onKopiera("dela");
  }

  return (
    <div className="bjudin-ruta">
      <p className="bjudin-rubrik">{t("Bjud in en vän – din nästa försäljning blir gratis.")}</p>
      <p className="bjudin-not">
        {t("När din vän har lagt upp sin första annons tar vi ingen avgift på din nästa försäljning.")}
      </p>
      <div className="bjudin-knappar">
        <button type="button" className="btn btn-primary btn-small" onClick={() => void onKopiera("kopiera")}>
          {kopierad ? t("Kopierad ✓") : t("Kopiera länk")}
        </button>
        <button type="button" className="btn btn-outline btn-small" onClick={() => void onDela()}>
          {t("Dela")}
        </button>
      </div>
      {visaLank && (
        <input className="bjudin-lank" readOnly value={lank} onFocus={(e) => e.currentTarget.select()} aria-label={t("Din inbjudningslänk")} />
      )}
    </div>
  );
}

/**
 * Profilens avdelning: rutan, krediterna och de inbjudna.
 *
 * Laddar sig själv — profilen ska inte vänta på den, och faller den visas ingenting. En inbjudan är
 * ett erbjudande, inte något säljaren behöver för att komma åt sina möbler.
 */
export function ProfilInbjudan() {
  const t = useT();
  const { lang } = useLang();
  const [data, setData] = useState<MinInbjudan | null>(null);

  useEffect(() => {
    let aktiv = true;
    getMinInbjudan()
      .then((d) => aktiv && setData(d))
      .catch(() => undefined);
    return () => {
      aktiv = false;
    };
  }, []);

  if (!data) return null;
  /**
   * Serverns länk när den har en bestämd bas — loopa.nu i drift, datorns nätverksadress lokalt
   * (REFERRAL_LINK_BASE), så att en länk kopierad på datorn också går att öppna på telefonen. Annars
   * sidans egen adress: bättre än en produktionslänk till en sajt som kanske inte har koden.
   */
  const lank = data.lank ?? `${window.location.origin}/?ref=${encodeURIComponent(data.kod)}`;
  const datum = (iso: string) => new Date(iso).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" });
  const tillgangliga = data.krediter.filter((k) => k.status === "available");

  return (
    <>
      <h2 className="profile-section-title">{t("Bjud in en vän")}</h2>
      <BjudInRuta lank={lank} />

      {tillgangliga.length > 0 && (
        <div className="bjudin-krediter">
          <p className="bjudin-krediter-antal">
            {tillgangliga.length === 1
              ? t("Du har 1 gratisförsäljning")
              : t("Du har {antal} gratisförsäljningar", { antal: tillgangliga.length })}
          </p>
          <ul>
            {tillgangliga.map((k) => (
              <li key={k.id}>{t("Gäller till {datum}", { datum: datum(k.gar_ut) })}</li>
            ))}
          </ul>
          <p className="bjudin-not">{t("Du väljer att använda den när du lägger ut nästa möbel.")}</p>
        </div>
      )}

      {data.inbjudna.length > 0 && (
        <ul className="bjudin-inbjudna">
          {data.inbjudna.map((p, i) => (
            <li key={i}>
              <span>{p.email ?? t("En vän")}</span>
              <span className={p.status === "annons" ? "bjudin-status bjudin-status-salt" : "bjudin-status"}>
                {p.status === "annons" ? t("Har lagt upp en annons") : t("Registrerad")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

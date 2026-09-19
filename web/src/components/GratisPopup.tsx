import { useCallback, useEffect, useState } from "react";
import { hamtaNyKredit, markeraKreditVisad } from "../api";
import { useAuth } from "../auth/AuthProvider";
import { useT } from "../lib/i18n";

/**
 * "Din nästa försäljning är gratis!" — till inbjudaren, när vännen lagt upp sin första annons.
 *
 * EN GÅNG PER KREDIT. Servern håller reda på vad som visats (referral_credits.shown_at), så beskedet
 * kommer på den enhet där inbjudaren råkar vara och inte igen på nästa.
 *
 * Frågar när appen öppnas och när fliken kommer tillbaka i fokus. Vännen lägger ofta upp sin annons
 * medan inbjudaren har appen öppen i en annan flik, och beskedet ska möta dem när de tittar tillbaka
 * — inte först vid nästa omladdning. Ingen pollning utöver det: det här är en glad nyhet, inte ett
 * larm.
 */
export default function GratisPopup() {
  const t = useT();
  const { user } = useAuth();
  const [kredit, setKredit] = useState<{ id: string; van: string | null } | null>(null);

  const kolla = useCallback(() => {
    if (!user) return;
    hamtaNyKredit()
      .then((svar) => setKredit((nu) => nu ?? svar.kredit))
      .catch(() => undefined);
  }, [user]);

  useEffect(() => {
    kolla();
    const synlig = () => document.visibilityState === "visible" && kolla();
    document.addEventListener("visibilitychange", synlig);
    return () => document.removeEventListener("visibilitychange", synlig);
  }, [kolla]);

  if (!kredit) return null;

  function stang() {
    if (!kredit) return;
    void markeraKreditVisad(kredit.id).catch(() => undefined);
    setKredit(null);
  }

  return (
    <div className="gratis-root" role="dialog" aria-modal="true" aria-labelledby="gratis-rubrik">
      <div className="gratis-scrim" onClick={stang} />
      <div className="gratis-popup">
        <div className="gratis-popup-ikon" aria-hidden>🎉</div>
        <h2 id="gratis-rubrik">{t("Din nästa försäljning är gratis!")}</h2>
        <p>
          {kredit.van
            ? t("{namn} har lagt upp sin första annons.", { namn: kredit.van })
            : t("Din vän har lagt upp sin första annons.")}{" "}
          {t("På nästa möbel du säljer tar Loopa ingen avgift – du får hela priset.")}
        </p>
        <button className="btn btn-primary" onClick={stang} autoFocus>
          {t("Toppen!")}
        </button>
      </div>
    </div>
  );
}

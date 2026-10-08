import { useEffect, useState } from "react";
import { getMinAffiliate } from "../api";
import { useT } from "../lib/i18n";
import { StatGrid } from "../profil/TradeSections";
import type { MinAffiliate } from "../types";

/**
 * Affiliate: den personliga länken och vad den gett.
 *
 * REGELN står i server/src/affiliate/regler.ts: 5 % av försäljningspriset på varje annons en värvad
 * användare säljer, när affären är slutförd. Texten lovar exakt det — inte "när din vän registrerar
 * sig", för det är inte då pengarna kommer.
 *
 * SKILD FRÅN INBJUDAN (BjudIn.tsx). Inbjudan ger en gratis försäljning, affiliate ger pengar; två
 * länkar, två rutor.
 */

/** Öre som kronor: "61,70 kr", men "100 kr" när det är jämna kronor. */
export function formatOre(ore: number): string {
  const kr = ore / 100;
  const decimaler = ore % 100 === 0 ? 0 : 2;
  return `${kr.toLocaleString("sv-SE", { minimumFractionDigits: decimaler, maximumFractionDigits: decimaler })} kr`;
}

/** Kopierar länken. Faller urklippet visas länken markerbar. */
async function kopiera(lank: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(lank);
    return true;
  } catch {
    return false;
  }
}

/**
 * Profilens avdelning. Laddar sig själv och visar ingenting om den faller — affiliate är ett
 * erbjudande, inte något kontot behöver för att komma åt sina möbler.
 */
export function ProfilAffiliate() {
  const t = useT();
  const [data, setData] = useState<MinAffiliate | null>(null);
  const [kopierad, setKopierad] = useState(false);
  const [visaLank, setVisaLank] = useState(false);

  useEffect(() => {
    let aktiv = true;
    getMinAffiliate()
      .then((d) => aktiv && setData(d))
      .catch(() => undefined);
    return () => {
      aktiv = false;
    };
  }, []);

  if (!data) return null;

  async function onKopiera() {
    const ok = await kopiera(data!.lank);
    setVisaLank(!ok);
    if (ok) {
      setKopierad(true);
      window.setTimeout(() => setKopierad(false), 3000);
    }
  }

  async function onDela() {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: "Loopa AI",
          text: t("Sälj dina begagnade möbler med Loopa AI."),
          url: data!.lank,
        });
      } catch {
        // Stängd delningsmeny. Inget att säga om.
      }
      return;
    }
    await onKopiera();
  }

  return (
    <>
      <h2 className="profile-section-title">{t("Din affiliate-länk")}</h2>
      <div className="bjudin-ruta">
        <p className="bjudin-rubrik">{t("Tjäna 5 % på allt de du värvar säljer.")}</p>
        <p className="bjudin-not">
          {t("Den som registrerar sig via din länk kopplas till dig. När en av deras annonser blir såld och affären är slutförd får du 5 % av försäljningspriset.")}
        </p>
        <div className="bjudin-knappar">
          <button type="button" className="btn btn-primary btn-small" onClick={() => void onKopiera()}>
            {kopierad ? t("Kopierad ✓") : t("Kopiera länk")}
          </button>
          <button type="button" className="btn btn-outline btn-small" onClick={() => void onDela()}>
            {t("Dela")}
          </button>
        </div>
        {visaLank && (
          <input className="bjudin-lank" readOnly value={data.lank} onFocus={(e) => e.currentTarget.select()} aria-label={t("Din affiliate-länk")} />
        )}
      </div>

      <StatGrid
        items={[
          { label: t("Registreringar"), value: String(data.registreringar) },
          { label: t("Annonser"), value: String(data.annonser) },
          { label: t("Sålda"), value: String(data.salda) },
          { label: t("Väntande"), value: formatOre(data.vantandeOre), hint: t("Intjänat, inte utbetalt") },
          { label: t("Utbetalt"), value: formatOre(data.utbetaltOre) },
        ]}
      />
    </>
  );
}

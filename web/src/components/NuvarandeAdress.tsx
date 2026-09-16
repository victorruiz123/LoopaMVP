import { useState } from "react";
import { adressFranPosition, type AdressTraff } from "../api";
import { useT } from "../lib/i18n";

/**
 * "Använd min nuvarande adress": telefonens position blir gata, postnummer och ort.
 *
 * DET ÄR ETT FÖRSLAG, INTE ETT SVAR. En position inomhus är ungefärlig — i ett flerfamiljshus eller
 * på en gata med tätt mellan husen landar den gärna på grannens nummer. Därför fyller knappen i
 * fälten och säger sedan åt säljaren att titta, i stället för att tyst lita på satelliten. Det står
 * hårdare när webbläsaren själv säger att positionen är osäker.
 *
 * Positionen lämnar bara telefonen när säljaren trycker, och webbläsaren frågar om lov först. Knappen
 * visas inte alls där webbläsaren saknar platstjänster.
 */

/** Över det här många metrarna kan huset bredvid lika gärna vara rätt. */
const OSAKER_M = 40;

export default function NuvarandeAdress({ onTraff }: { onTraff: (traff: AdressTraff) => void }) {
  const t = useT();
  const [soker, setSoker] = useState(false);
  const [besked, setBesked] = useState<{ fel: boolean; text: string } | null>(null);

  if (typeof navigator === "undefined" || !("geolocation" in navigator)) return null;

  function hamta() {
    setBesked(null);
    setSoker(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const traff = await adressFranPosition(pos.coords.latitude, pos.coords.longitude);
          if (!traff) {
            setBesked({ fel: true, text: t("Hittade ingen adress där du är. Skriv in den i stället.") });
            return;
          }
          onTraff(traff);
          setBesked({
            fel: false,
            text:
              pos.coords.accuracy > OSAKER_M
                ? t("Kontrollera husnumret — positionen är ungefärlig.")
                : t("Kontrollera att adressen stämmer."),
          });
        } catch {
          setBesked({ fel: true, text: t("Platsen gick inte att hämta. Skriv in adressen i stället.") });
        } finally {
          setSoker(false);
        }
      },
      (err) => {
        setSoker(false);
        setBesked({
          fel: true,
          text:
            err.code === err.PERMISSION_DENIED
              ? t("Du har inte gett sidan tillgång till din plats. Skriv in adressen i stället.")
              : t("Platsen gick inte att hämta. Skriv in adressen i stället."),
        });
      },
      // Hög noggrannhet: det är husnumret som står på spel. En gammal position ur cachen kan vara från
      // någon annanstans än där säljaren bor.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }

  return (
    <>
      <button type="button" className="adress-har" onClick={hamta} disabled={soker}>
        {soker ? t("Hämtar din plats…") : t("Använd min nuvarande adress")}
      </button>
      {besked && (
        <p className={besked.fel ? "adress-har-besked fel" : "adress-har-besked"} role="status">
          {besked.text}
        </p>
      )}
    </>
  );
}

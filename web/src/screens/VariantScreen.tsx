import { useState } from "react";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

/**
 * "Vilken variant är det?"
 *
 * DEN HÄR FRÅGAN KAN BARA SÄLJAREN SVARA PÅ. En 2-sits och en 3-sits av samma modell skiljer sig med
 * ungefär fyrtio centimeter, och den skillnaden syns inte på ett foto taget snett framifrån — men den
 * avgör både måtten i annonsen och vad möbeln är värd. Utan frågan gissade bildmodellen, och gissade
 * fel åt båda hållen: en Ektorp 2-sits fick 3-sitsens 218 cm, en soffa med två sittdynor kallades
 * 3-sits.
 *
 * FRITEXTEN ÄR INTE EN RESERVUTGÅNG UTAN ETT LIKVÄRDIGT SVAR. Listan kommer från en modell som kan ha
 * missat ett utförande, och säljaren står framför möbeln. Den som skriver "2,5-sits" ska få göra det.
 *
 * Skärmen visas BARA när det finns minst två varianter att välja mellan — se VariantGate i App.tsx.
 */
export default function VariantScreen({
  brand,
  model,
  varianter,
  onDone,
  saving,
  error,
}: {
  brand: string | null;
  model: string | null;
  varianter: string[];
  onDone: (variant: string) => void;
  saving: boolean;
  error?: string | null;
}) {
  const t = useT();
  usePageTitle("Välj variant");
  const [vald, setVald] = useState<string | null>(null);
  const [egen, setEgen] = useState("");
  const [skriver, setSkriver] = useState(false);

  const svar = skriver ? egen.trim() : vald;
  const klart = !!svar;

  return (
    <div className="screen screen-light">
      <header className="home-header">
        <h1 className="home-title">
          {t("Välj")} <span className="accent">{t("variant")}</span>
        </h1>
        <p className="home-lede">
          {t(
            "{modell} finns i flera storlekar, och de skiljer sig i mått och pris. Bilderna räcker inte för att se vilken du har — men du står framför den.",
            { modell: [brand, model].filter(Boolean).join(" ") || t("Modellen") },
          )}
        </p>
      </header>

      <div className="variant-val">
        {varianter.map((v) => (
          <button
            key={v}
            type="button"
            className={`variant-knapp${!skriver && vald === v ? " vald" : ""}`}
            aria-pressed={!skriver && vald === v}
            onClick={() => {
              setSkriver(false);
              setVald(v);
            }}
          >
            {v}
          </button>
        ))}
        <button
          type="button"
          className={`variant-knapp variant-knapp-egen${skriver ? " vald" : ""}`}
          aria-pressed={skriver}
          onClick={() => {
            setSkriver(true);
            setVald(null);
          }}
        >
          {t("Ingen av dem — jag skriver själv")}
        </button>
        {skriver && (
          <div className="fraga-foljd">
            <label htmlFor="variant-egen">{t("Vilken variant är det?")}</label>
            <input
              id="variant-egen"
              value={egen}
              autoFocus
              maxLength={40}
              onChange={(e) => setEgen(e.target.value)}
              placeholder={t("t.ex. 2,5-sits med divan")}
            />
          </div>
        )}
      </div>

      {error && <p className="fraga-fel">{error}</p>}

      <button className="btn btn-primary" disabled={!klart || saving} onClick={() => onDone(svar!)}>
        {saving ? t("Sparar…") : t("Fortsätt")}
      </button>
      <p className="fraga-bygger">{t("Måtten i annonsen hämtas för den variant du väljer.")}</p>
    </div>
  );
}

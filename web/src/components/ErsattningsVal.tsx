import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, CloseIcon } from "./icons";
import { useT } from "../lib/i18n";
import { formatSek } from "../lib/price";
import type { ErsattningsTyp, MassproductionsErbjudande } from "../types";

/**
 * Massproductions-valet: pengar eller credits. Fönstret som öppnas av sig självt när annonsen är
 * klar, INNAN säljaren når "Sälj med Loopa" — och bara för märket Massproductions
 * (server/src/massproductions.ts). Efter valet stängs det, säljrutan visar valet, och "Sälj med
 * Loopa" går direkt till bekräftelsen. Stängs det utan val öppnar "Sälj med Loopa" det igen.
 *
 * ETT EGET FÖNSTER, INTE EN RAD I BEKRÄFTELSEN. Valet är det enda beslut som skiljer en
 * Massproductions-möbel från andra, och det är ett beslut om vad man får — det ska fattas med de två
 * beloppen bredvid varandra och ingenting annat att läsa. Bekräftelsen efteråt visar valet och låter
 * säljaren ändra det.
 *
 * BELOPPEN ÄR SERVERNS. Sidan visar `erbjudande.pengar.saljarenSek` och `erbjudande.credits` som de
 * kom; ingenting räknas här.
 */
export default function ErsattningsVal({
  erbjudande,
  forval,
  namnForslag = "",
  onVal,
  onStang,
}: {
  erbjudande: MassproductionsErbjudande;
  forval: ErsattningsTyp | null;
  /** Namnet att börja med: det säljaren skrev förut, annars profilens. */
  namnForslag?: string;
  /** `namn` är satt när valet är credits — det går till Massproductions när möbeln är såld. */
  onVal: (val: ErsattningsTyp, namn: string | null) => void;
  /** Stäng utan att välja. Valet går att göra senare — "Sälj med Loopa" öppnar fönstret igen. */
  onStang: () => void;
}) {
  const t = useT();
  const [val, setVal] = useState<ErsattningsTyp | null>(forval);
  const [namn, setNamn] = useState(namnForslag);
  // Samma regel som servern (massproductions.ts, rensaNamn): minst två tecken.
  const namnOk = namn.replace(/\s+/g, " ").trim().length >= 2;
  const kanValja = !!val && (val === "pengar" || namnOk);
  const sida = useRef<HTMLDivElement>(null);
  const pengar = erbjudande.pengar;
  const extra = erbjudande.credits - pengar.mobelprisSek;

  // Sidan bakom rullar inte med, och tangentbordet landar här.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sida.current?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onStang();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onStang]);

  const alternativ: Array<{ typ: ErsattningsTyp; etikett: string; belopp: string; enhet: string; rader: string[]; marke?: string }> = [
    {
      typ: "pengar",
      etikett: t("Pengar"),
      belopp: formatSek(pengar.saljarenSek),
      enhet: t("utbetalt till dig"),
      rader: [
        t("{andel} % av möbelpriset {pris}", {
          andel: Math.round((pengar.saljarenSek / Math.max(1, pengar.mobelprisSek)) * 100),
          pris: formatSek(pengar.mobelprisSek),
        }),
        t("Betalas ut när möbeln är såld"),
      ],
    },
    {
      typ: "credits",
      etikett: t("Credits hos Massproductions"),
      belopp: erbjudande.credits.toLocaleString("sv-SE"),
      enhet: t("credits att handla för hos Massproductions"),
      rader: [
        t("{paslag} % över försäljningspriset — {extra} extra", {
          paslag: Math.round(erbjudande.paslag * 100),
          extra: extra.toLocaleString("sv-SE"),
        }),
        t("Gäller bara hos Massproductions"),
        t("Blir dina när möbeln är såld"),
      ],
      marke: t("Mest värde"),
    },
  ];

  return createPortal(
    <div className="ersv" role="dialog" aria-modal="true" aria-labelledby="ersv-rubrik">
      <div className="ersv-scrim" onClick={onStang} />
      <div className="ersv-inner" ref={sida} tabIndex={-1}>
        <button className="ersv-stang" onClick={onStang} aria-label={t("Stäng")}>
          <CloseIcon size={15} />
        </button>

        <p className="ersv-kicker">{t("Massproductions")}</p>
        <h1 id="ersv-rubrik" className="ersv-rubrik">
          {t("Hur vill du få betalt?")}
        </h1>
        <p className="ersv-ingress">
          {t("Din möbel är från Massproductions. Välj om du vill ha pengar, eller credits att handla för hos Massproductions — värda mer än möbelpriset.")}
        </p>

        <div className="ersv-val" role="radiogroup" aria-labelledby="ersv-rubrik">
          {alternativ.map((a) => {
            const vald = val === a.typ;
            return (
              <button
                key={a.typ}
                type="button"
                role="radio"
                aria-checked={vald}
                className={`ersv-kort${vald ? " vald" : ""}`}
                onClick={() => setVal(a.typ)}
              >
                <span className="ersv-kort-topp">
                  <span className="ersv-kort-etikett">{a.etikett}</span>
                  {a.marke && <span className="ersv-kort-marke">{a.marke}</span>}
                  <span className="ersv-kort-bock" aria-hidden="true">
                    {vald && <CheckIcon size={14} />}
                  </span>
                </span>
                <span className="ersv-kort-belopp">{a.belopp}</span>
                <span className="ersv-kort-enhet">{a.enhet}</span>
                <span className="ersv-kort-rader">
                  {a.rader.map((r) => (
                    <span key={r}>{r}</span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>

        {/* NAMNET, bara vid credits: Massproductions behöver veta vem credits tillhör. Det skickas till
            dem först när möbeln är såld (server/src/massproductionsKontakt.ts). */}
        {val === "credits" && (
          <label className="ersv-namn">
            <span>{t("Ditt namn")}</span>
            <input
              value={namn}
              onChange={(e) => setNamn(e.target.value)}
              maxLength={80}
              autoComplete="name"
              placeholder={t("För- och efternamn")}
            />
            <small>
              {t("När möbeln är såld skickar vi ditt namn och din e-post till Massproductions, så att de kan lösa in dina credits.")}
            </small>
          </label>
        )}

        <button
          className="btn btn-primary ersv-fortsatt"
          disabled={!kanValja}
          onClick={() => val && kanValja && onVal(val, val === "credits" ? namn.replace(/\s+/g, " ").trim() : null)}
        >
          {!val
            ? t("Välj pengar eller credits")
            : val === "credits"
              ? namnOk
                ? t("Välj Massproductions-credits")
                : t("Skriv ditt namn")
              : t("Välj pengar")}
        </button>
        <p className="ersv-not">
          {t("Beloppen gäller dagens pris. Sänks priset innan möbeln säljs räknas båda på det pris den säljs för.")}
        </p>
        <p className="ersv-not">{t("Du kan ändra valet ända tills du trycker Sälj med Loopa.")}</p>
      </div>
    </div>,
    document.body,
  );
}

import { useEffect, useRef, useState } from "react";
import type { PriceLadder } from "../types";
import { savePricePlan } from "../api";
import { formatSek } from "../lib/price";
import { ladderRungs, roundToRung } from "../lib/priceLadder";
import { useLang, useT } from "../lib/i18n";

/**
 * Säljarens eget pris, när prismotorn inte har något att föreslå.
 *
 * TOMMA FÄLT MED FLIT. Med ett förslag att utgå från fyller PriceLadderPicker i spannet åt säljaren,
 * och det de väljer är avvikelsen. Här finns inget förslag — och ett förifyllt tal hade varit ett
 * pris ingen räknat fram, som säljaren läser som vårt. Tidigare gick annonsen i det läget ut på
 * annonsresearchens gissning, ett tal säljaren aldrig såg (se resolveAdPrice i server/src/adContent.ts).
 * Nu måste alla tre fälten fyllas i innan möbeln går att sälja: servern stoppar "Sälj med Loopa" tills
 * en prisplan finns.
 *
 * Sänkningen är ett eget fält här och inte fasta 15 %: den som själv sätter priset utan något att
 * jämföra med vet bäst hur fort den vill gå ner.
 */

const MIN_PCT = 1;
const MAX_PCT = 50;

function heltal(v: string): number | null {
  const siffror = v.replace(/[^\d]/g, "");
  return siffror ? Number(siffror) : null;
}

export default function ManuellPrisplan({ jobId, initial }: { jobId: string; initial: PriceLadder | null }) {
  const t = useT();
  const { lang } = useLang();
  const [start, setStart] = useState(initial ? String(initial.startPrice) : "");
  const [golv, setGolv] = useState(initial ? String(initial.floorPrice) : "");
  const [procent, setProcent] = useState(initial ? String(Math.round(initial.weeklyDropPct * 100)) : "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(initial ? "saved" : "idle");
  const [fel, setFel] = useState<string | null>(null);
  const sparat = useRef<string | null>(
    initial ? `${initial.startPrice}:${initial.floorPrice}:${Math.round(initial.weeklyDropPct * 100)}` : null,
  );

  const s = heltal(start);
  const g = heltal(golv);
  const p = heltal(procent);

  /** Vad som hindrar planen, eller null när den går att spara. Tomma fält är inget fel — bara ofärdigt. */
  const hinder =
    s === null || g === null || p === null
      ? null
      : s < 10
        ? t("Startpriset måste vara minst 10 kr.")
        : g < 10
          ? t("Lägsta priset måste vara minst 10 kr.")
          : g > s
            ? t("Lägsta priset kan inte vara högre än startpriset.")
            : p < MIN_PCT || p > MAX_PCT
              ? t("Sänkningen ska vara mellan {min} och {max} % i veckan.", { min: MIN_PCT, max: MAX_PCT })
              : null;
  const komplett = s !== null && g !== null && p !== null && hinder === null;

  useEffect(() => {
    if (!komplett) return;
    const startPris = roundToRung(s!);
    const golvPris = Math.min(roundToRung(g!), startPris);
    const signatur = `${startPris}:${golvPris}:${p}`;
    if (sparat.current === signatur) return;
    setStatus("idle");
    const timer = window.setTimeout(async () => {
      setStatus("saving");
      try {
        await savePricePlan(jobId, { startPrice: startPris, floorPrice: golvPris, weeklyDropPct: p! / 100 });
        sparat.current = signatur;
        setStatus("saved");
        setFel(null);
      } catch (err) {
        setStatus("error");
        setFel(err instanceof Error ? err.message : String(err));
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [jobId, komplett, s, g, p]);

  const steg = komplett ? ladderRungs(roundToRung(s!), Math.min(roundToRung(g!), roundToRung(s!)), p! / 100) : [];
  const veckor = Math.max(0, steg.length - 1);
  const golvDatum = new Date(Date.now() + veckor * 7 * 24 * 60 * 60 * 1000);

  return (
    <section className="ladder-card manuell-prisplan">
      <div className="price-panel-head">{t("Sätt ditt pris")}</div>
      <p className="muted small ladder-intro">
        {t(
          "Vi har inget prisförslag för den här möbeln, så priset sätter du själv. Annonsen startar på ditt startpris och sänks varje vecka tills den når ditt lägsta pris. Hemleveransen läggs ovanpå och sänks aldrig.",
        )}
      </p>

      <div className="manuell-falt">
        <label className="manuell-rad">
          <span className="ladder-row-label">{t("Startpris (högsta)")}</span>
          <span className="ladder-amount">
            <input
              className="ladder-amount-input"
              inputMode="numeric"
              value={start}
              onChange={(e) => setStart(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="—"
              aria-label={t("Startpris (högsta)")}
            />
            <span className="ladder-amount-unit">kr</span>
          </span>
        </label>
        <label className="manuell-rad">
          <span className="ladder-row-label">{t("Lägsta pris")}</span>
          <span className="ladder-amount">
            <input
              className="ladder-amount-input"
              inputMode="numeric"
              value={golv}
              onChange={(e) => setGolv(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="—"
              aria-label={t("Lägsta pris")}
            />
            <span className="ladder-amount-unit">kr</span>
          </span>
        </label>
        <label className="manuell-rad">
          <span className="ladder-row-label">{t("Sänkning per vecka")}</span>
          <span className="ladder-amount">
            <input
              className="ladder-amount-input"
              inputMode="numeric"
              value={procent}
              onChange={(e) => setProcent(e.target.value.replace(/[^\d]/g, "").slice(0, 2))}
              placeholder="—"
              aria-label={t("Sänkning per vecka")}
            />
            <span className="ladder-amount-unit">%</span>
          </span>
        </label>
      </div>

      {komplett && (
        <>
          <ol className="ladder-steps">
            {(steg.length <= 6 ? steg.map((pris, v) => ({ v, pris })) : [
              ...steg.slice(0, 4).map((pris, v) => ({ v, pris })),
              null,
              { v: steg.length - 1, pris: steg[steg.length - 1] },
            ]).map((r, i) =>
              r === null ? (
                <li key={`gap-${i}`} className="ladder-step ladder-step-gap" aria-hidden="true">
                  …
                </li>
              ) : (
                <li key={r.v} className={`ladder-step${r.v === veckor && veckor > 0 ? " ladder-step-floor" : ""}`}>
                  <span className="ladder-step-week">{r.v === 0 ? t("Nu") : t("v. {vecka}", { vecka: r.v })}</span>
                  <span className="ladder-step-price">{formatSek(r.pris)}</span>
                </li>
              ),
            )}
          </ol>
          <p className="ladder-summary">
            {veckor === 0
              ? t("Startpriset är redan ditt lägsta — annonsen sänks inte.")
              : t(
                  veckor === 1
                    ? "Golvet nås efter {antal} vecka, omkring {datum}. Sedan ligger priset kvar."
                    : "Golvet nås efter {antal} veckor, omkring {datum}. Sedan ligger priset kvar.",
                  { antal: veckor, datum: golvDatum.toLocaleDateString(lang, { day: "numeric", month: "long" }) },
                )}
          </p>
        </>
      )}

      <p className={`ladder-status${hinder || status === "error" ? " ladder-status-error" : ""}`}>
        {hinder
          ? hinder
          : status === "error"
            ? t("Prisspannet kunde inte sparas: {fel}", { fel: fel ?? "" })
            : status === "saving"
              ? t("Sparar…")
              : status === "saved" && komplett
                ? t("Prisspannet är sparat och används när annonsen läggs upp.")
                : t("Fyll i alla tre fälten — utan dem går möbeln inte att sälja.")}
      </p>
    </section>
  );
}

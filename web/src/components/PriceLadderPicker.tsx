import { useEffect, useMemo, useRef, useState } from "react";
import type { PriceEstimate, PriceLadder } from "../types";
import { savePricePlan } from "../api";
import { formatSek } from "../lib/price";
import {
  WEEKLY_DROP,
  WEEKLY_DROP_MAX_PCT,
  WEEKLY_DROP_MIN_PCT,
  clampWeeklyDropPct,
  ladderBounds,
  ladderRungs,
  roundToRung,
} from "../lib/priceLadder";
import { useLang, useT } from "../lib/i18n";

/**
 * Säljarens prisspann.
 *
 * Prismotorn svarar med tre tal — säljs snabbt, förslag, säljs långsamt — och hittills fick säljaren
 * bara läsa dem. Men vilket av talen som är RÄTT beror på det enda motorn inte kan veta: hur bråttom
 * de har. Här svarar de på det. De sätter ett startpris, ett golv och en takt — hur många procent
 * annonsen sänks varje vecka — och annonsen går själv ner genom spannet tills den når golvet, där
 * den stannar.
 *
 * TAKTEN VAR LÅST TILL 15 % HÄR fram till 2026-10-03, fast servern räknade med varje annons egen
 * procent sedan länge och reservvyn utan prisförslag (ManuellPrisplan) redan lät säljaren välja.
 * Den som har bråttom kunde alltså bara sänka startpriset, inte farten. Nu är takten ett tredje
 * reglage med samma gränser som servern (1–50 %), förvalt 15 %.
 *
 * Spannet är förifyllt med motorns förslag och sparas direkt, utan att säljaren behöver trycka på
 * något. En tom prisplan hade betytt "priset står stilla för alltid", vilket är sämre än förvalet och
 * dessutom inte det någon väljer — de bara går vidare. Det de faktiskt väljer är avvikelsen, och den
 * sparas när de gör den.
 */
export default function PriceLadderPicker({
  jobId,
  price,
  initial,
}: {
  jobId: string;
  price: PriceEstimate;
  initial: PriceLadder | null;
}) {
  const t = useT();
  const { lang } = useLang();
  const bounds = useMemo(() => ladderBounds(price), [price]);

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const suggested = roundToRung(price.default ?? bounds.min);
  const fastSale = roundToRung(price.low ?? Math.round(suggested * 0.7));
  const defaultPct = Math.round(WEEKLY_DROP * 100);

  const [start, setStart] = useState(() =>
    clamp(roundToRung(initial?.startPrice ?? suggested), bounds.min, bounds.max),
  );
  const [floor, setFloor] = useState(() =>
    clamp(roundToRung(initial?.floorPrice ?? fastSale), bounds.min, bounds.max),
  );
  /** Takten i hela procent. Ett redan sparat spann bär sin egen; annars förvalet. */
  const [pct, setPct] = useState(() => clampWeeklyDropPct(initial ? initial.weeklyDropPct * 100 : defaultPct));

  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(initial ? "saved" : "idle");
  const [error, setError] = useState<string | null>(null);

  /**
   * Vad servern senast fick veta. Ett redan sparat spann ska inte skrivas om vid varje montering —
   * det hade nollställt säljarens egna val till motorns förslag om de kom tillbaka till vyn.
   */
  const saved = useRef<string | null>(
    initial ? `${initial.startPrice}:${initial.floorPrice}:${clampWeeklyDropPct(initial.weeklyDropPct * 100)}` : null,
  );

  const setStartPrice = (value: number) => {
    const next = clamp(value, bounds.min, bounds.max);
    setStart(next);
    // Golvet är alltid ett tak för sig självt. Drar man ner startpriset under det följer det med i
    // stället för att lämna ett spann som inte går att sänka igenom.
    if (next < floor) setFloor(next);
  };

  const setFloorPrice = (value: number) => setFloor(clamp(value, bounds.min, Math.min(start, bounds.max)));
  const setDropPct = (value: number) => setPct(clampWeeklyDropPct(value));

  useEffect(() => {
    const signature = `${start}:${floor}:${pct}`;
    if (saved.current === signature) return;
    const timer = window.setTimeout(async () => {
      setStatus("saving");
      try {
        await savePricePlan(jobId, { startPrice: start, floorPrice: floor, weeklyDropPct: pct / 100 });
        saved.current = signature;
        setStatus("saved");
        setError(null);
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [jobId, start, floor, pct]);

  const rungs = ladderRungs(start, floor, pct / 100);
  const weeks = rungs.length - 1;
  const floorDate = new Date(Date.now() + weeks * 7 * 24 * 60 * 60 * 1000);

  return (
    <section className="ladder-card">
      <div className="price-panel-head">{t("Ditt prisspann")}</div>
      {/* Spannet är priset på MÖBELN. Hemleveransen läggs på först när annonsen går upp — beloppet
          står i säljsteget, där det kommer från servern. Att upprepa det här skulle betyda
          två kopior av samma pris i två olika lager. */}
      <p className="muted small ladder-intro">
        {t(
          "Annonsen startar på ditt pris och sänks {andel} % i veckan tills den når ditt lägsta pris. Där stannar den. Hemleveransen läggs ovanpå i annonsen och sänks aldrig.",
          { andel: pct },
        )}
      </p>

      <div className="ladder-row">
        <div className="ladder-row-head">
          <span className="ladder-row-label">{t("Startpris")}</span>
          <AmountField label={t("Startpris")} value={start} unit="kr" normalize={roundToRung} onCommit={setStartPrice} />
        </div>
        <input
          className="ladder-slider ladder-slider-start"
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          value={start}
          aria-label={t("Startpris")}
          onChange={(e) => setStartPrice(Number(e.target.value))}
        />
        <p className="ladder-hint">{t("Prismotorns förslag: {pris}", { pris: formatSek(suggested) })}</p>
      </div>

      <div className="ladder-row">
        <div className="ladder-row-head">
          <span className="ladder-row-label">{t("Lägsta pris")}</span>
          <AmountField label={t("Lägsta pris")} value={floor} unit="kr" normalize={roundToRung} onCommit={setFloorPrice} />
        </div>
        <input
          className="ladder-slider ladder-slider-floor"
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          value={floor}
          aria-label={t("Lägsta pris")}
          onChange={(e) => setFloorPrice(Number(e.target.value))}
        />
        <p className="ladder-hint">{t("Säljs snabbt vid {pris}", { pris: formatSek(fastSale) })}</p>
      </div>

      {/* Takten. Samma reglage som priserna, så att de tre läses som en och samma plan: var den
          börjar, var den slutar, och hur fort den går däremellan. Stegen nedanför räknas om direkt. */}
      <div className="ladder-row">
        <div className="ladder-row-head">
          <span className="ladder-row-label">{t("Sänkning per vecka")}</span>
          <AmountField label={t("Sänkning per vecka")} value={pct} unit="%" normalize={clampWeeklyDropPct} onCommit={setDropPct} />
        </div>
        <input
          className="ladder-slider ladder-slider-pct"
          type="range"
          min={WEEKLY_DROP_MIN_PCT}
          max={WEEKLY_DROP_MAX_PCT}
          step={1}
          value={pct}
          aria-label={t("Sänkning per vecka")}
          onChange={(e) => setDropPct(Number(e.target.value))}
        />
        <p className="ladder-hint">
          {pct === defaultPct
            ? t("Förvalet. Lägre takt ger varje pris mer tid, högre når golvet fortare.")
            : t("Förvalet är {andel} %. Lägre takt ger varje pris mer tid, högre når golvet fortare.", { andel: defaultPct })}
        </p>
      </div>

      <ol className="ladder-steps">
        {visibleRungs(rungs).map((rung, i) =>
          rung === null ? (
            <li key={`gap-${i}`} className="ladder-step ladder-step-gap" aria-hidden="true">
              …
            </li>
          ) : (
            <li
              key={rung.week}
              className={`ladder-step${rung.week === weeks && weeks > 0 ? " ladder-step-floor" : ""}`}
            >
              <span className="ladder-step-week">
                {rung.week === 0 ? t("Nu") : t("v. {vecka}", { vecka: rung.week })}
              </span>
              <span className="ladder-step-price">{formatSek(rung.price)}</span>
            </li>
          ),
        )}
      </ol>

      <p className="ladder-summary">
        {weeks === 0
          ? t("Startpriset är redan ditt lägsta — annonsen sänks inte.")
          : t(
              weeks === 1
                ? "Golvet nås efter {antal} vecka, omkring {datum}. Sedan ligger priset kvar."
                : "Golvet nås efter {antal} veckor, omkring {datum}. Sedan ligger priset kvar.",
              { antal: weeks, datum: floorDate.toLocaleDateString(lang, { day: "numeric", month: "long" }) },
            )}
      </p>

      <p className={`ladder-status${status === "error" ? " ladder-status-error" : ""}`}>
        {status === "saving"
          ? t("Sparar…")
          : status === "error"
            ? t("Prisspannet kunde inte sparas: {fel}", { fel: error ?? "" })
            : status === "saved"
              ? t("Prisspannet är sparat och används när annonsen läggs upp.")
              : " "}
      </p>
    </section>
  );
}

/**
 * Stegen som chips: hela när den är kort, annars början, ett hopp och golvet.
 *
 * Ett spann på 3 000 → 200 kr är fjorton veckor långt, och fjorton kolumner säger inget mer än de
 * fyra första plus var det slutar.
 */
function visibleRungs(rungs: number[]): Array<{ week: number; price: number } | null> {
  const all = rungs.map((price, week) => ({ week, price }));
  if (all.length <= 6) return all;
  return [...all.slice(0, 4), null, all[all.length - 1]];
}

/**
 * Talfältet — kronor eller procent. Håller ett eget utkast medan man skriver: utan det går sista
 * siffran inte att radera, eftersom en tom ruta annars läses som noll och genast klampas tillbaka
 * till lägsta tillåtna värde. `normalize` är det som gör talet till ett giltigt värde när man
 * lämnar fältet (jämna tior för priser, 1–50 för takten).
 */
function AmountField({
  label,
  value,
  unit,
  normalize,
  onCommit,
}: {
  label: string;
  value: number;
  unit: string;
  normalize: (value: number) => number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft !== null && draft !== "") {
      const parsed = Number(draft);
      if (Number.isFinite(parsed)) onCommit(normalize(parsed));
    }
    setDraft(null);
  };

  return (
    <span className="ladder-amount">
      <input
        className="ladder-amount-input"
        type="text"
        inputMode="numeric"
        aria-label={label}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <span className="ladder-amount-unit">{unit}</span>
    </span>
  );
}

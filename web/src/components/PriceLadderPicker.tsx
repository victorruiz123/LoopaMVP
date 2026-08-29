import { useEffect, useMemo, useRef, useState } from "react";
import type { PriceEstimate, PriceLadder } from "../types";
import { savePricePlan } from "../api";
import { formatSek } from "../lib/price";
import { WEEKLY_DROP, ladderBounds, ladderRungs, roundToRung } from "../lib/priceLadder";

/**
 * Säljarens prisspann.
 *
 * Prismotorn svarar med tre tal — säljs snabbt, förslag, säljs långsamt — och hittills fick säljaren
 * bara läsa dem. Men vilket av talen som är RÄTT beror på det enda motorn inte kan veta: hur bråttom
 * de har. Här svarar de på det. De sätter ett startpris och ett golv, och annonsen går själv ner genom
 * spannet med 15 % i veckan tills den når golvet, där den stannar.
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
  const bounds = useMemo(() => ladderBounds(price), [price]);

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const suggested = roundToRung(price.default ?? bounds.min);
  const fastSale = roundToRung(price.low ?? Math.round(suggested * 0.7));

  const [start, setStart] = useState(() =>
    clamp(roundToRung(initial?.startPrice ?? suggested), bounds.min, bounds.max),
  );
  const [floor, setFloor] = useState(() =>
    clamp(roundToRung(initial?.floorPrice ?? fastSale), bounds.min, bounds.max),
  );

  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(initial ? "saved" : "idle");
  const [error, setError] = useState<string | null>(null);

  /**
   * Vad servern senast fick veta. Ett redan sparat spann ska inte skrivas om vid varje montering —
   * det hade nollställt säljarens egna val till motorns förslag om de kom tillbaka till vyn.
   */
  const saved = useRef<string | null>(initial ? `${initial.startPrice}:${initial.floorPrice}` : null);

  const setStartPrice = (value: number) => {
    const next = clamp(value, bounds.min, bounds.max);
    setStart(next);
    // Golvet är alltid ett tak för sig självt. Drar man ner startpriset under det följer det med i
    // stället för att lämna ett spann som inte går att sänka igenom.
    if (next < floor) setFloor(next);
  };

  const setFloorPrice = (value: number) => setFloor(clamp(value, bounds.min, Math.min(start, bounds.max)));

  useEffect(() => {
    const signature = `${start}:${floor}`;
    if (saved.current === signature) return;
    const timer = window.setTimeout(async () => {
      setStatus("saving");
      try {
        await savePricePlan(jobId, { startPrice: start, floorPrice: floor });
        saved.current = signature;
        setStatus("saved");
        setError(null);
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [jobId, start, floor]);

  const rungs = ladderRungs(start, floor, WEEKLY_DROP);
  const weeks = rungs.length - 1;
  const floorDate = new Date(Date.now() + weeks * 7 * 24 * 60 * 60 * 1000);

  return (
    <section className="ladder-card">
      <div className="price-panel-head">Ditt prisspann</div>
      {/* Spannet är priset på MÖBELN. Hemleveransen läggs på först när annonsen går upp — beloppet
          står i publiceringssteget, där det kommer från servern. Att upprepa det här skulle betyda
          två kopior av samma pris i två olika lager. */}
      <p className="muted small ladder-intro">
        Annonsen startar på ditt pris och sänks {Math.round(WEEKLY_DROP * 100)} % i veckan tills den når
        ditt lägsta pris. Där stannar den. Hemleveransen läggs ovanpå i annonsen och sänks aldrig.
      </p>

      <div className="ladder-row">
        <div className="ladder-row-head">
          <span className="ladder-row-label">Startpris</span>
          <PriceField label="Startpris" value={start} onCommit={setStartPrice} />
        </div>
        <input
          className="ladder-slider ladder-slider-start"
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          value={start}
          aria-label="Startpris"
          onChange={(e) => setStartPrice(Number(e.target.value))}
        />
        <p className="ladder-hint">Prismotorns förslag: {formatSek(suggested)}</p>
      </div>

      <div className="ladder-row">
        <div className="ladder-row-head">
          <span className="ladder-row-label">Lägsta pris</span>
          <PriceField label="Lägsta pris" value={floor} onCommit={setFloorPrice} />
        </div>
        <input
          className="ladder-slider ladder-slider-floor"
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          value={floor}
          aria-label="Lägsta pris"
          onChange={(e) => setFloorPrice(Number(e.target.value))}
        />
        <p className="ladder-hint">Säljs snabbt vid {formatSek(fastSale)}</p>
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
              <span className="ladder-step-week">{rung.week === 0 ? "Nu" : `v. ${rung.week}`}</span>
              <span className="ladder-step-price">{formatSek(rung.price)}</span>
            </li>
          ),
        )}
      </ol>

      <p className="ladder-summary">
        {weeks === 0
          ? "Startpriset är redan ditt lägsta — annonsen sänks inte."
          : `Golvet nås efter ${weeks} ${weeks === 1 ? "vecka" : "veckor"}, omkring ${floorDate.toLocaleDateString("sv-SE", { day: "numeric", month: "long" })}. Sedan ligger priset kvar.`}
      </p>

      <p className={`ladder-status${status === "error" ? " ladder-status-error" : ""}`}>
        {status === "saving"
          ? "Sparar…"
          : status === "error"
            ? `Prisspannet kunde inte sparas: ${error}`
            : status === "saved"
              ? "Prisspannet är sparat och används när annonsen läggs upp."
              : " "}
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
 * Beloppsfältet. Håller ett eget utkast medan man skriver — utan det går sista siffran inte att radera,
 * eftersom en tom ruta annars läses som noll och genast klampas tillbaka till lägsta tillåtna pris.
 */
function PriceField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft !== null && draft !== "") {
      const parsed = Number(draft);
      if (Number.isFinite(parsed)) onCommit(roundToRung(parsed));
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
      <span className="ladder-amount-unit">kr</span>
    </span>
  );
}

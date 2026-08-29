import { useCallback, useEffect, useRef, useState } from "react";
import { getTraderaState, publishToTradera } from "../api";
import { formatSek } from "../lib/price";
import { formatDropDate, ladderRungs } from "../lib/priceLadder";
import type { PriceLadder, TraderaState } from "../types";

/**
 * "Publicera på Tradera" — sista steget i truth-cardet.
 *
 * Knappen skickar ingenting nytt in i någon motor. Allt som publiceras står redan på kortet ovanför:
 * annonstexten, specifikationerna, skicket och priset. Därför visar bekräftelsesteget exakt vad som
 * går iväg — särskilt kategorin, som är det enda säljaren inte kan läsa någon annanstans på skärmen.
 *
 * Publiceringen är ETT klick från en riktig, publik auktion på Loopas konto. Det är också varför den
 * har ett bekräftelsesteg: en felaktig annons går att ta bort, men bara manuellt.
 */
export default function TraderaPublish({ jobId }: { jobId: string }) {
  const [state, setState] = useState<TraderaState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  /** Pollar bara medan Traderas kö arbetar — publiceringen tar 10-60 s. */
  const refresh = useCallback(async () => {
    // Ett väntande anrop åt gången. Utan det här startar tryck-på-knappen en andra pollningskedja
    // ovanpå den från monteringen, och de två fördubblar varandra för varje varv.
    if (timer.current) window.clearTimeout(timer.current);
    try {
      const next = await getTraderaState(jobId);
      setState(next);
      if (next.publication?.status === "publishing") {
        timer.current = window.setTimeout(refresh, 2500);
      }
    } catch {
      timer.current = window.setTimeout(refresh, 4000);
    }
  }, [jobId]);

  useEffect(() => {
    void refresh();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [refresh]);

  async function publish() {
    setSending(true);
    setFailure(null);
    try {
      setState(await publishToTradera(jobId));
      setConfirming(false);
      void refresh();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  // Ingen integration konfigurerad på servern: visa ingenting alls. En knapp som inte kan göra något
  // är sämre än ingen knapp.
  if (!state || !state.configured) return null;

  const publication = state.publication;
  const plan = state.plan;

  if (publication?.status === "published" && publication.url) {
    return (
      <section className="truth-block tradera-block tradera-done">
        <h3>Publicerad på Tradera</h3>
        <p className="muted small">Annonsen ligger uppe som auktion på Loopas konto.</p>
        {state.ladder && <LadderStatus ladder={state.ladder} shippingSek={plan?.shippingSek ?? 0} />}
        <a className="btn btn-primary tradera-link" href={publication.url} target="_blank" rel="noreferrer">
          Öppna annonsen på Tradera
        </a>
      </section>
    );
  }

  if (publication?.status === "publishing") {
    return (
      <section className="truth-block tradera-block">
        <h3>Publicerar på Tradera…</h3>
        <div className="tradera-waiting">
          <div className="spinner spinner-small" />
          <p className="muted small">
            Tradera köar annonsen och laddar upp bilderna. Det tar oftast under en minut.
          </p>
        </div>
      </section>
    );
  }

  const blocked = !plan ? (state.blockedReason ?? "Annonsen går inte att publicera än.") : null;
  const error = failure ?? publication?.error ?? null;

  return (
    <section className="truth-block tradera-block">
      <h3>Publicera på Tradera</h3>

      {error && (
        <p className="tradera-error">
          Publiceringen misslyckades: {error}
        </p>
      )}

      {blocked ? (
        <p className="muted small">{blocked}</p>
      ) : !confirming ? (
        <>
          <p className="muted small">
            {plan!.mode === "fixed"
              ? "Lägger upp annonsen till fast pris — Köp Nu — på Loopas Tradera-konto, med bilderna från skanningen och skicket från besiktningen."
              : `Lägger upp annonsen som en ${plan!.durationDays}-dagars auktion på Loopas Tradera-konto, med bilderna från skanningen och skicket från besiktningen.`}
          </p>
          {ladderDrops(state.ladder) > 0 && (
            <p className="muted small">
              Annonspriset börjar på {formatSek(state.ladder!.startPrice + plan!.shippingSek)} och sänks{" "}
              {Math.round(state.ladder!.weeklyDropPct * 100)} % i veckan ner till{" "}
              {formatSek(state.ladder!.floorPrice + plan!.shippingSek)}, där det stannar. De{" "}
              {formatSek(plan!.shippingSek)} för hemleveransen ligger kvar oförändrade hela vägen.
            </p>
          )}
          <button className="btn btn-primary" onClick={() => setConfirming(true)}>
            {publication?.status === "error" ? "Försök igen" : "Publicera på Tradera"}
          </button>
        </>
      ) : (
        <>
          <dl className="truth-specs tradera-plan">
            <div className="truth-spec">
              <dt>Rubrik</dt>
              <dd>{plan!.title}</dd>
            </div>
            <div className="truth-spec">
              <dt>Kategori</dt>
              <dd>{plan!.categoryName}</dd>
            </div>
            <div className="truth-spec">
              <dt>{plan!.mode === "fixed" ? "Pris (Köp Nu)" : "Utropspris"}</dt>
              <dd>
                {formatSek(plan!.price)}
                {/* Delarna utskrivna: säljaren satte ett pris på MÖBELN och ska inte behöva räkna ut
                    varför annonsen står på ett annat tal. */}
                <span className="muted small">
                  {" "}
                  — {formatSek(plan!.itemPrice)} för möbeln + {formatSek(plan!.shippingSek)} hemleverans
                  {plan!.priceSource === "seller" && " (ditt startpris)"}
                  {plan!.priceSource === "listing" && " (annonsgeneratorns förslag, utan skadeavdrag)"}
                </span>
              </dd>
            </div>
            {ladderDrops(state.ladder) > 0 && (
              <div className="truth-spec">
                <dt>Prisplan</dt>
                <dd>
                  −{Math.round(state.ladder!.weeklyDropPct * 100)} % i veckan ner till{" "}
                  {formatSek(state.ladder!.floorPrice + plan!.shippingSek)}
                  <span className="muted small">
                    {" "}
                    — golvet nås efter {ladderDrops(state.ladder)}{" "}
                    {ladderDrops(state.ladder) === 1 ? "vecka" : "veckor"}. Sänkningen tar bara av
                    möbelns pris, aldrig av frakten.
                  </span>
                </dd>
              </div>
            )}
            <div className="truth-spec">
              <dt>Annonstyp</dt>
              <dd>
                {plan!.mode === "fixed"
                  ? "Endast Köp Nu — ingen budgivning"
                  : `Auktion, ${plan!.durationDays} dagar`}
              </dd>
            </div>
            {plan!.condition && (
              <div className="truth-spec">
                <dt>Skick</dt>
                <dd>{plan!.condition}</dd>
              </div>
            )}
            <div className="truth-spec">
              <dt>Bilder</dt>
              <dd>{plan!.imageCount} st</dd>
            </div>
            {/* Står i annonstexten, alltså i bekräftelsen: annonsen berättar att den är skapad av
                Loopa och pekar ut kortet där skicket går att kontrollera. */}
            <div className="truth-spec">
              <dt>Loopa-ID</dt>
              <dd>
                {plan!.loopaId}
                <span className="muted small"> — annonstexten hänvisar till det publika kortet</span>
              </dd>
            </div>
            {/* Fast pris, samma på varje annons — men det ingår i priset ovan, och det är den
                halvan säljaren behöver se innan de trycker. */}
            <div className="truth-spec">
              <dt>Leverans</dt>
              <dd>
                Hemleverans ingår
                <span className="muted small"> — budfirma bokas efter köpet, ingen extra kostnad för köparen</span>
              </dd>
            </div>
          </dl>
          <p className="muted small">
            Annonsen blir publik direkt. Vill du ändra något gör du det på Tradera efteråt.
          </p>
          <div className="tradera-confirm-actions">
            <button className="btn btn-text" onClick={() => setConfirming(false)} disabled={sending}>
              Avbryt
            </button>
            <button className="btn btn-primary" onClick={publish} disabled={sending}>
              {sending ? "Skickar…" : "Ja, publicera"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Hur många veckor det är kvar ner till golvet. 0 = spannet är redan i botten, eller saknas. */
function ladderDrops(ladder: PriceLadder | null): number {
  if (!ladder || ladder.floorPrice >= ladder.currentPrice) return 0;
  return ladderRungs(ladder.currentPrice, ladder.floorPrice, ladder.weeklyDropPct).length - 1;
}

/**
 * Var prisstegen står på en annons som redan ligger uppe.
 *
 * Sänkningen sker på servern, veckor efter att den här fliken stängts, så vyn är säljarens enda kvitto
 * på att den faktiskt löper. Därför står nästa datum och nästa pris utskrivna, och ett avvisat
 * prisbyte syns — ett pris som står stilla ska aldrig behöva gissas.
 */
function LadderStatus({ ladder, shippingSek }: { ladder: PriceLadder; shippingSek: number }) {
  const rungs = ladderRungs(ladder.currentPrice, ladder.floorPrice, ladder.weeklyDropPct);
  const next = rungs.length > 1 ? rungs[1] : null;
  // Allt här är ANNONSPRISER — vad som står på Tradera just nu. Stegen räknar i möbelkronor, men det
  // säljaren jämför med är annonsen, och två olika tal för samma annons vore en gåta att lösa.
  const ad = (itemPrice: number) => formatSek(itemPrice + shippingSek);

  return (
    <div className="tradera-ladder">
      <div className="tradera-ladder-now">
        <span className="ladder-row-label">Ligger på</span>
        <strong>{ad(ladder.currentPrice)}</strong>
        <span className="muted small">frakt inräknad</span>
      </div>
      <p className="muted small">
        {ladder.floorReachedAt || next === null
          ? `Lägsta priset är nått. Annonsen ligger kvar på ${ad(ladder.floorPrice)}.`
          : `Nästa sänkning ${formatDropDate(ladder.nextDropAt)} till ${ad(next)}. Golvet är ${ad(ladder.floorPrice)}.`}
        {ladder.drops.length > 0 &&
          ` ${ladder.drops.length} ${ladder.drops.length === 1 ? "sänkning" : "sänkningar"} hittills, från ${ad(ladder.startPrice)}.`}
      </p>
      {ladder.lastError && (
        <p className="tradera-error">
          Senaste sänkningen gick inte igenom: {ladder.lastError} Vi försöker igen.
        </p>
      )}
    </div>
  );
}

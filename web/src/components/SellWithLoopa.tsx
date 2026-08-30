import { useCallback, useEffect, useRef, useState } from "react";
import { getTraderaState, publishToTradera } from "../api";
import { CloseIcon } from "./icons";
import { useT } from "../lib/i18n";
import { formatSek } from "../lib/price";
import { formatDropDate, ladderRungs } from "../lib/priceLadder";
import type { PriceLadder, TraderaPlan, TraderaState } from "../types";

/**
 * "Sälj med Loopa" — sista steget i annonsen.
 *
 * Knappen hette förut "Publicera på Tradera", och det var att sälja produkten på sin sämsta halva:
 * säljaren fick i uppgift att publicera något, på en marknadsplats de själva skulle hålla reda på.
 * Det Loopa gör är att SÄLJA möbeln. Att annonsen hamnar på Tradera, på vårt konto, är hur vi gör
 * det — inte vad säljaren beställer. Därför står erbjudandet i rubriken och marknadsplatsen som en
 * rad bland de andra i bekräftelsen: den ska gå att läsa, inte behöva förstås för att våga trycka.
 *
 * Knappen skickar ingenting nytt in i någon motor. Allt som läggs ut står redan på kortet ovanför:
 * annonstexten, specifikationerna, skicket och priset. Därför visar bekräftelsesteget exakt vad som
 * går iväg — särskilt kategorin, som är det enda säljaren inte kan läsa någon annanstans på skärmen.
 *
 * Ett klick lägger ut en riktig, publik annons. Det är också varför den har ett bekräftelsesteg: en
 * felaktig annons går att ta bort, men bara manuellt.
 *
 * Bekräftelsen täcker hela skärmen i stället för att bytas in i rutan här nere. Granskningen var
 * förut en lista som vek ut sig längst ned på en lång sida — det sista beslutet togs alltså i det
 * minsta utrymmet på skärmen, med resten av annonsen kvar ovanför som konkurrens. Nu är det den enda
 * bilden: här står vad som läggs ut och knappen som säger ja.
 */
export default function SellWithLoopa({
  jobId,
  onMyListings,
}: {
  jobId: string;
  /** Vidare till profilen. Ritas bara i kvittot: dit går man när den här möbeln är avklarad. */
  onMyListings?: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<TraderaState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  /** Pollar bara medan marknadsplatsens kö arbetar — annonsen går upp på 10-60 s. */
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
      <section className="card-block sell-block sell-done">
        <h3>{t("Möbeln är till salu")}</h3>
        <p className="muted small">
          {t(
            "Loopa sköter försäljningen härifrån. Du får besked så fort möbeln är såld — du behöver inte göra något mer. Annonsen ligger uppe på Tradera, på Loopas konto.",
          )}
        </p>
        {state.ladder && <LadderStatus ladder={state.ladder} shippingSek={plan?.shippingSek ?? 0} />}
        <a className="btn btn-primary sell-link" href={publication.url} target="_blank" rel="noreferrer">
          {t("Se annonsen")}
        </a>
        {/* Kvittot gäller EN möbel. Frågan som kommer efter det — vad har jag ute nu? — besvaras i
            profilen, där den här annonsen just lagt sig överst under "Till salu". */}
        {onMyListings && (
          <button className="btn btn-text sell-mine" onClick={onMyListings}>
            {t("Till dina annonser")}
          </button>
        )}
      </section>
    );
  }

  if (publication?.status === "publishing") {
    return (
      <section className="card-block sell-block">
        <h3>{t("Lägger ut möbeln till salu…")}</h3>
        <div className="sell-waiting">
          <div className="spinner spinner-small" />
          <p className="muted small">{t("Annonsen köas och bilderna laddas upp. Det tar oftast under en minut.")}</p>
        </div>
      </section>
    );
  }

  const blocked = !plan ? (state.blockedReason ?? t("Möbeln går inte att lägga ut till salu än.")) : null;
  const error = failure ?? publication?.error ?? null;

  return (
    <>
      <section className="card-block sell-block">
        <h3>{t("Sälj med Loopa")}</h3>

        {error && <p className="sell-error">{t("Annonsen kunde inte läggas ut: {fel}", { fel: error })}</p>}

        {blocked ? (
          <p className="muted small">{blocked}</p>
        ) : (
          <>
            <p className="muted small">
              {plan!.mode === "fixed"
                ? t(
                    "Vi lägger ut möbeln till salu till fast pris, med bilderna från skanningen och skicket från besiktningen. Sedan sköter vi annonsen — och hör av oss så fort den är såld.",
                  )
                : t(
                    "Vi lägger ut möbeln till salu i {dagar} dagar, med bilderna från skanningen och skicket från besiktningen. Sedan sköter vi annonsen — och hör av oss så fort den är såld.",
                    { dagar: plan!.durationDays ?? 0 },
                  )}
            </p>
            {ladderDrops(state.ladder) > 0 && (
              <p className="muted small">
                {t(
                  "Annonspriset börjar på {start} och sänks {andel} % i veckan ner till {golv}, där det stannar. De {frakt} för hemleveransen ligger kvar oförändrade hela vägen.",
                  {
                    start: formatSek(state.ladder!.startPrice + plan!.shippingSek),
                    andel: Math.round(state.ladder!.weeklyDropPct * 100),
                    golv: formatSek(state.ladder!.floorPrice + plan!.shippingSek),
                    frakt: formatSek(plan!.shippingSek),
                  },
                )}
              </p>
            )}
            {/* Knappen öppnar granskningen, den lägger inte ut något. Ordet är detsamma som i rutans
                rubrik med flit: man trycker på erbjudandet och får se det i sin helhet. */}
            <button
              className="btn btn-primary"
              onClick={() => {
                setFailure(null);
                setConfirming(true);
              }}
            >
              {publication?.status === "error" ? t("Försök igen") : t("Sälj med Loopa")}
            </button>
          </>
        )}
      </section>

      {confirming && plan && (
        <SellConfirm
          plan={plan}
          ladder={state.ladder}
          sending={sending}
          error={failure}
          onCancel={() => setConfirming(false)}
          onConfirm={publish}
        />
      )}
    </>
  );
}

/**
 * Granskningen, i helskärm.
 *
 * Två saker och inget mer: vad som händer när man trycker, och exakt vad som läggs ut. Vad Loopa tar
 * står inte här utan sist på startsidan, innan man börjar — priset på tjänsten hör hemma före första
 * trycket, inte i rutan där man redan bestämt sig. Knapparna ligger stilla i underkanten medan
 * resten rullar, så "Ja, sälj den" aldrig är något man behöver leta efter.
 */
function SellConfirm({
  plan,
  ladder,
  sending,
  error,
  onCancel,
  onConfirm,
}: {
  plan: TraderaPlan;
  ladder: PriceLadder | null;
  sending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const drops = ladderDrops(ladder);

  // Sidan bakom får inte rulla med medan rutan ligger över den.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Escape stänger — utom medan annonsen är på väg iväg, då det inte finns något att ångra.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !sending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sending, onCancel]);

  // Tangentbordet ska landa i rutan och inte kvar på knappen under den.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <div className="sell-modal-root" role="dialog" aria-modal="true" aria-labelledby="sell-modal-title">
      <div className="sell-modal-scrim" onClick={sending ? undefined : onCancel} />
      <div className="sell-modal-panel" ref={panel} tabIndex={-1}>
        <header className="sell-modal-head">
          <h2 id="sell-modal-title">{t("Sälj med Loopa")}</h2>
          <button className="sell-modal-close" onClick={onCancel} disabled={sending} aria-label={t("Stäng")}>
            <CloseIcon size={15} />
          </button>
        </header>

        <div className="sell-modal-body">
          <p className="sell-modal-lede">
            {plan.mode === "fixed"
              ? t(
                  "Trycker du på ja går möbeln ut till salu direkt, till fast pris. Därifrån sköter Loopa annonsen och kontakten med köparen, och hör av sig när den är såld.",
                )
              : t(
                  "Trycker du på ja går möbeln ut till salu direkt, som auktion i {dagar} dagar. Därifrån sköter Loopa annonsen och kontakten med köparen, och hör av sig när den är såld.",
                  { dagar: plan.durationDays ?? 0 },
                )}
          </p>

          {error && <p className="sell-error">{t("Annonsen kunde inte läggas ut: {fel}", { fel: error })}</p>}

          <section className="card-block">
            <h3>{t("Det här läggs ut")}</h3>
            <dl className="card-specs sell-plan">
              <div className="card-spec">
                <dt>{t("Rubrik")}</dt>
                <dd>{plan.title}</dd>
              </div>
              <div className="card-spec">
                <dt>{t("Kategori")}</dt>
                <dd>{plan.categoryName}</dd>
              </div>
              <div className="card-spec">
                <dt>{plan.mode === "fixed" ? t("Pris (Köp Nu)") : t("Utropspris")}</dt>
                <dd>
                  {formatSek(plan.price)}
                  {/* Delarna utskrivna: säljaren satte ett pris på MÖBELN och ska inte behöva räkna ut
                      varför annonsen står på ett annat tal. */}
                  <span className="muted small">
                    {" — "}
                    {t("{pris} för möbeln + {frakt} hemleverans", {
                      pris: formatSek(plan.itemPrice),
                      frakt: formatSek(plan.shippingSek),
                    })}
                    {plan.priceSource === "seller" && ` (${t("ditt startpris")})`}
                    {plan.priceSource === "listing" && ` (${t("annonsgeneratorns förslag, utan skadeavdrag")})`}
                  </span>
                </dd>
              </div>
              {drops > 0 && (
                <div className="card-spec">
                  <dt>{t("Prisplan")}</dt>
                  <dd>
                    {t("−{andel} % i veckan ner till {golv}", {
                      andel: Math.round(ladder!.weeklyDropPct * 100),
                      golv: formatSek(ladder!.floorPrice + plan.shippingSek),
                    })}
                    <span className="muted small">
                      {" — "}
                      {t(
                        drops === 1
                          ? "golvet nås efter {antal} vecka. Sänkningen tar bara av möbelns pris, aldrig av frakten."
                          : "golvet nås efter {antal} veckor. Sänkningen tar bara av möbelns pris, aldrig av frakten.",
                        { antal: drops },
                      )}
                    </span>
                  </dd>
                </div>
              )}
              <div className="card-spec">
                <dt>{t("Annonstyp")}</dt>
                <dd>
                  {plan.mode === "fixed"
                    ? t("Endast Köp Nu — ingen budgivning")
                    : t("Auktion, {dagar} dagar", { dagar: plan.durationDays ?? 0 })}
                </dd>
              </div>
              {plan.condition && (
                <div className="card-spec">
                  <dt>{t("Skick")}</dt>
                  <dd>{plan.condition}</dd>
                </div>
              )}
              <div className="card-spec">
                <dt>{t("Bilder")}</dt>
                <dd>{t("{antal} st", { antal: plan.imageCount })}</dd>
              </div>
              {/* Marknadsplatsen står i bekräftelsen och inte i rubriken: säljaren beställer en
                  försäljning, men ska kunna läsa var möbeln hamnar innan de trycker. */}
              <div className="card-spec">
                <dt>{t("Läggs ut på")}</dt>
                <dd>
                  Tradera
                  <span className="muted small">
                    {" — "}
                    {t("på Loopas konto, du behöver inget eget")}
                  </span>
                </dd>
              </div>
              {/* Står i annonstexten, alltså i bekräftelsen: annonsen berättar att den är skapad av
                  Loopa och pekar ut kortet där skicket går att kontrollera. */}
              <div className="card-spec">
                <dt>{t("Loopa-ID")}</dt>
                <dd>
                  {plan.loopaId}
                  <span className="muted small">
                    {" — "}
                    {t("annonstexten hänvisar till det publika kortet")}
                  </span>
                </dd>
              </div>
              {/* Fast pris, samma på varje annons — men det ingår i priset ovan, och det är den
                  halvan säljaren behöver se innan de trycker. */}
              <div className="card-spec">
                <dt>{t("Leverans")}</dt>
                <dd>
                  {t("Hemleverans ingår")}
                  <span className="muted small">
                    {" — "}
                    {t("budfirma bokas efter köpet, ingen extra kostnad för köparen")}
                  </span>
                </dd>
              </div>
            </dl>
          </section>

          <p className="muted small">{t("Annonsen går upp direkt och blir publik.")}</p>
        </div>

        <footer className="sell-modal-actions">
          <button className="btn btn-text" onClick={onCancel} disabled={sending}>
            {t("Avbryt")}
          </button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={sending}>
            {sending ? t("Lägger ut…") : t("Ja, sälj den")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Hur många veckor det är kvar ner till golvet. 0 = spannet är redan i botten, eller saknas. */
function ladderDrops(ladder: PriceLadder | null): number {
  if (!ladder || ladder.floorPrice >= ladder.currentPrice) return 0;
  return ladderRungs(ladder.currentPrice, ladder.floorPrice, ladder.weeklyDropPct).length - 1;
}

/**
 * Var prisstegen står på en annons som redan ligger ute.
 *
 * Sänkningen sker på servern, veckor efter att den här fliken stängts, så vyn är säljarens enda kvitto
 * på att den faktiskt löper. Därför står nästa datum och nästa pris utskrivna, och ett avvisat
 * prisbyte syns — ett pris som står stilla ska aldrig behöva gissas.
 */
function LadderStatus({ ladder, shippingSek }: { ladder: PriceLadder; shippingSek: number }) {
  const t = useT();
  const rungs = ladderRungs(ladder.currentPrice, ladder.floorPrice, ladder.weeklyDropPct);
  const next = rungs.length > 1 ? rungs[1] : null;
  // Allt här är ANNONSPRISER — vad möbeln kostar en köpare just nu. Stegen räknar i möbelkronor, men
  // det säljaren jämför med är annonsen, och två olika tal för samma annons vore en gåta att lösa.
  const ad = (itemPrice: number) => formatSek(itemPrice + shippingSek);

  return (
    <div className="sell-ladder">
      <div className="sell-ladder-now">
        <span className="ladder-row-label">{t("Ligger på")}</span>
        <strong>{ad(ladder.currentPrice)}</strong>
        <span className="muted small">{t("frakt inräknad")}</span>
      </div>
      <p className="muted small">
        {ladder.floorReachedAt || next === null
          ? t("Lägsta priset är nått. Annonsen ligger kvar på {pris}.", { pris: ad(ladder.floorPrice) })
          : t("Nästa sänkning {datum} till {pris}. Golvet är {golv}.", {
              datum: formatDropDate(ladder.nextDropAt),
              pris: ad(next),
              golv: ad(ladder.floorPrice),
            })}
        {ladder.drops.length > 0 &&
          " " +
            t(
              ladder.drops.length === 1
                ? "{antal} sänkning hittills, från {start}."
                : "{antal} sänkningar hittills, från {start}.",
              { antal: ladder.drops.length, start: ad(ladder.startPrice) },
            )}
      </p>
      {ladder.lastError && (
        <p className="sell-error">
          {t("Senaste sänkningen gick inte igenom: {fel} Vi försöker igen.", { fel: ladder.lastError })}
        </p>
      )}
    </div>
  );
}

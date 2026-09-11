import { useCallback, useEffect, useRef, useState } from "react";
import { getTraderaState, publishToTradera } from "../api";
import { CheckIcon, CloseIcon } from "./icons";
import ProcessFeedback from "./ProcessFeedback";
import LegalLink from "./LegalLink";
import { useT } from "../lib/i18n";
import { formatSek } from "../lib/price";
import { LOOPA_FEE_CAP_SEK, LOOPA_PERCENT, feeIsCapped, loopaFee, sellerPayout } from "../lib/fees";
import { formatDropDate, ladderRungs } from "../lib/priceLadder";
import type { PriceLadder, TraderaPlan, TraderaState } from "../types";

/**
 * "Sälj med Loopa" — sista steget i annonsen.
 *
 * Knappen hette förut "Publicera på Tradera", och det var att sälja produkten på sin sämsta halva:
 * säljaren fick i uppgift att publicera något, på en marknadsplats de själva skulle hålla reda på.
 * Det Loopa gör är att SÄLJA möbeln. VAR den hamnar är hur vi gör det, inte vad säljaren beställer,
 * och står därför inte på skärmen alls längre — varken i rubriken eller i bekräftelsen. Säljaren
 * lämnar över en försäljning; kanalen är vår sak, som budfirman är det.
 *
 * Knappen skickar ingenting nytt in i någon motor. Allt som läggs ut står redan på kortet ovanför:
 * annonstexten, specifikationerna, skicket och priset. Bekräftelsen upprepar därför inte kortet —
 * den visar annonsen som en annons och räknar upp villkoren man säger ja till.
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
  coverUrl,
  onMyListings,
  onSellAnother,
}: {
  jobId: string;
  /**
   * Möbelns omslagsbild, till bekräftelsen.
   *
   * Bekräftelsen visade förut annonsen som en tabell med nio rader. En annons är en bild och ett
   * pris — den som ska godkänna att den läggs ut ska se DEN, inte en specifikation av den. Valfri:
   * blev det aldrig någon bild står förhandsvisningen på titeln och priset, vilket räcker.
   */
  coverUrl?: string | null;
  /** Vidare till profilen. Ritas bara i kvittot: dit går man när den här möbeln är avklarad. */
  onMyListings?: () => void;
  /**
   * Tillbaka till början, med en ny möbel.
   *
   * Kvittot är den enda skärmen i flödet som inte har något nästa steg — möbeln är överlämnad, och
   * utan en väg vidare är enda utvägen bakåtknappen till en annons man just blivit klar med. Den
   * som sålt en möbel har nästan alltid en till, och frågan ställs bäst precis här.
   */
  onSellAnother?: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<TraderaState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * Frågan om processen, öppnad av ja:et och av ingenting annat.
   *
   * Ligger HÄR och inte i kvittot, trots att den ritas ovanpå det: den hör till TRYCKET, inte till
   * skärmen efter. Kvittot ritas om varje gång pollningen svarar och kan stå kvar i timmar medan
   * annonsen granskas — en ruta som ägdes av kvittot hade behövt veta vilken av de visningarna som
   * följde på ett ja, och hade dykt upp igen vid fel tillfälle den dagen den inte visste.
   */
  const [fragarOmProcessen, setFragarOmProcessen] = useState(false);
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
      } else if (next.publication?.status === "pending") {
        // Granskningen görs av en människa och tar minuter till timmar. Sällan nog att inte belasta,
        // ofta nog att kvittot byts mot länken utan att säljaren behöver ladda om.
        timer.current = window.setTimeout(refresh, 30_000);
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
      // Först när annonsen faktiskt gått iväg. Ett ja som föll på ett serverfel är inte en avslutad
      // process, och att fråga vad säljaren tyckte om den mitt i felet vore ett hån.
      if (!feedbackAvklarad(jobId)) setFragarOmProcessen(true);
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

  /**
   * Rutan ritas i VARJE utfall efter ett ja, inte bara i kvittot för annonsen i kö.
   *
   * Vilken skärm som möter ett ja beror på var kön står just då — "granskas", "läggs ut" eller en
   * annons som redan är uppe — och det är en tillfällighet i maskineriet, inte något säljaren gjort
   * olika. Frågan ska ställas likadant i alla tre.
   */
  const processfragan = fragarOmProcessen ? (
    <ProcessFeedback
      jobId={jobId}
      onStang={() => {
        markeraFeedbackAvklarad(jobId);
        setFragarOmProcessen(false);
      }}
    />
  ) : null;

  if (publication?.status === "published" && publication.url) {
    return (
      <section className="card-block sell-block sell-done">
        <h3>{t("Möbeln är till salu")}</h3>
        <p className="muted small">
          {t(
            "Loopa sköter försäljningen härifrån. Du får besked så fort möbeln är såld — du behöver inte göra något mer.",
          )}
        </p>
        {state.ladder && <LadderStatus ladder={state.ladder} shippingSek={plan?.shippingSek ?? 0} />}
        <a className="btn btn-primary sell-link" href={publication.url} target="_blank" rel="noreferrer">
          {t("Se annonsen")}
        </a>
        {/* Kvittot gäller EN möbel. Frågorna som kommer efter det — vad har jag ute nu, och kan jag
            göra det här igen — besvaras i profilen och i ett nytt varv. */}
        <KvittoVagar onMyListings={onMyListings} onSellAnother={onSellAnother} />
        {processfragan}
      </section>
    );
  }

  if (publication?.status === "pending") {
    /**
     * KVITTOT ÄR HELA SIDAN, inte ett block i botten av annonsen.
     *
     * Det låg förut sist på kortet, med möbelns bilder, skickrapporten, specifikationerna och
     * prisstegen kvar ovanför. Allt det är underlag för ett beslut som redan är fattat: säljaren har
     * sagt ja, möbeln är överlämnad, och det finns ingenting kvar på den sidan att göra. Att lämna
     * annonsen stående bakom kvittot gör överlämningen till en notis om en sida man fortfarande står
     * på — och ger gott om anledning att börja granska sin egen annons igen.
     *
     * Här står tre saker: att vi tagit över, var möbeln finns nu, och vägen till nästa. Förklaringen
     * om granskningstiden och raden om prisstegen stod här förut och är borta med flit — båda fanns
     * ordagrant i bekräftelsen säljaren just läste och tryckte ja på.
     */
    return (
      <div className="sell-kvitto" role="status" aria-labelledby="sell-kvitto-rubrik">
        <div className="sell-kvitto-inner">
          <div className="sell-kvitto-markning" aria-hidden="true">
            <CheckIcon size={28} />
          </div>
          {/* RUBRIKEN SÄGER VAD SOM HÄNT, INTE VAD VI GÖR JUST NU. Här stod "Annonsen granskas av
              Loopa", vilket är sant och är fel sak att möta ett ja med: säljaren har lämnat över en
              försäljning och fick ett handläggningsbesked tillbaka. */}
          <h1 id="sell-kvitto-rubrik">{t("Vi tar över försäljningen")}</h1>
          <KvittoVagar onMyListings={onMyListings} onSellAnother={onSellAnother} framtradande />
        </div>
        {processfragan}
      </div>
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
        {processfragan}
      </section>
    );
  }

  const blocked = !plan ? (state.blockedReason ?? t("Möbeln går inte att lägga ut till salu än.")) : null;
  const error = failure ?? publication?.error ?? null;

  return (
    <>
      <section className="card-block sell-block">
        {/* Ingen ordmärkning här. Rubriken är en versal etikett i samma form som "SPECIFIKATIONER"
            och "SKICK" (.card-block h3), och `text-transform: uppercase` hade gjort märket till
            LOOPA i Poppins — vilket är fel bokstavsform för det. Den läser som en avdelningsrubrik,
            inte som avsändaren; märket står på knappen under och i bekräftelsens rubrik. */}
        <h3>{t("Sälj med Loopa")}</h3>

        {error && <p className="sell-error">{t("Annonsen kunde inte läggas ut: {fel}", { fel: error })}</p>}

        {blocked ? (
          <p className="muted small">{blocked}</p>
        ) : (
          <>
            {/* EN MENING. Här stod två stycken — hela annonsplanen och hela prisstegen — ovanför en
                knapp som ändå öppnar en bekräftelse där båda står igen. Det andra exemplaret var
                inte information utan tvekan: det gav något att läsa i stället för att trycka. */}
            <p className="muted small">
              {t("Vi lägger ut möbeln, sköter annonsen och hör av oss så fort den är såld.")}
            </p>
            {/* Knappen öppnar granskningen, den lägger inte ut något. Ordet är detsamma som i rutans
                rubrik med flit: man trycker på erbjudandet och får se det i sin helhet. */}
            <button
              className="btn btn-primary"
              onClick={() => {
                setFailure(null);
                setConfirming(true);
              }}
            >
              {publication?.status === "error" ? (
                t("Försök igen")
              ) : (
                <>
                  {t("Sälj med")} <span className="ordmark ordmark-vit">loopa</span>
                </>
              )}
            </button>
          </>
        )}
      </section>

      {confirming && plan && (
        <SellConfirm
          plan={plan}
          coverUrl={coverUrl ?? null}
          ladder={state.ladder}
          sending={sending}
          error={failure}
          onCancel={() => setConfirming(false)}
          onConfirm={publish}
        />
      )}
      {processfragan}
    </>
  );
}

/**
 * Märket som gör att frågan ställs EN gång per möbel.
 *
 * Lokalt i webbläsaren med flit. Det styr ingenting och skyddar ingenting — det finns bara för att
 * ett omladdat kvitto inte ska be om samma omdöme igen. En serverflagga hade betytt en tabell, en
 * väg och en synkronisering för att lösa ett problem som är precis så stort som det låter.
 *
 * Kastas det (privat läge, avstängd lagring) är utfallet att frågan kan komma en gång till. Det är
 * ett mycket mindre fel än en ruta som kraschar flödet, och därför är båda anropen tysta.
 */
const FEEDBACK_NYCKEL = (jobId: string) => `loopa.feedback.${jobId}`;

function feedbackAvklarad(jobId: string): boolean {
  try {
    return window.localStorage.getItem(FEEDBACK_NYCKEL(jobId)) !== null;
  } catch {
    return false;
  }
}

function markeraFeedbackAvklarad(jobId: string): void {
  try {
    window.localStorage.setItem(FEEDBACK_NYCKEL(jobId), new Date().toISOString());
  } catch {
    // Lagringen är en bekvämlighet. Går den inte att skriva har ingenting gått sönder.
  }
}

/**
 * Kvittots fot: vägen till de egna annonserna, och vägen till nästa möbel.
 *
 * Ligger i en egen funktion för att de två kvittona — annonsen i kö och annonsen uppe — är samma
 * ögonblick sett med några timmars mellanrum. Att bara det ena hade en väg vidare var inte ett val
 * utan en glömska.
 */
function KvittoVagar({
  onMyListings,
  onSellAnother,
  /**
   * Ska "Till mina annonser" vara den fyllda knappen?
   *
   * Ja i kvittot för annonsen i kö: där finns ingen annan handling alls, och en dämpad textlänk som
   * enda väg ut lämnar säljaren stående. Nej när annonsen är uppe — då är "Se annonsen" skärmens
   * huvudsak, och två fyllda knappar under varandra gör vägen vidare till ett val mellan likar.
   */
  framtradande = false,
}: {
  onMyListings?: () => void;
  onSellAnother?: () => void;
  framtradande?: boolean;
}) {
  const t = useT();
  if (!onMyListings && !onSellAnother) return null;
  return (
    <div className="sell-vagar">
      {/* Annonserna först: frågan direkt efter ett ja är "var ligger den nu?", och svaret är
          profilen, där möbeln just lagt sig överst. */}
      {onMyListings && (
        <button className={`btn ${framtradande ? "btn-primary" : "btn-text"} sell-mine`} onClick={onMyListings}>
          {t("Till mina annonser")}
        </button>
      )}
      {onSellAnother && (
        <button className="btn btn-text sell-again" onClick={onSellAnother}>
          {t("Sälj en till möbel")}
        </button>
      )}
    </div>
  );
}

/**
 * Granskningen, i helskärm.
 *
 * DEN VISAR ANNONSEN, INTE EN SPECIFIKATION AV DEN.
 *
 * Här stod förut nio rader i en definitionslista: rubrik, kategori, pris, prisplan, annonstyp,
 * skick, bilder, marknadsplats, Loopa-ID. Allt var sant och tillsammans var det oläsbart — en
 * blankett att kvittera, i det ögonblick säljaren ska känna igen sin möbel och säga ja. Ingen
 * handlare visar en annons genom att räkna upp dess fält.
 *
 * Nu står annonsen som en annons: bilden, rubriken, priset. Det är de tre sakerna en köpare kommer
 * att se, och därför de tre säljaren ska godkänna. Under dem ligger villkoren som korta rader —
 * annonstypen, skicket, leveransen, prisplanen — för de svarar på "vad går jag med på", vilket är
 * en annan fråga än "vad läggs ut".
 *
 * TVÅ RADER FÖLL BORT HELT. Marknadsplatsen: säljaren beställer en försäljning, inte en publicering
 * på ett visst ställe, och vilket konto annonsen ligger på är vårt problem. Loopa-ID:t: det är en
 * intern nyckel som råkar stå i annonstexten, och en kod utan uppgift på en bekräftelseskärm är
 * precis den sortens detalj som får en enkel sida att kännas administrativ.
 *
 * EN RAD KOM TILLBAKA: vad säljaren får ut. Avgiften stod länge bara på startsidan, med motiveringen
 * att priset på tjänsten hör hemma före första trycket och inte i rutan där man redan bestämt sig.
 * Det stämmer om avgiften är en procentsats man kan räkna i huvudet — men den har ett tak, och ett
 * tak går inte att gissa sig till. "20 %" på en möbel för 8 400 kr läser som 1 680 kr, och det är
 * 680 kr fel. Uträkningen står därför här, med möbelns pris, vår del och summan säljaren får, för
 * det är det sista talet man vill se innan man säger ja.
 *
 * Kategorin föll också: den säger var hos någon annan möbeln hamnar, vilket är samma svar som
 * marknadsplatsen och lika ointressant för den som säljer soffan.
 */
function SellConfirm({
  plan,
  coverUrl,
  ladder,
  sending,
  error,
  onCancel,
  onConfirm,
}: {
  plan: TraderaPlan;
  coverUrl: string | null;
  ladder: PriceLadder | null;
  sending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const drops = ladderDrops(ladder);

  /**
   * De två kryssen.
   *
   * Villkoren ovanför är sådant vi talar om; de här två är sådant säljaren intygar, och därför är de
   * kryss och inte rader. Det andra finns för att en möbel som ligger kvar till salu någon annanstans
   * kan bli såld två gånger, och det är köparen och budfirman som får betala för det — inte något vi
   * kan se från vår sida, bara något säljaren kan svara på.
   *
   * Två separata kryss och inte ett gemensamt: det är två olika åtaganden, och ett kryss som betyder
   * båda är ett kryss man inte har läst.
   */
  const [godkannerVillkor, setGodkannerVillkor] = useState(false);
  const [harTagitBortAndra, setHarTagitBortAndra] = useState(false);
  const fårSälja = godkannerVillkor && harTagitBortAndra;

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

  /**
   * Villkoren, som korta rader.
   *
   * Byggs som en lista och inte som JSX i rad efter rad, för att raderna är villkorade var för sig
   * och en hel del av dem saknas ofta: en möbel utan prisstege och utan skickuppgift ska ge tre
   * rader, inte tre rader och två tomma hål.
   */
  const villkor = [
    plan.mode === "fixed"
      ? t("Fast pris — ingen budgivning")
      : t("Auktion i {dagar} dagar", { dagar: plan.durationDays ?? 0 }),
    plan.condition ? t("Skick: {skick}", { skick: plan.condition }) : null,
    t("Hemleverans ingår för köparen"),
    drops > 0
      ? t("Priset sänks {andel} % i veckan ner till {golv}", {
          andel: Math.round(ladder!.weeklyDropPct * 100),
          golv: formatSek(ladder!.floorPrice + plan.shippingSek),
        })
      : null,
  ].filter((v): v is string => v !== null);

  return (
    <div className="sell-modal-root" role="dialog" aria-modal="true" aria-labelledby="sell-modal-title">
      <div className="sell-modal-scrim" onClick={sending ? undefined : onCancel} />
      <div className="sell-modal-panel" ref={panel} tabIndex={-1}>
        <header className="sell-modal-head">
          {/* Ordmärket i accentfärg här, inte vitt: rubriken står på en ljus yta. Vitt hör till den
              fyllda knappen. Samma märke, samma bokstav — bara den färg underlaget kräver. */}
          <h2 id="sell-modal-title">
            {t("Sälj med")} <span className="ordmark">loopa</span>
          </h2>
          <button className="sell-modal-close" onClick={onCancel} disabled={sending} aria-label={t("Stäng")}>
            <CloseIcon size={15} />
          </button>
        </header>

        <div className="sell-modal-body">
          <p className="sell-modal-lede">
            {plan.mode === "fixed"
              ? t("Trycker du på ja går möbeln ut till salu direkt. Därifrån sköter vi resten.")
              : t("Trycker du på ja går möbeln ut som auktion i {dagar} dagar. Därifrån sköter vi resten.", {
                  dagar: plan.durationDays ?? 0,
                })}
          </p>

          {error && <p className="sell-error">{t("Annonsen kunde inte läggas ut: {fel}", { fel: error })}</p>}

          {/* ANNONSEN. Bilden mot vitt precis som på kortet ovanför, så säljaren känner igen den. */}
          <div className="sell-preview">
            {coverUrl && (
              <div className="sell-preview-bild">
                <img src={coverUrl} alt="" />
              </div>
            )}
            <div className="sell-preview-text">
              <span className="sell-preview-kicker">{t("Det här läggs ut")}</span>
              <h3 className="sell-preview-titel">{plan.title}</h3>
              <div className="sell-preview-pris">{formatSek(plan.price)}</div>
              {/* Delarna utskrivna, men som en bildtext och inte som en rad i en tabell: säljaren
                  satte ett pris på MÖBELN och ska inte behöva räkna ut varför annonsen står på ett
                  annat tal. */}
              <p className="sell-preview-delar">
                {t("{pris} för möbeln + {frakt} hemleverans", {
                  pris: formatSek(plan.itemPrice),
                  frakt: formatSek(plan.shippingSek),
                })}
              </p>
            </div>
          </div>

          <ul className="sell-villkor">
            {villkor.map((rad) => (
              <li key={rad}>
                <CheckIcon size={14} />
                <span>{rad}</span>
              </li>
            ))}
          </ul>

          {/*
            VAD SÄLJAREN FÅR UT, uträknat.

            Räknat på MÖBELNS pris och inte på annonspriset ovanför: hemleveransens kronor går rakt
            vidare till budfirman och är ingen del av affären mellan säljaren och oss. Att de två
            talen skiljer sig är därför inte ett fel utan hela poängen, och noten under säger det —
            utan den läser skillnaden som ett räknefel i vår favör.

            Taket är utskrivet bara när det faktiskt slagit till. "20 %, högst 1 000 kr" på en möbel
            för 900 kr är en upplysning om ett läge säljaren inte är i.
          */}
          <dl className="sell-delning">
            <div>
              <dt>{t("Möbelns pris")}</dt>
              <dd>{formatSek(plan.itemPrice)}</dd>
            </div>
            <div>
              <dt>
                {t("Loopas del")}
                <span>
                  {feeIsCapped(plan.itemPrice)
                    ? t("{andel} %, högst {tak}", { andel: LOOPA_PERCENT, tak: formatSek(LOOPA_FEE_CAP_SEK) })
                    : t("{andel} % av priset", { andel: LOOPA_PERCENT })}
                </span>
              </dt>
              <dd>−{formatSek(loopaFee(plan.itemPrice))}</dd>
            </div>
            <div className="sell-delning-sum">
              <dt>{t("Du får")}</dt>
              <dd>{formatSek(sellerPayout(plan.itemPrice))}</dd>
            </div>
          </dl>
          <p className="sell-delning-not">
            {t("Hemleveransens {frakt} räknas inte in — de går vidare till budfirman.", {
              frakt: formatSek(plan.shippingSek),
            })}
          </p>

          <div className="sell-intyg">
            <label>
              <input
                type="checkbox"
                checked={godkannerVillkor}
                onChange={(e) => setGodkannerVillkor(e.target.checked)}
                disabled={sending}
              />
              <span>
                {t("Jag godkänner Loopas")} <LegalLink doc="terms">{t("användarvillkor")}</LegalLink>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={harTagitBortAndra}
                onChange={(e) => setHarTagitBortAndra(e.target.checked)}
                disabled={sending}
              />
              <span>{t("Jag tar bort mina andra publicerade annonser av möbeln")}</span>
            </label>
          </div>
        </div>

        <footer className="sell-modal-actions">
          <button className="btn btn-text" onClick={onCancel} disabled={sending}>
            {t("Avbryt")}
          </button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={sending || !fårSälja}>
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

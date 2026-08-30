import type { FurnitureIdentity, PriceEstimate } from "../types";
import { useJobPoll } from "../lib/useJobPoll";
import { formatSek, variantLabel } from "../lib/price";
import { ChevronRight } from "../components/icons";
import BrandAvatar from "../components/BrandAvatar";
import FlowSteps from "../components/FlowSteps";
import PriceLadderPicker from "../components/PriceLadderPicker";
import { usePageTitle } from "../lib/pageTitle";
import { useT } from "../lib/i18n";

/**
 * Priset först, skicket sedan.
 *
 * De två halvorna beror inte på varandra: prismotorn söker på märke och modell, skickmotorn tittar på
 * bildrutorna. Att visa dem tillsammans betydde att den snabba halvan väntade in den långsamma. Nu
 * startar prisfrågan när säljaren lämnar startsidan och besiktningen när filmen är klar, och det som
 * blir färdigt först är också det som visas först.
 */
export default function PriceScreen({
  identity,
  jobId,
  onSeeCondition,
}: {
  identity: FurnitureIdentity;
  jobId: string;
  onSeeCondition: () => void;
}) {
  const t = useT();
  usePageTitle("Prisförslag");

  /**
   * Pollningen slutar när PRISET landat — inte när skickbedömningen är klar.
   *
   * DET HÄR VAR FELET bakom "priset visas först på annonsen". Villkoret var "stage=done och inte
   * reviewPending", och det inträffar innan prissättningen ens BÖRJAT: prismotorn väntar in
   * skadelistan och tar sedan sina ~15 sekunder. Skärmen hämtade alltså sista gången i exakt det
   * ögonblick priset fortfarande var null, slutade fråga, och stod kvar med skelettet — tills
   * säljaren klickade sig vidare, där kortet hämtar jobbet på nytt och priset plötsligt fanns.
   *
   * Att det bara hände IBLAND är samma sak sett från andra hållet: den som dröjde på
   * specifikationsskärmen kom hit efter att priset redan skrivits in, och fick det på första frågan.
   *
   * Samma pollning som resten av flödet använder (se lib/useJobPoll): ett jobb som fallit ger upp,
   * och en server som dött mellan två frågor slutar snurra efter dess bortre gräns i stället för att
   * hänga för evigt.
   */
  const { job, gaveUp, failed } = useJobPoll(jobId, (j) => !!j.result?.price);

  /**
   * Priset visas först — men räknas SIST.
   *
   * Prismotorn drar av för skadorna, så en siffra hämtad innan skickgraderingen är klar är en annan
   * siffra än den riktiga. Vyn väntar därför in `reviewPending: false` innan den visar något tal.
   * Att visa ett preliminärt pris som sedan sjunker läser som ett svek även när det är riktigare.
   */
  const graded = !!job?.result && !job.result.reviewPending;
  const price: PriceEstimate | null = graded ? job!.result!.price : null;

  const conditionReady = graded;
  const conditionFailed = failed;

  return (
    <div className="screen screen-light price-screen">
      <header className="price-hero-head">
        <FlowSteps current={3} />
        <div className="price-identity">
          {identity.brand && <BrandAvatar name={identity.brand} size={30} />}
          <span>{[identity.brand, identity.model].filter(Boolean).join(" ")}</span>
        </div>
      </header>

      <section className="price-big-card">
        {failed || gaveUp || price?.status === "unavailable" ? (
          <>
            <div className="price-panel-head">{t("Prisförslag")}</div>
            <p className="price-empty-title">{t("Priset kunde inte hämtas")}</p>
            <p className="muted small">
              {price?.unavailableReason ??
                (gaveUp ? t("Vi fick inget svar från servern.") : (job?.error ?? t("Prismotorn svarade inte.")))}
            </p>
          </>
        ) : !price ? (
          <>
            <div className="price-panel-head">{t("Prisförslag")}</div>
            <div className="price-skeleton" aria-label={t("Beräknar prisförslag")} />
            <p className="muted small">
              {!job?.result
                ? t("Bedömer skicket…")
                : job.result.reviewPending
                  ? t("Väger in skadorna…")
                  : t("Räknar fram priset…")}
            </p>
            <p className="muted small">{t("Priset räknas när besiktningen är klar — skadorna påverkar det.")}</p>
          </>
        ) : price.status === "no_data" ? (
          <>
            <div className="price-panel-head">{t("Prisförslag")}</div>
            <p className="price-empty-title">{t("Inget prisförslag den här gången")}</p>
            <p className="muted small">{t("Vi hittade inga tillräckligt lika annonser att jämföra med.")}</p>
          </>
        ) : (
          <>
            <div className="price-panel-head">{t("Uppskattat värde")}</div>
            <div className="price-main price-main-xl">{formatSek(price.default)}</div>
            <div className="price-range">
              <span className="price-range-end">
                <em>{formatSek(price.low)}</em>
                <span className="muted small">{t("säljs snabbt")}</span>
              </span>
              <span className="price-range-bar" aria-hidden="true" />
              <span className="price-range-end price-range-end-high">
                <em>{formatSek(price.high)}</em>
                <span className="muted small">{t("säljs långsamt")}</span>
              </span>
            </div>
            <p className="muted small price-basis">
              {price.matchCount === 1
                ? t("Bygger på {antal} liknande annons", { antal: price.matchCount })
                : t("Bygger på {antal} liknande annonser", { antal: price.matchCount })}
              {price.variant?.length ? ` (${price.variant.map((v) => t(variantLabel(v))).join(", ")})` : ""}.
            </p>
            <p className="price-caveat">
              {price.damageDeduction
                ? t("Skadorna vi hittade drar ner priset {andel} %.", {
                    andel: Math.round(price.damageDeduction * 100),
                  })
                : t("Inga skador som påverkar priset.")}
            </p>
          </>
        )}
      </section>

      {price?.status === "ok" && price.default !== null && (
        <PriceLadderPicker jobId={jobId} price={price} initial={job?.priceLadder ?? null} />
      )}

      <button className="btn btn-primary next-step" onClick={onSeeCondition}>
        <span>{conditionFailed ? t("Se vad som hände") : t("Se skickbedömningen")}</span>
        <span className="next-step-meta">
          {conditionReady ? t("klar") : conditionFailed ? "" : t("arbetar…")}
          <ChevronRight size={18} />
        </span>
      </button>
      <p className="form-hint">
        {conditionReady
          ? t("Skadelistan och annonsen är klara.")
          : conditionFailed
            ? t("Besiktningen stötte på ett problem.")
            : t("Besiktning, prissättning och annons kör parallellt.")}
      </p>
    </div>
  );
}

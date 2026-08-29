import { useEffect, useState } from "react";
import type { ConditionJob, FurnitureIdentity, PriceEstimate } from "../types";
import { getJob } from "../api";
import { formatSek, variantLabel } from "../lib/price";
import { ChevronRight } from "../components/icons";
import BrandAvatar from "../components/BrandAvatar";
import FlowSteps from "../components/FlowSteps";
import PriceLadderPicker from "../components/PriceLadderPicker";
import { usePageTitle } from "../lib/pageTitle";

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
  const [job, setJob] = useState<ConditionJob | null>(null);
  usePageTitle("Prisförslag");

  /**
   * Priset visas först — men räknas SIST.
   *
   * Prismotorn drar av för skadorna, så en siffra hämtad innan skickgraderingen är klar är en annan
   * siffra än den riktiga. Vyn väntar därför in `reviewPending: false` innan den visar något tal.
   * Att visa ett preliminärt pris som sedan sjunker läser som ett svek även när det är riktigare.
   */
  const graded = !!job?.result && !job.result.reviewPending;
  const price: PriceEstimate | null = graded ? job!.result!.price : null;
  const failed = job?.progress.stage === "error";

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const j = await getJob(jobId);
        if (cancelled) return;
        setJob(j);
        // Fortsätt även efter "done": den slutliga prissättningen landar med granskningen, och
        // truth-cardet en stund efter den.
        if (j.progress.stage !== "error" && (j.progress.stage !== "done" || j.result?.reviewPending)) {
          setTimeout(poll, 1200);
        }
      } catch {
        if (!cancelled) setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

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
        {failed || price?.status === "unavailable" ? (
          <>
            <div className="price-panel-head">Prisförslag</div>
            <p className="price-empty-title">Priset kunde inte hämtas</p>
            <p className="muted small">{price?.unavailableReason ?? "Prismotorn svarade inte."}</p>
          </>
        ) : !price ? (
          <>
            <div className="price-panel-head">Prisförslag</div>
            <div className="price-skeleton" aria-label="Beräknar prisförslag" />
            <p className="muted small">
              {job?.result?.reviewPending ? "Väger in skadorna…" : "Bedömer skicket…"}
            </p>
            <p className="muted small">Priset räknas när besiktningen är klar — skadorna påverkar det.</p>
          </>
        ) : price.status === "no_data" ? (
          <>
            <div className="price-panel-head">Prisförslag</div>
            <p className="price-empty-title">Inget prisförslag den här gången</p>
            <p className="muted small">Vi hittade inga tillräckligt lika annonser att jämföra med.</p>
          </>
        ) : (
          <>
            <div className="price-panel-head">Uppskattat värde</div>
            <div className="price-main price-main-xl">{formatSek(price.default)}</div>
            <div className="price-range">
              <span className="price-range-end">
                <em>{formatSek(price.low)}</em>
                <span className="muted small">säljs snabbt</span>
              </span>
              <span className="price-range-bar" aria-hidden="true" />
              <span className="price-range-end price-range-end-high">
                <em>{formatSek(price.high)}</em>
                <span className="muted small">säljs långsamt</span>
              </span>
            </div>
            <p className="muted small price-basis">
              Bygger på {price.matchCount} liknande {price.matchCount === 1 ? "annons" : "annonser"}
              {price.variant?.length ? ` (${price.variant.map(variantLabel).join(", ")})` : ""}.
            </p>
            <p className="price-caveat">
              {price.damageDeduction
                ? `Skadorna vi hittade drar ner priset ${Math.round(price.damageDeduction * 100)} %.`
                : "Inga skador som påverkar priset."}
            </p>
          </>
        )}
      </section>

      {price?.status === "ok" && price.default !== null && (
        <PriceLadderPicker jobId={jobId} price={price} initial={job?.priceLadder ?? null} />
      )}

      <button className="btn btn-primary next-step" onClick={onSeeCondition}>
        <span>{conditionFailed ? "Se vad som hände" : "Se skickbedömningen"}</span>
        <span className="next-step-meta">
          {conditionReady ? "klar" : conditionFailed ? "" : "arbetar…"}
          <ChevronRight size={18} />
        </span>
      </button>
      <p className="form-hint">
        {conditionReady
          ? "Skadelistan och truth-cardet är klara."
          : conditionFailed
            ? "Besiktningen stötte på ett problem."
            : "Besiktning, prissättning och annons kör parallellt."}
      </p>
    </div>
  );
}

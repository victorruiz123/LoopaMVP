/**
 * Annonstexten, för säljarens annonsvy — och om den går att ändra.
 *
 * Säljaren ska läsa exakt det köparen läser. Samma funktion bygger texten som publiceringen
 * (traderaAdBlocks), så de kan inte börja skilja sig.
 *
 * PUBLICERAD ANNONS, UPPDATERINGEN PÅ: texten som den är nu. En ändring i vyn förs ut till Tradera,
 * Blocket och Facebook (integrations/annonsUppdatering.ts), och det är den texten köparen snart läser.
 * Frakten är den annonsen gick ut med.
 * PUBLICERAD ANNONS, UPPDATERINGEN AV: blocken som gick upp på Tradera, och texten går inte att ändra —
 * en rättelse hade bara ändrat appen, inte annonsen köparen läser.
 */

import type { AdBlock } from "./adContent.js";
import type { ConditionJob } from "./types.js";

export interface SaljarensAnnonstext {
  blocks: AdBlock[];
  /** Annonsen ligger ute (Tradera eller Blocket). */
  published: boolean;
  /** Vyn får visa pennan. */
  redigerbar: boolean;
}

export async function annonstextForSaljaren(job: ConditionJob): Promise<SaljarensAnnonstext | null> {
  if (!job.result?.listing?.result) return null;

  const { annonsUppdateringPa } = await import("./integrations/annonsUppdatering.js");
  const uppdateras = annonsUppdateringPa();
  const liggerUte = job.tradera?.status === "published" || job.blocket?.status === "published";
  const traderasBlock = job.tradera?.status === "published" ? (job.tradera.adBlocks ?? null) : null;
  if (traderasBlock && !uppdateras) return { blocks: traderasBlock, published: true, redigerbar: false };

  const { traderaAdBlocks } = await import("./integrations/tradera/publish.js");
  const { kategoriMedRattelse, medRattelser } = await import("./butik/overrides.js");
  const { annonsensFrakt } = await import("./hemleverans.js");
  const frakt = job.tradera?.shippingSek ?? job.blocket?.shippingSek ?? annonsensFrakt(job, await kategoriMedRattelse(job));
  return {
    blocks: traderaAdBlocks(await medRattelser(job), frakt),
    published: liggerUte,
    redigerbar: !liggerUte || uppdateras,
  };
}

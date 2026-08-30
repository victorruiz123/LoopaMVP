/**
 * Annonsen -> Blocket, för hand.
 *
 * Blocket har inget öppet API för att lägga upp annonser, och det här låtsas inte om något annat:
 * ingenting skickas någonstans. Säljaren lägger upp annonsen själv, under sitt eget namn, och det
 * enda Loopa kan göra är att lämna över varje fält färdigt — rubrik, pris, beskrivning och bilder —
 * så överföringen blir kopiera och klistra i stället för att skriva av en skärm.
 *
 * Texten är SAMMA annons som går upp på Tradera (adContent.ts), med två skillnader som båda följer
 * av vem som är avsändare:
 *
 * 1. INGET LEVERANSSTYCKE. På Tradera säljer Loopa, och Loopa bokar budfirman. På Blocket säljer
 *    säljaren, och ett löfte om hemleverans hade varit deras att hålla utan att de gett det.
 * 2. PRISET ÄR MÖBELNS, utan de 600 kronorna för hemleveransen. De ligger i Tradera-priset just för
 *    att leveransen ingår där; här finns ingen leverans att räkna in.
 */

import { adImages, adTitle, composeAd, publicCardUrl, renderAdPlain, resolveAdPrice } from "../adContent.js";
import { loopaIdFor } from "../loopaId.js";
import type { ConditionJob } from "../types.js";

/** En bildruta säljaren ska ladda upp. Ordningen är annonsens — den första blir omslaget. */
export interface BlocketAdImage {
  id: string;
  viewLabel: string | null;
}

/** Fälten i Blockets formulär, färdiga att klistra in. */
export interface BlocketAd {
  title: string;
  /** Möbelns pris i kronor, utan frakt. */
  price: number;
  priceSource: "seller" | "condition" | "listing";
  /** Beskrivningen som ren text — Blockets fält renderar varken HTML eller markdown. */
  description: string;
  loopaId: string;
  /** Adressen till den publika annonsen, när servern vet vilken den är. Står redan i beskrivningen. */
  publicUrl: string | null;
  images: BlocketAdImage[];
}

/** Svaret från GET /api/jobs/:id/blocket. Samma form som Tradera-vägen: antingen en plan eller ett skäl. */
export interface BlocketState {
  ad: BlocketAd | null;
  blockedReason: string | null;
}

/**
 * Annonsen som den ska se ut på Blocket, eller skälet till att den inte går att lämna över.
 *
 * Samma tre krav som Tradera-publiceringen ställer — en annonstext, ett pris och minst en bild — och
 * med samma ord, för att det inte ska gå att tro att den ena vägen kan något den andra inte kan.
 */
export async function blocketAdFor(job: ConditionJob): Promise<BlocketState> {
  const blocked = (reason: string): BlocketState => ({ ad: null, blockedReason: reason });

  const result = job.result;
  const card = result?.listing?.result ?? null;
  if (!result) return blocked("Analysen är inte klar än.");
  if (!card) return blocked("Annonsen kunde inte skapas, så det finns inget att föra över.");

  const title = adTitle(job);
  if (!title) return blocked("Annonsen saknar rubrik.");

  const price = resolveAdPrice(job);
  if (!price) return blocked("Det finns inget pris att sätta i annonsen.");

  const images = await adImages(job);
  if (images.length === 0) return blocked("Jobbet har inga bilder kvar på disk.");

  const loopaId = loopaIdFor(job.id);
  return {
    ad: {
      title,
      price: price.value,
      priceSource: price.source,
      description: renderAdPlain(composeAd(job, { delivery: false })),
      loopaId,
      publicUrl: publicCardUrl(loopaId),
      images: images.map((image) => ({ id: image.id, viewLabel: image.viewLabel })),
    },
    blockedReason: null,
  };
}

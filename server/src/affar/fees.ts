/**
 * Vad en Trygg affär kostar köparen.
 *
 * SÄLJAREN FÅR SITT FULLA PRIS. Ingen provision dras från deras sida — det de kommit överens om är
 * det de får. Vår ersättning ligger helt på köparens sida, och den är synlig i sin helhet på
 * sanningskortet INNAN säljaren bjuds in. Skälet är att en köpare som upptäcker avgifter efter att
 * ha dragit in en säljare i en affär har blivit lurad, oavsett hur rimliga avgifterna är.
 *
 * EN ENDA FRAKTLOGIK I HELA PRODUKTEN. Leveransen prissätts av `deliveryQuote` i butiken —
 * zonbaserat, 495/695/895 — och inte av en egen platt taxa här. Två fraktpriser för samma sträcka i
 * samma app är två priser användaren kan se samtidigt, och den dagen någon jämför dem har vi ingen
 * bra förklaring.
 *
 * SERVICEAVGIFTEN är vad granskningen, den skyddade betalningen och hanteringen kostar. Platt, för
 * att arbetet är detsamma oavsett möbelns pris: samma filmning att gå igenom, samma pengar att hålla,
 * samma två parter att hålla ihop.
 */

import { deliveryQuote } from "../butik/delivery.js";

/** Serviceavgiften. Config, för att den kommer att justeras innan den är rätt. */
export const SERVICE_FEE_SEK = Number(process.env.AFFAR_SERVICE_FEE_SEK ?? 200);

/**
 * När avgifterna är stora nog att förtjäna en varning.
 *
 * INFORMERAR, BLOCKERAR INTE. En 500-kronorsstol med 695 kr frakt och 200 kr service är fortfarande
 * ett vettigt köp för den som inte har bil och inte vill åka till Haninge — men det är ett beslut
 * köparen ska fatta med talen framför sig, inte upptäcka i kassan. Att stoppa affären hade varit att
 * fatta beslutet åt dem.
 */
export const VIABILITY_RATIO = Number(process.env.AFFAR_VIABILITY_RATIO ?? 0.6);

export interface FeeBreakdown {
  /** Det säljaren får. Oavkortat. */
  itemPriceSek: number;
  serviceFeeSek: number;
  deliveryFeeSek: number;
  totalSek: number;
  /** Zonens namn, när postnumret räckte för att avgöra den. */
  deliveryZone: string | null;
  deliverable: boolean;
  /** Satt när avgifterna är stora relativt möbelns pris. En upplysning, inte ett hinder. */
  viabilityNote: string | null;
}

const SEK = (n: number) => n.toLocaleString("sv-SE");

export function feesFor(itemPriceSek: number | null, postalCode: string | null): FeeBreakdown {
  const price = itemPriceSek ?? 0;
  const quote = deliveryQuote(postalCode ?? "");
  const delivery = quote.zone?.feeSek ?? 0;
  const fees = SERVICE_FEE_SEK + delivery;

  /**
   * Varningen räknas på PRISET, inte på totalen.
   *
   * "Avgifterna är 60 % av totalen" är en annan och mindre begriplig mening än "avgifterna är nästan
   * lika mycket som möbeln kostar". Det andra är vad köparen faktiskt väger.
   */
  const note =
    price > 0 && fees / price >= VIABILITY_RATIO
      ? `Avgifterna är ${SEK(fees)} kr på en möbel för ${SEK(price)} kr. Det kan vara värt det för hemleverans och granskning — men värt att tänka på.`
      : null;

  return {
    itemPriceSek: price,
    serviceFeeSek: SERVICE_FEE_SEK,
    deliveryFeeSek: delivery,
    totalSek: price + fees,
    deliveryZone: quote.zone?.name ?? null,
    deliverable: quote.deliverable,
    viabilityNote: note,
  };
}

/**
 * Hemleveransen — ett fast belopp OVANPÅ möbelns pris.
 *
 * LÅG I integrations/tradera/ och flyttade hit när Blocket blev en andra kanal. Leveransen är inte
 * Traderas: den är Loopas löfte till köparen, och den gäller oavsett var annonsen råkar ligga. Ett
 * belopp som bodde i en marknadsplats mapp men användes av två läste som att den ena kanalen lånade
 * den andras regel.
 *
 * Loopa kör hem möbeln efter köpet. Beloppet läggs på annonspriset i stället för att skickas som
 * `shippingCost` till Tradera: en fraktavgift i Traderas kassa hade lagts på en andra gång, och
 * köparen betalat 1 200 kr för en leverans som kostar 600. Därför säger annonstexten att frakten
 * ingår — den ingår i det pris som står.
 *
 * BELOPPET BESTÄMS AV KATEGORIN (butik/delivery.ts `fraktFor`): 600 kr, soffor 700 kr sedan
 * 2026-09-29. Konstant i koden och inte miljövariabel med flit. Beloppet står i annonstexten, i
 * priset köparen betalar och i prisstegens räkning; att kunna ändra det utan att röra koden vore att
 * kunna ändra vad annonsen lovar utan att ett enda test går sönder.
 */

import { fraktFor } from "./butik/delivery.js";
import type { ConditionJob } from "./types.js";

/** Grundbeloppet — och det varje annons publicerad före 2026-09-29 bär, oavsett kategori. */
export const SHIPPING_INCLUDED_SEK = fraktFor(null);

/**
 * Frakten den här möbelns annonser ska bära.
 *
 * EN MÖBEL SOM REDAN LIGGER UTE BEHÅLLER SITT BELOPP. Talet är inbakat i annonspriset och utskrivet i
 * texten; ändrades det i efterhand skulle nästa prissänkning lägga på mellanskillnaden i tysthet medan
 * texten fortsatte säga det gamla, och en Blocket-annons publicerad efter Tradera-annonsen lova en
 * annan frakt för samma möbel. Därför sparas beloppet på publiceringen (`shippingSek`), och en
 * publicering från före fältet räknas som grundbeloppet — det den gick ut med.
 */
export function annonsensFrakt(job: Pick<ConditionJob, "tradera" | "blocket">, categorySlug: string | null): number {
  for (const pub of [job.tradera, job.blocket]) {
    if (typeof pub?.shippingSek === "number") return pub.shippingSek;
    if (pub?.status === "published") return SHIPPING_INCLUDED_SEK;
  }
  return fraktFor(categorySlug);
}

/**
 * Priset som går ut i annonsen: möbeln plus frakten. ENDA stället de två talen läggs ihop.
 *
 * Prisstegen räknar i möbelkronor — säljarens spann, kortets värdering och prismotorns förslag är
 * alla priset på MÖBELN — och de 15 % i veckan får bara äta av den delen. Låg frakten inne i stegen
 * skulle den sjunka med den: efter fem veckor vore det 266 kr som var inräknat medan annonsen
 * fortsatte påstå 600, och Loopa betalade mellanskillnaden på varje leverans.
 *
 * Därför konverteras det på GRÄNSEN, i de anrop som faktiskt sätter ett pris i en annons:
 * publiceringen på Tradera respektive Blocket, och den veckovisa sänkningen (priceLadder.ts).
 * `shippingSek` kommer ur `annonsensFrakt`.
 */
export function prisMedHemleverans(itemPrice: number, shippingSek: number): number {
  return Math.round(itemPrice) + shippingSek;
}

/**
 * Tradera tar frakten i kassan, inte i priset — för annonser publicerade från 2026-11-19.
 *
 * FÖRUT låg hemleveransen inbakad i Tradera-priset (gamingstolen: 500 kr möbel stod som 1 100 kr), och
 * köparen såg ett pris som inte stämde med hemsidan. Nu går möbelpriset till Tradera och hemleveransen
 * som Traderas fraktkostnad (`shippingCost`) — köparen betalar samma summa, en gång, men ser vad som är
 * möbeln och vad som är frakten. Blocket har ingen fraktruta för Loopas egen leverans och behåller
 * frakten i priset.
 *
 * EN ANNONS SOM REDAN LIGGER UTE BEHÅLLER SITT SÄTT. Dess text säger att frakten ingår och dess
 * fraktkostnad hos Tradera är 0; att sänka den till bara möbelpriset vore att ge bort leveransen.
 * Därför bär publiceringen `fraktSeparat`, och bara en publicerad annons utan flaggan räknas som den
 * gamla sorten. Allt som ännu inte ligger ute — även en omläggning på väg upp — blir den nya.
 */
export function traderaFraktSeparat(job: Pick<ConditionJob, "tradera">): boolean {
  return job.tradera?.status === "published" ? job.tradera.fraktSeparat === true : true;
}

/** Priset som står i Tradera-annonsen: möbeln, plus frakten bara på en annons av den gamla sorten. */
export function traderaAnnonspris(job: Pick<ConditionJob, "tradera">, itemPrice: number, shippingSek: number): number {
  return traderaFraktSeparat(job) ? Math.round(itemPrice) : prisMedHemleverans(itemPrice, shippingSek);
}

/**
 * Ska den här Tradera-annonsen läggas om för att få frakten i kassan? Engångsombytet 2026-11-19 av
 * annonserna som låg ute när det nya sättet kom. Styrs av TRADERA_FRAKTBYTE:
 *
 *   osatt / "0"         av
 *   "alla"              varje publicerad Tradera-annons av den gamla sorten
 *   "993b08eb,35d112ba" bara de jobb vars id börjar så — för att pröva på en annons först
 *
 * ALDRIG en annons där reserven redan fått ta över (`fraktReserv`): Tradera nekade då fraktkostnaden,
 * och ett nytt ombyte hade lagt om samma annons var femtonde minut i evighet.
 */
export function traderaFraktbyteVantar(job: Pick<ConditionJob, "id" | "tradera">): boolean {
  const v = process.env.TRADERA_FRAKTBYTE?.trim();
  if (!v || v === "0") return false;
  const tr = job.tradera;
  if (tr?.status !== "published" || !tr.itemId || tr.fraktSeparat === true || tr.fraktReserv) return false;
  if (v === "alla") return true;
  return v.split(",").some((p) => p.trim().length >= 4 && job.id.startsWith(p.trim()));
}

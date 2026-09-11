/**
 * Hemleveransen — ett fast belopp OVANPÅ möbelns pris.
 *
 * LÅG I integrations/tradera/ och flyttade hit när Blocket blev en andra kanal. Leveransen är inte
 * Traderas: den är Loopas löfte till köparen, och den gäller oavsett var annonsen råkar ligga. Ett
 * belopp som bodde i en marknadsplats mapp men användes av två läste som att den ena kanalen lånade
 * den andras regel.
 *
 * Loopa kör hem möbeln efter köpet, och det kostar detsamma oavsett vilken möbel det är. Beloppet
 * läggs på annonspriset i stället för att skickas som `shippingCost` till Tradera: en fraktavgift i
 * Traderas kassa hade lagts på en andra gång, och köparen betalat 1 200 kr för en leverans som kostar
 * 600. Därför säger annonstexten att frakten ingår — den ingår i det pris som står.
 *
 * Konstant och inte miljövariabel med flit. Beloppet står i annonstexten, i priset köparen betalar
 * och i prisstegens räkning; att kunna ändra det utan att röra koden vore att kunna ändra vad
 * annonsen lovar utan att ett enda test går sönder.
 */
export const SHIPPING_INCLUDED_SEK = 600;

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
 */
export function prisMedHemleverans(itemPrice: number): number {
  return Math.round(itemPrice) + SHIPPING_INCLUDED_SEK;
}

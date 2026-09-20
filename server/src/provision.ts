/**
 * Loopas provision — DEN ENDA PLATSEN SOM RÄKNAR DEN.
 *
 * Utbetalningen (butik/utbetalning.ts), bekräftelsen i "Sälj med Loopa" (via traderaState i server.ts)
 * och utbetalningsbrevet läser alla härifrån. Ingen av dem multiplicerar själv med en andel. Kommer
 * Stripe Connect en dag ska `application_fee_amount` vara `loopaAndel(...) * 100` och ingenting annat
 * — Stripes egen avgift är en annan sak och påverkas inte av det här.
 *
 * Andelen står på FÖRSÄLJNINGEN, inte här. Här står bara förvalet (20 %) och taket (1 000 kr). En
 * möbel som säljs med en gratisförsäljning bär andelen 0 på sina villkor (`SaleTerms` på jobbet), och
 * då blir Loopas del noll kronor oavsett pris — taket spelar ingen roll när det inte finns något att
 * ta tak på.
 *
 * Talen finns också i web/src/lib/fees.ts, för startsidans och förklaringarnas exempel. Klienten kan
 * inte importera härifrån (web/ och server/ installeras var för sig i drift), så testet
 * tests/referral.test.ts håller de två paren lika. Pengar som faktiskt rör sig räknas bara här.
 */

/** Förvalet. Varje försäljning utan gratisförsäljning bär den här andelen. */
export const STANDARD_ANDEL = 0.2;

/**
 * TAKET, i kronor. Andelen slutar växa här — se web/src/lib/fees.ts för varför taket finns.
 */
export const TAK_SEK = 1000;

/** Gratisförsäljningens andel. Namngiven så att ingen skriver `0` på ett ställe och `0.0` på ett annat. */
export const GRATIS_ANDEL = 0;

export interface Uppdelning {
  /** Möbelns pris — aldrig annonspriset med frakt. Frakten går till budfirman och är inte vår affär. */
  mobelprisSek: number;
  /** Andelen som gällde. 0,2 eller 0. */
  andel: number;
  loopaSek: number;
  saljarenSek: number;
  /** Sant när taket slog till, alltså när Loopas del är lägre än andelen hade gett. */
  tak: boolean;
}

/**
 * Vad Loopa tar och vad säljaren får, i hela kronor.
 *
 * Säljarens del räknas som RESTEN och inte som `pris × (1 − andel)`: två separata avrundningar kan
 * tillsammans hamna en krona ifrån priset, och en utbetalning vars delar inte summerar till priset är
 * ett bokföringsfel.
 */
export function uppdelning(mobelprisSek: number, andel: number = STANDARD_ANDEL): Uppdelning {
  if (!Number.isFinite(mobelprisSek) || mobelprisSek < 0) throw new RangeError(`Ogiltigt möbelpris: ${mobelprisSek}`);
  if (!Number.isFinite(andel) || andel < 0 || andel > 1) throw new RangeError(`Ogiltig andel: ${andel}`);
  const pris = Math.round(mobelprisSek);
  const rå = Math.round(pris * andel);
  const loopaSek = Math.min(rå, TAK_SEK);
  return { mobelprisSek: pris, andel, loopaSek, saljarenSek: pris - loopaSek, tak: rå > TAK_SEK };
}

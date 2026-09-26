/**
 * Sökfrågorna upptäckten går igenom. Roboten söker på riktiga Facebook — inga gruppadresser hittas på
 * här, bara vad som skrivs i sökrutan.
 *
 * Ordningen är prioriteten: möbelspecifikt först, sedan allmänna köp/sälj, secondhand, märken, och
 * sist stadsdelarna. Ett upptäcktsvarv tar `discoveryQueriesPerRun` frågor i taget och fortsätter
 * där det slutade nästa varv, så hela listan gås igenom över några dagar utan att en enda körning
 * söker på sextio saker i rad.
 */

import { STOCKHOLM_PLACES } from "./ranking.js";

const FURNITURE = [
  "möbler Stockholm",
  "sälja möbler Stockholm",
  "köp sälj möbler Stockholm",
  "begagnade möbler Stockholm",
  "möbler bortskänkes Stockholm",
  "möbler säljes Stockholm",
  "inredning köp sälj Stockholm",
  "soffa säljes Stockholm",
];

const BUY_SELL = [
  "köp sälj Stockholm",
  "köpes säljes Stockholm",
  "köp byt sälj Stockholm",
  "bortskänkes Stockholm",
  "säljes köpes bortskänkes Stockholm",
];

const SECONDHAND = ["secondhand Stockholm", "second hand Stockholm", "vintage Stockholm", "loppis Stockholm", "återbruk Stockholm", "retro möbler Stockholm"];

const BRANDS = [
  "IKEA möbler köp sälj",
  "IKEA begagnat Stockholm",
  "Sweef köp sälj",
  "Sweef begagnad",
  "HAY möbler begagnat",
  "String hylla begagnad",
  "Svenskt Tenn begagnat",
  "designmöbler begagnat Stockholm",
];

/** Stadsdelarna och kommunerna, som "köp sälj <plats>". Stockholm självt är redan täckt ovan. */
const LOCAL = STOCKHOLM_PLACES.filter((p) => !/^(Stockholm|Sthlm|Stockholms län|Storstockholm|Innerstan)$/.test(p)).map((p) => `köp sälj ${p}`);

export const DISCOVERY_QUERIES: readonly string[] = [...FURNITURE, ...BUY_SELL, ...SECONDHAND, ...BRANDS, ...LOCAL];

/** Nästa `count` frågor från `cursor`, med varv runt listans slut. */
export function nextQueries(cursor: number, count: number): { queries: string[]; nextCursor: number } {
  const n = DISCOVERY_QUERIES.length;
  if (n === 0 || count <= 0) return { queries: [], nextCursor: cursor };
  const start = ((cursor % n) + n) % n;
  const queries: string[] = [];
  for (let i = 0; i < Math.min(count, n); i++) queries.push(DISCOVERY_QUERIES[(start + i) % n]);
  return { queries, nextCursor: (start + queries.length) % n };
}

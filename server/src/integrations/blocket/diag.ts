/**
 * Steglogg för en Blocket-körning.
 *
 * Egen liten sak och inte console.log: en publicering som gick fel går bara att förstå i efterhand,
 * och robotens väg genom någon annans formulär syns inte någonstans annars. De sju buggarna i
 * railway-proxy v40 hittades alla genom att läsa en sådan här lista.
 */

import type { BlocketStep } from "../../types.js";

/** Så många steg sparas på jobbet. Äldre faller bort — det är slutet man felsöker. */
export const MAX_STEPS = 60;

export type Logga = (name: string, status: BlocketStep["status"], details?: Record<string, unknown>) => void;

/** En logg som inte skriver någonstans. För hjälpare som anropas utanför en körning. */
export const tystLogg: Logga = () => {};

export function nyttSteg(name: string, status: BlocketStep["status"], details?: Record<string, unknown>): BlocketStep {
  return { name, status, at: new Date().toISOString(), ...(details ? { details } : {}) };
}

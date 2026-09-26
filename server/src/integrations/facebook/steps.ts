/**
 * Steglogg för en Facebook-körning. Samma idé som blocket/diag.ts: robotens väg genom någon annans
 * sidor syns ingenstans annars, och en körning som gick fel går bara att förstå i efterhand.
 */

import type { PublicationStep } from "./types.js";

/** Så många steg sparas på en publicering. Äldre faller bort — det är slutet man felsöker. */
export const MAX_STEPS = 80;

export type Logga = (name: string, status: PublicationStep["status"], details?: Record<string, unknown>) => void;

export function nyttSteg(name: string, status: PublicationStep["status"], details?: Record<string, unknown>): PublicationStep {
  return { name, status, at: new Date().toISOString(), ...(details ? { details } : {}) };
}

/** En samlande logg: stegen i minnet, konsolen för den som tittar, och en valfri skrivning vid varje steg. */
export function stegLogg(prefix: string, skriv?: (steps: PublicationStep[]) => Promise<void>): { logga: Logga; steps: PublicationStep[]; flush: () => Promise<void> } {
  const steps: PublicationStep[] = [];
  let writing: Promise<void> = Promise.resolve();
  const logga: Logga = (name, status, details) => {
    steps.push(nyttSteg(name, status, details));
    if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS);
    console.info(`[facebook:${prefix}] ${status.toUpperCase()} ${name}`);
    if (skriv) writing = writing.then(() => skriv([...steps])).catch(() => undefined);
  };
  return { logga, steps, flush: () => writing.catch(() => undefined) };
}

export const tystLogg: Logga = () => {};

export function felText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Städningen som släpper utgångna reservationer.
 *
 * Byggd som prisstegens schemaläggare (priceLadder.ts): ett intervall i samma process, inte en
 * cron-rad utanför. Möbeln hålls i ett kvart medan någon står i kassan; stänger de fliken finns
 * ingen som kommer tillbaka för att släppa den, och utan den här snurran är möbeln borta ur butiken
 * för alltid trots att den aldrig såldes.
 */

import { sweepExpiredReservations } from "./store.js";
import { invalidate } from "./inventory.js";

const INTERVAL_MS = Number(process.env.BUTIK_SWEEP_INTERVAL_MS ?? 60_000);

let timer: NodeJS.Timeout | null = null;

export function startButikSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepExpiredReservations()
      .then((n) => {
        if (n > 0) {
          console.info(`[butik] ${n} utgångna reservationer släpptes`);
          invalidate();
        }
      })
      .catch((err) => console.warn("[butik] städningen föll:", err instanceof Error ? err.message : err));
  }, INTERVAL_MS);
  // Snurran ska inte hålla processen vid liv i tester och skript.
  timer.unref?.();
}

export function stopButikSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

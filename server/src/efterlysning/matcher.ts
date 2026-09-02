/**
 * Den löpande matchningen: sveparen som håller bevakningarna vid liv.
 *
 * STRIKT HÄR, GENERÖST I DIREKTSVEPET. Den som får ett brev ska kunna lita på att möbeln faktiskt
 * uppfyller det de bad om — annars blir varje brev något man måste kontrollera, och då är det inte
 * värt att öppna. Nära-träffarna finns kvar; de visas när köparen själv tittar, och samlas i
 * veckans brev.
 *
 * TAKTEN ÄR LÅNGSAM MED FLIT. Varje varv kostar ett Tradera-anrop per efterlysning, och Traderas API
 * har ett anropstak. En timme mellan varven är tätare än marknaden rör sig och glest nog att aldrig
 * bli det som stryper oss.
 */

import { sweep } from "./sweep.js";
import * as store from "./store.js";
import { mayNotify, notifyMatches } from "./notify.js";
import { expireOverdue, runDeadlineValve, runPulse, runRenewalReminders } from "./pulse.js";
import type { Candidate } from "./match.js";

const SWEEP_INTERVAL_MS = Number(process.env.EFTERLYSNING_SWEEP_MS ?? 3600_000);
/** Livscykelbreven prövas var sjätte timme; de skickar sig själva bara när det är dags. */
const LIFECYCLE_INTERVAL_MS = Number(process.env.EFTERLYSNING_LIFECYCLE_MS ?? 6 * 3600_000);

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let lifecycleTimer: ReturnType<typeof setInterval> | null = null;

export interface RoundResult {
  swept: number;
  notified: number;
}

/**
 * Ett varv över alla aktiva efterlysningar.
 *
 * SEKVENTIELLT. Tjugo parallella Tradera-anrop är ett bra sätt att bli avstängd, och den här slingan
 * har ingen brådska: ingen väntar på svaret medan den kör.
 */
export async function runRound(): Promise<RoundResult> {
  const open = (await store.open()).filter((e) => e.userId);
  let notified = 0;

  for (const e of open) {
    try {
      // Strikt: bara det som uppfyller HELA specen får väcka någon.
      const result = await sweep(e, { generous: false });
      const fresh = result.candidates.filter((c) => !e.notifiedProductIds.includes(c.product.id));
      if (fresh.length === 0) continue;

      /**
       * Källorna delas upp, för de har olika takt.
       *
       * Vårt eget kan säljas i natt och förtjänar ett besked nu. Traderas utbud rör sig hela tiden
       * och skulle ge ett brev i timmen — det samlas därför till högst ett per dygn (mayNotify).
       */
      const ours = fresh.filter((c) => c.source !== "tradera");
      const theirs = fresh.filter((c) => c.source === "tradera");

      const toSend: Candidate[] = [...ours];
      if (theirs.length && (await mayNotify(e, "tradera"))) toSend.push(...theirs);
      if (toSend.length === 0) continue;

      // Läs om raden: markNotified i ett tidigare varv kan ha ändrat den.
      const current = (await store.get(e.id)) ?? e;
      if (await notifyMatches(current, toSend)) notified += 1;
    } catch (err) {
      // En efterlysning som faller får inte ta med sig resten av kön.
      console.warn(`[efterlysning] varvet föll för ${e.id.slice(0, 8)}:`, err instanceof Error ? err.message : err);
    }
  }
  return { swept: open.length, notified };
}

/** Livscykelbreven, i den ordning som gör att en somnad inte får en påminnelse. */
export async function runLifecycle(): Promise<{ expired: number; pulse: number; deadline: number; renewal: number }> {
  const expired = await expireOverdue();
  const renewal = await runRenewalReminders();
  const deadline = await runDeadlineValve();
  const pulse = await runPulse();
  return { expired, pulse: pulse.sent, deadline: deadline.sent, renewal: renewal.sent };
}

export function startEfterlysningSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void runRound().then((r) => {
      if (r.notified) console.info(`[efterlysning] ${r.notified} notiser ur ${r.swept} bevakningar`);
    }).catch((err) => console.warn("[efterlysning] varvet föll:", err));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  lifecycleTimer = setInterval(() => {
    void runLifecycle().then((r) => {
      const total = r.pulse + r.deadline + r.renewal;
      if (total) console.info(`[efterlysning] livscykel: ${r.pulse} puls, ${r.deadline} deadline, ${r.renewal} förnyelse, ${r.expired} somnade`);
    }).catch((err) => console.warn("[efterlysning] livscykeln föll:", err));
  }, LIFECYCLE_INTERVAL_MS);
  lifecycleTimer.unref?.();
}

export function stopEfterlysningSweeper(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (lifecycleTimer) { clearInterval(lifecycleTimer); lifecycleTimer = null; }
}

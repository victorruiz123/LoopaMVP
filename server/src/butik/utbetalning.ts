/**
 * Utbetalningen till säljaren: vad som betalas ut, att det betalats, och vad som händer sedan.
 *
 * PENGARNA RÖR SIG FÖR HAND. Butikens kassa är en Stripe Checkout på plattformskontot, utan Connect,
 * och säljaren får sina pengar via Swish eller banköverföring (se saljChat.ts). Det här är alltså
 * inte en överföring — det är uträkningen av den, och kvittot på att den gjorts. Admin betalar ut och
 * trycker "Markera utbetald"; då fryses beloppen på möbeln, och först DÅ räknas försäljningen som
 * utbetald.
 *
 * PROVISIONEN RÄKNAS I provision.ts, med andelen från möbelns villkor (ConditionJob.saleTerms).
 * Ingen rad här multiplicerar med ett tal.
 *
 * Inbjudningarna belönas INTE här längre, utan när den inbjudna lägger upp sin första annons (se
 * referral/regler.ts). Utbetalningsbrevet bär fortfarande inbjudan: den som just fått pengar är den
 * som bäst kan berätta för en vän att det fungerar.
 */

import { randomUUID } from "node:crypto";
import { getJob, ownerIdOf } from "../jobStore.js";
import { STANDARD_ANDEL, uppdelning, type Uppdelning } from "../provision.js";
import { profilFor } from "../referral/regler.js";
import { inbjudningslank } from "../referral/kod.js";
import { ordersForProduct } from "./orders.js";
import { priceOf } from "./normalize.js";
import { store, type ButikRecord, type Utbetalning } from "./store.js";
import type { ConditionJob } from "../types.js";

export class UtbetalningFel extends Error {}

/** Andelen som gäller för möbeln. Möbler från före villkoren bär förvalet. */
export function andelFor(job: Pick<ConditionJob, "saleTerms"> | null | undefined): number {
  return job?.saleTerms?.commissionRate ?? STANDARD_ANDEL;
}

/**
 * Vad möbeln troligen såldes för, som förslag i panelen.
 *
 * Butiken vet: ordern bär priset som gällde i kassan, utan frakt. Tradera vet vi inte — en auktion
 * kan ha gått över utropet, och slutpriset står i mejlet från Tradera, inte hos oss. Där föreslås
 * annonsens möbelpris, och admin skriver in det riktiga.
 */
async function foreslagetPris(record: ButikRecord, job: ConditionJob | null): Promise<number | null> {
  if (record.soldChannel === "butik") {
    const order = (await ordersForProduct(record.id)).find((o) => o.status !== "pending" && o.status !== "cancelled");
    if (order) return order.priceSek;
  }
  return job ? priceOf(job) : null;
}

export interface UtbetalningsRad {
  productId: string;
  titel: string;
  kanal: ButikRecord["soldChannel"];
  state: ButikRecord["state"];
  soldAt: string | null;
  sellerEmail: string | null;
  /** Sant när möbeln publicerades med en gratisförsäljning. */
  gratis: boolean;
  /** Förslaget, uträknat. Null när priset är okänt och måste skrivas in. */
  forslag: Uppdelning | null;
  /** Kvittot, när den är utbetald. */
  utbetalning: Utbetalning | null;
}

async function radAv(record: ButikRecord): Promise<UtbetalningsRad> {
  const job = record.jobId ? ((await getJob(record.jobId)) ?? null) : null;
  const listing = job?.result?.listing ?? job?.listing ?? null;
  const andel = andelFor(job);
  const pris = await foreslagetPris(record, job);
  return {
    productId: record.id,
    titel: listing?.result?.listing.title ?? record.id,
    kanal: record.soldChannel,
    state: record.state,
    soldAt: record.soldAt,
    sellerEmail: job?.ownerEmail ?? null,
    gratis: andel === 0,
    forslag: pris !== null ? uppdelning(pris, andel) : null,
    utbetalning: record.utbetalning ?? null,
  };
}

/**
 * Sålda möbler: de som väntar på utbetalning först, äldst först; därefter de utbetalda, nyast först.
 * Returnerade möbler är inte med — pengarna gick tillbaka till köparen, och säljaren har inget att få.
 */
export async function listaUtbetalningar(): Promise<UtbetalningsRad[]> {
  const salda = (await store().all()).filter((r) => r.state === "sold" || r.state === "delivered");
  const rader = await Promise.all(salda.map(radAv));
  return rader.sort((a, b) => {
    if (!!a.utbetalning !== !!b.utbetalning) return a.utbetalning ? 1 : -1;
    return a.utbetalning
      ? b.utbetalning!.at.localeCompare(a.utbetalning.at)
      : (a.soldAt ?? "").localeCompare(b.soldAt ?? "");
  });
}

/**
 * Admin har betalat ut. Fryser beloppen och skriver till säljaren.
 *
 * `mobelprisSek` behövs för Tradera-försäljningar (se foreslagetPris) och får anges för butikens —
 * admin är den som vet vad som faktiskt kom in.
 */
export async function markeraUtbetald(
  productId: string,
  input: { mobelprisSek?: number | null },
  adminId: string | null,
): Promise<UtbetalningsRad> {
  const record = await store().get(productId);
  if (!record) throw new UtbetalningFel("Möbeln finns inte.");
  if (record.utbetalning) throw new UtbetalningFel("Möbeln är redan utbetald.");
  if (record.state !== "sold" && record.state !== "delivered") throw new UtbetalningFel("Möbeln är inte såld.");

  const job = record.jobId ? ((await getJob(record.jobId)) ?? null) : null;
  const angett = input.mobelprisSek;
  if (angett !== undefined && angett !== null && (!Number.isFinite(angett) || angett < 0)) {
    throw new UtbetalningFel("Möbelpriset ska vara ett belopp i kronor.");
  }
  const pris = angett ?? (await foreslagetPris(record, job));
  if (pris === null) throw new UtbetalningFel("Ange vad möbeln såldes för.");

  const delning = uppdelning(pris, andelFor(job));
  const utbetalning: Utbetalning = {
    at: new Date().toISOString(),
    mobelprisSek: delning.mobelprisSek,
    andel: delning.andel,
    loopaSek: delning.loopaSek,
    saljarenSek: delning.saljarenSek,
    referralCreditId: job?.saleTerms?.referralCreditId ?? null,
    av: adminId,
  };
  const updated = await store().markeraUtbetald(productId, utbetalning);
  if (!updated) throw new UtbetalningFel("Möbeln hann ändras — ladda om och försök igen.");

  // Huvudboken. Samma läge in som ut: utbetalningen är ingen tillståndsövergång, men den hör hemma
  // bland det som hänt möbeln.
  await store()
    .appendEvent({
      id: randomUUID(),
      productId,
      from: updated.state,
      to: updated.state,
      at: utbetalning.at,
      actor: { kind: "admin", userId: adminId },
      note: `Utbetald: ${delning.saljarenSek} kr till säljaren, ${delning.loopaSek} kr till Loopa (andel ${delning.andel}).`,
    })
    .catch(() => undefined);

  const saljarId = job ? ownerIdOf(job) : null;
  // Brevet får aldrig fälla utbetalningen — den är gjord, och kvittot står.
  if (saljarId && job?.ownerEmail) void skrivTillSaljaren(job, saljarId, updated, delning);

  return radAv(updated);
}

/**
 * Utbetalningsbrevet. Det är också platsen där inbjudan görs: den som just fått pengar för en möbel
 * är den som bäst kan berätta för en vän att det fungerar.
 */
async function skrivTillSaljaren(job: ConditionJob, saljarId: string, record: ButikRecord, d: Uppdelning): Promise<void> {
  try {
    const { sendLetter } = await import("../efterlysning/notify.js");
    const profil = await profilFor({ id: saljarId, email: job.ownerEmail ?? null, createdAt: null, adress: null, telefon: null });
    const titel = job.result?.listing?.result?.listing.title ?? job.listing?.result?.listing.title ?? "Din möbel";
    const body = [
      "Hej!",
      "",
      `${titel} är såld, och vi har betalat ut ${d.saljarenSek} kr till dig.`,
      "",
      `Möbelns pris: ${d.mobelprisSek} kr`,
      d.andel === 0 ? "Loopas del: 0 kr – gratisförsäljning" : `Loopas del: ${d.loopaSek} kr`,
      `Du får: ${d.saljarenSek} kr`,
      "",
      "Bjud in en vän – din nästa försäljning blir gratis.",
      inbjudningslank(profil.kod),
      "",
      "När din vän har lagt upp sin första annons tar vi ingen avgift på din nästa försäljning.",
      "",
      "Loopa AI",
    ].join("\n");
    await sendLetter({ to: job.ownerEmail!, subject: `Utbetalt: ${titel}`, body, kind: "utbetalning" });
  } catch (err) {
    console.warn(`[utbetalning] brevet om ${record.id} gick inte iväg:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Inbjudningarnas regler.
 *
 * REGELN, i en mening: den som bjuder in en ny säljare får EN försäljning utan Loopas provision, när
 * den inbjudnas första möbel är såld och utbetald.
 *
 * Tre ögonblick, och bara tre:
 *
 *   1. REGISTRERINGEN  (gorAnsprak)       referred_by skrivs, en gång. Ingen kredit.
 *   2. UTBETALNINGEN   (efterUtbetalning) den inbjudnas första möbel betalas ut → kredit till
 *                                         inbjudaren, om skydden släpper igenom den.
 *   3. PUBLICERINGEN   (anvandKredit)     inbjudaren trycker "Sälj med Loopa" på en ny möbel och väljer
 *                                         att använda krediten. Andelen på den möbeln blir 0.
 *
 * `efterUtbetalning` är det uppdraget kallade databastriggern. Den ligger här och inte i Postgres av
 * samma skäl som butikens övergångar gör: lagret kör på filer när servicenyckeln saknas, och en
 * regel som bara finns i ena ryggen är en regel som inte gäller i den andra. Den anropas från EN
 * plats — butik/utbetalning.ts, när admin markerat en möbel utbetald — och ingenting annat
 * (registrering, publicering, försäljning utan utbetalning) kan skapa en kredit.
 */

import { randomUUID } from "node:crypto";
import { normaliseraKod, nyKod } from "./kod.js";
import { adressNyckel, delarIdentitet, emailNyckel, maskeraEmail, telefonNyckel } from "./avtryck.js";
import { referralStore, type ReferralHandelseNamn, type ReferralKredit, type ReferralProfil } from "./store.js";

/** Hur länge en kredit gäller från att den skapats. */
export const KREDIT_GILTIG_MANADER = 12;
/** Fler tillgängliga krediter än så samlar ingen på sig. Den elfte inbjudna ger ingen kredit. */
export const MAX_TILLGANGLIGA = 10;
/**
 * Hur nytt ett konto måste vara för att en kod ska fästa.
 *
 * "Ignorera om användaren redan finns." Registreringen och anspråket är två anrop — kontot skapas hos
 * Supabase, bekräftas kanske via mejl, och först vid första inloggningen skickar klienten koden. En
 * vecka rymmer ett bekräftelsemejl som legat i skräpposten, men inte ett gammalt konto som klistrar
 * in en väns kod för att den råkar ligga i en länk.
 */
export const NYTT_KONTO_DAGAR = 7;

/** Det vi vet om kontot bakom en token. Se routes.ts, som hämtar det hos Supabase. */
export interface Konto {
  id: string;
  email: string | null;
  /** Kontots skapelsetid hos Supabase. Null = okänd, och då räknas kontot som befintligt. */
  createdAt: string | null;
  adress: { gatuadress?: unknown; postnummer?: unknown } | null;
  telefon: unknown;
}

const DAG_MS = 24 * 60 * 60 * 1000;

function plusManader(d: Date, manader: number): Date {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + manader);
  return x;
}

/** Huvudboken. Får aldrig fälla det den loggar — en händelse som inte skrevs är sämre än en som saknas. */
export async function logga(
  event: ReferralHandelseNamn,
  userId: string,
  kod: string | null,
  props: Record<string, string | number | boolean | null> = {},
  nu: Date = new Date(),
): Promise<void> {
  try {
    await referralStore().handelse({ id: randomUUID(), at: nu.toISOString(), event, userId, referralCode: kod, props });
  } catch (err) {
    console.warn(`[referral] händelsen ${event} kunde inte skrivas:`, err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Profilen och koden
// ---------------------------------------------------------------------------

/**
 * Kontots profil, skapad om den saknas och med avtrycken uppdaterade.
 *
 * KODEN SKAPAS FÖRSTA GÅNGEN DEN BEHÖVS, inte i Supabases registrering: den registreringen sker i
 * klienten mot ett projekt vi delar, och det finns ingen krok där vi kan skriva. För användaren är
 * skillnaden osynlig — den som öppnar sin profil eller får sitt utbetalningsbrev har en kod.
 *
 * Ett avtryck skrivs bara över med ett nytt värde, aldrig med null: ett anrop som råkade sakna adress
 * ska inte sudda ut den vi redan har.
 */
export async function profilFor(konto: Konto, nu: Date = new Date()): Promise<ReferralProfil> {
  const store = referralStore();
  const avtryck = {
    emailNyckel: emailNyckel(konto.email),
    adressNyckel: adressNyckel(konto.adress),
    telefonNyckel: telefonNyckel(konto.telefon),
    emailMaskerad: maskeraEmail(konto.email),
  };

  const befintlig = await store.profil(konto.id);
  if (befintlig) {
    const patch: Partial<typeof avtryck> = {};
    for (const [k, v] of Object.entries(avtryck) as [keyof typeof avtryck, string | null][]) {
      if (v !== null && befintlig[k] !== v) patch[k] = v;
    }
    if (Object.keys(patch).length === 0) return befintlig;
    await store.uppdateraProfil(konto.id, patch);
    return { ...befintlig, ...patch };
  }

  // Koden kan krocka med en befintlig. Chansen är försumbar, men att försöka igen kostar ingenting.
  for (let forsok = 0; forsok < 5; forsok++) {
    const ny: ReferralProfil = {
      userId: konto.id,
      kod: nyKod(),
      referredBy: null,
      referredAt: null,
      forstaUtbetalningAt: null,
      stripeKonto: null,
      ...avtryck,
      createdAt: nu.toISOString(),
      updatedAt: nu.toISOString(),
    };
    const skapad = await store.skapaProfil(ny);
    if (skapad) return skapad;
    // Två anrop för samma konto samtidigt: det andra förlorade, och profilen finns nu.
    const hann = await store.profil(konto.id);
    if (hann) return hann;
  }
  throw new Error("Kunde inte skapa en unik inbjudningskod.");
}

// ---------------------------------------------------------------------------
// 1. Registreringen
// ---------------------------------------------------------------------------

export type AnsprakUtfall = "ok" | "ogiltig_kod" | "egen_kod" | "redan_inbjuden" | "befintligt_konto";

/**
 * Den nya användaren kom via en länk. Skriver referred_by, om allt stämmer.
 *
 * Tyst åt alla håll: utfallet går tillbaka till klienten, som tömmer sin sparade kod oavsett. Ingen
 * av de nekade vägarna är något användaren behöver läsa om — en ogiltig kod är en trasig länk, inte
 * ett fel de gjort.
 */
export async function gorAnsprak(konto: Konto, rawKod: unknown, nu: Date = new Date()): Promise<AnsprakUtfall> {
  const kod = normaliseraKod(rawKod);
  if (!kod) return "ogiltig_kod";
  const store = referralStore();
  const inbjudare = await store.profilForKod(kod);
  if (!inbjudare) return "ogiltig_kod";
  if (inbjudare.userId === konto.id) return "egen_kod";

  const skapat = konto.createdAt ? new Date(konto.createdAt).getTime() : NaN;
  if (!Number.isFinite(skapat) || nu.getTime() - skapat > NYTT_KONTO_DAGAR * DAG_MS) return "befintligt_konto";

  const profil = await profilFor(konto, nu);
  if (profil.referredBy !== null) return "redan_inbjuden";
  // Villkorat i lagret: två flikar som skickar samma kod samtidigt skriver fältet en gång.
  if (!(await store.sattReferredBy(konto.id, inbjudare.userId, nu.toISOString()))) return "redan_inbjuden";

  await logga("referred_signup", konto.id, kod, { referrer_id: inbjudare.userId }, nu);
  return "ok";
}

// ---------------------------------------------------------------------------
// Krediterna
// ---------------------------------------------------------------------------

/**
 * Alla kontots krediter, med utgångna markerade som `expired`.
 *
 * UTGÅNGEN SKRIVS VID LÄSNING och inte av en klocka. Resultatet är detsamma — ingen kan använda en
 * utgången kredit, eftersom varje användning går genom den här funktionen — och det finns ett jobb
 * mindre som kan stå still.
 */
export async function krediterFor(userId: string, nu: Date = new Date()): Promise<ReferralKredit[]> {
  const store = referralStore();
  const alla = await store.krediter(userId);
  for (const k of alla) {
    if (k.status === "available" && new Date(k.expiresAt).getTime() <= nu.getTime()) {
      if (await store.bytStatus(k.id, "available", "expired")) k.status = "expired";
    }
  }
  return alla.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

export function tillgangliga(krediter: ReferralKredit[], nu: Date = new Date()): ReferralKredit[] {
  return krediter.filter((k) => k.status === "available" && new Date(k.expiresAt).getTime() > nu.getTime());
}

// ---------------------------------------------------------------------------
// 2. Utbetalningen — "triggern"
// ---------------------------------------------------------------------------

export type TriggerUtfall =
  | "kredit"
  | "ingen_inbjudare"
  | "inte_forsta"
  | "redan_kredit"
  | "okand_inbjudare"
  | "delar_identitet"
  | "tak";

/**
 * En möbel har betalats ut. Var det säljarens första, och kom säljaren via en inbjudan, får
 * inbjudaren en kredit.
 *
 * `tidigareUtbetalda` är hur många ANDRA möbler säljaren redan fått utbetalt för. Den som anropar
 * räknar det (butiken vet vilka möbler som är utbetalda; inbjudningarna vet inte). Noll betyder att
 * det här är den första.
 *
 * Skydden, i ordning:
 *   - bara första utbetalningen räknas, och en inbjuden person ger högst en kredit någonsin — det
 *     senare garanteras av lagret (unik referred_user_id), inte bara av kontrollen här
 *   - inbjudare och inbjuden får inte dela e-post, adress, telefon eller Stripe-konto (avtryck.ts)
 *   - inbjudaren får inte redan ha MAX_TILLGANGLIGA oanvända krediter
 *
 * En nekad kredit skrivs i huvudboken med orsaken. Den är inte ett fel, och den försöks inte igen:
 * en senare utbetalning är inte den första.
 */
export async function efterUtbetalning(input: {
  saljarId: string;
  saleId: string;
  tidigareUtbetalda: number;
  nu?: Date;
}): Promise<{ utfall: TriggerUtfall; kredit: ReferralKredit | null }> {
  const nu = input.nu ?? new Date();
  const store = referralStore();
  const profil = await store.profil(input.saljarId);
  if (!profil?.referredBy) return { utfall: "ingen_inbjudare", kredit: null };
  if (input.tidigareUtbetalda > 0) return { utfall: "inte_forsta", kredit: null };

  // "Sålt" i inbjudarens lista — oavsett hur det går med krediten nedan.
  if (!profil.forstaUtbetalningAt) await store.uppdateraProfil(profil.userId, { forstaUtbetalningAt: nu.toISOString() });

  if (await store.kreditForInbjuden(profil.userId)) return { utfall: "redan_kredit", kredit: null };

  const inbjudare = await store.profil(profil.referredBy);
  if (!inbjudare) return { utfall: "okand_inbjudare", kredit: null };

  const neka = async (utfall: TriggerUtfall, orsak: string) => {
    await logga("referral_credit_denied", inbjudare.userId, inbjudare.kod, { referred_user_id: profil.userId, sale_id: input.saleId, orsak }, nu);
    return { utfall, kredit: null };
  };

  const delad = delarIdentitet(inbjudare, profil);
  if (delad) return neka("delar_identitet", delad);

  if (tillgangliga(await krediterFor(inbjudare.userId, nu), nu).length >= MAX_TILLGANGLIGA) {
    return neka("tak", `max_${MAX_TILLGANGLIGA}_tillgangliga`);
  }

  const kredit: ReferralKredit = {
    id: randomUUID(),
    userId: inbjudare.userId,
    referredUserId: profil.userId,
    status: "available",
    usedOnSaleId: null,
    usedAt: null,
    createdAt: nu.toISOString(),
    expiresAt: plusManader(nu, KREDIT_GILTIG_MANADER).toISOString(),
  };
  if (!(await store.skapaKredit(kredit))) return { utfall: "redan_kredit", kredit: null };

  await logga("referral_credit_created", inbjudare.userId, inbjudare.kod, { referred_user_id: profil.userId, sale_id: input.saleId, credit_id: kredit.id }, nu);
  return { utfall: "kredit", kredit };
}

// ---------------------------------------------------------------------------
// 3. Publiceringen
// ---------------------------------------------------------------------------

/**
 * Använder en av säljarens krediter på en möbel som publiceras nu. Null när ingen finns.
 *
 * Den som går ut först används först — en kredit som snart förfaller är den som annars går förlorad.
 * Bytet till `used` är villkorat, så två publiceringar samtidigt kan inte dela på samma kredit; den
 * som förlorar provar nästa.
 *
 * ALDRIG RETROAKTIVT. Anropas bara ur "Sälj med Loopa", innan möbeln har några villkor. En möbel
 * som redan har villkor (se ConditionJob.saleTerms) får aldrig nya — det kontrolleras av anroparen,
 * och villkoren skrivs en gång.
 */
export async function anvandKredit(userId: string, saleId: string, nu: Date = new Date()): Promise<ReferralKredit | null> {
  const store = referralStore();
  for (const k of tillgangliga(await krediterFor(userId, nu), nu)) {
    if (await store.bytStatus(k.id, "available", "used", { usedOnSaleId: saleId, usedAt: nu.toISOString() })) {
      const profil = await store.profil(userId);
      await logga("referral_credit_used", userId, profil?.kod ?? null, { credit_id: k.id, sale_id: saleId }, nu);
      return { ...k, status: "used", usedOnSaleId: saleId, usedAt: nu.toISOString() };
    }
  }
  return null;
}

/**
 * Lämnar tillbaka en kredit som togs i SAMMA anrop som sedan föll.
 *
 * Bara för det fallet: publiceringen kunde inte ställas i kö efter att krediten tagits. En kredit som
 * väl hör till en möbel i kö följer möbeln — se ConditionJob.saleTerms.
 */
export async function lamnaTillbakaKredit(kreditId: string): Promise<void> {
  await referralStore().bytStatus(kreditId, "used", "available", { usedOnSaleId: null, usedAt: null });
}

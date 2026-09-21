/**
 * Inbjudningarnas regler.
 *
 * REGELN, i en mening: den som bjuder in någon får EN försäljning utan Loopas provision, när den
 * inbjudna lägger upp sin första annons efter inbjudan.
 *
 * Tre ögonblick, och bara tre:
 *
 *   1. ANSPRÅKET       (gorAnsprak)        den inbjudna loggar in efter att ha öppnat länken →
 *                                          referred_by skrivs, en gång. Ingen kredit.
 *   2. VÄNNENS ANNONS  (efterForstaAnnons) den inbjudna trycker "Sälj med Loopa" → kredit till
 *                                          inbjudaren, om skydden släpper igenom den.
 *   3. PUBLICERINGEN   (anvandKredit)      inbjudaren trycker "Sälj med Loopa" på en egen möbel och
 *                                          väljer att använda krediten. Andelen på den möbeln blir 0.
 *
 * Regeln var först "när vännens första möbel är såld och utbetald". Den ändrades 2026-09-19 till
 * annonsen: belöningen ska komma medan inbjudan fortfarande känns, inte veckor senare. Skyddet mot
 * påhittade konton vilar därför på avtrycken (avtryck.ts), taket och en kredit per inbjuden.
 *
 * `efterForstaAnnons` är det uppdraget kallade databastriggern. Den ligger här och inte i Postgres av
 * samma skäl som butikens övergångar gör: lagret kör på filer när servicenyckeln saknas, och en
 * regel som bara finns i ena ryggen är en regel som inte gäller i den andra. Den anropas från EN
 * plats — "Sälj med Loopa" i server.ts, när annonsen väl står i kö.
 */

import { randomUUID } from "node:crypto";
import { normaliseraKod, nyKod } from "./kod.js";
import { adressNyckel, delarIdentitet, emailNyckel, fornamn, maskeraEmail, telefonNyckel } from "./avtryck.js";
import { referralStore, type ReferralHandelseNamn, type ReferralKredit, type ReferralProfil } from "./store.js";

/** Hur länge en kredit gäller från att den skapats. */
export const KREDIT_GILTIG_MANADER = 12;
/** Fler tillgängliga krediter än så samlar ingen på sig. Den elfte inbjudna ger ingen kredit. */
export const MAX_TILLGANGLIGA = 10;

/** Det vi vet om kontot bakom en token. Se routes.ts, som hämtar det hos Supabase. */
export interface Konto {
  id: string;
  email: string | null;
  /** Kontots skapelsetid hos Supabase. Läses inte av reglerna längre — befintliga konton går bra. */
  createdAt: string | null;
  adress: { gatuadress?: unknown; postnummer?: unknown } | null;
  telefon: unknown;
  /** Profilens fullständiga namn, när det finns. Se avtryck.ts, fornamn. */
  fullName?: string | null;
}

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
    namn: fornamn(konto.fullName, konto.email),
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
      forstaAnnonsAt: null,
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

export type AnsprakUtfall = "ok" | "ogiltig_kod" | "egen_kod" | "redan_inbjuden" | "har_salt";

/**
 * Användaren kom via en länk. Skriver referred_by, om allt stämmer.
 *
 * BEFINTLIGA KONTON GÅR BRA, så länge de aldrig sålt något. Den som skapade ett konto förra året men
 * aldrig kom igång är precis den en vän kan få över tröskeln. Den som redan säljer genom oss är inte
 * en ny säljare, och en inbjudan till dem hade varit en rabatt utan motprestation.
 *
 * `harSalt` räknas av den som anropar (routes.ts) — butiken vet vad som sålts, inbjudningarna vet
 * det inte.
 *
 * Tyst åt alla håll: utfallet går tillbaka till klienten, som tömmer sin sparade kod oavsett. Ett
 * nekat anspråk skrivs ändå i serverloggen, så att "inbjudan fäste inte" går att förklara.
 */
export async function gorAnsprak(konto: Konto, rawKod: unknown, harSalt: boolean, nu: Date = new Date()): Promise<AnsprakUtfall> {
  const utfall = await provaAnsprak(konto, rawKod, harSalt, nu);
  if (utfall !== "ok") console.info(`[referral] anspråk från ${konto.id} med "${String(rawKod).slice(0, 12)}" nekades: ${utfall}`);
  return utfall;
}

async function provaAnsprak(konto: Konto, rawKod: unknown, harSalt: boolean, nu: Date): Promise<AnsprakUtfall> {
  const kod = normaliseraKod(rawKod);
  if (!kod) return "ogiltig_kod";
  const store = referralStore();
  const inbjudare = await store.profilForKod(kod);
  if (!inbjudare) return "ogiltig_kod";
  if (inbjudare.userId === konto.id) return "egen_kod";
  if (harSalt) return "har_salt";

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
  | "redan_kredit"
  | "okand_inbjudare"
  | "delar_identitet"
  | "tak";

/**
 * Säljaren har lagt upp en annons. Kom säljaren via en inbjudan, och har inbjudan inte redan gett
 * något, får inbjudaren en kredit.
 *
 * "Första annonsen" behöver inte räknas: en inbjuden ger högst en kredit någonsin (lagret garanterar
 * det med unik referred_user_id), så den första annonsen efter inbjudan är den enda som kan ge en.
 * En nekad kredit (skydden nedan) kan prövas igen vid nästa annons — utfallet blir detsamma för delad
 * identitet, men taket kan ha lättat.
 *
 * Skydden, i ordning:
 *   - en inbjuden person ger högst en kredit, någonsin
 *   - inbjudare och inbjuden får inte dela e-post, adress, telefon eller Stripe-konto (avtryck.ts)
 *   - inbjudaren får inte redan ha MAX_TILLGANGLIGA oanvända krediter
 *
 * En nekad kredit skrivs i huvudboken med orsaken. Den är inte ett fel.
 */
export async function efterForstaAnnons(input: {
  saljarId: string;
  saleId: string;
  nu?: Date;
}): Promise<{ utfall: TriggerUtfall; kredit: ReferralKredit | null }> {
  const nu = input.nu ?? new Date();
  const store = referralStore();
  const profil = await store.profil(input.saljarId);
  if (!profil?.referredBy) return { utfall: "ingen_inbjudare", kredit: null };

  // "Har lagt upp en annons" i inbjudarens lista — oavsett hur det går med krediten nedan.
  if (!profil.forstaAnnonsAt) await store.uppdateraProfil(profil.userId, { forstaAnnonsAt: nu.toISOString() });

  if (await store.kreditForInbjuden(profil.userId)) return { utfall: "redan_kredit", kredit: null };

  const inbjudare = await store.profil(profil.referredBy);
  if (!inbjudare) return { utfall: "okand_inbjudare", kredit: null };

  const neka = async (utfall: TriggerUtfall, orsak: string) => {
    await logga("referral_credit_denied", inbjudare.userId, inbjudare.kod, { referred_user_id: profil.userId, sale_id: input.saleId, orsak }, nu);
    return { utfall, kredit: null };
  };

  const delad = delarIdentitet(inbjudare, profil);
  if (delad) return neka("delar_identitet", delad);

  /**
   * SAMMA PERSON EN GÅNG TILL, under ett nytt konto.
   *
   * Skyddet ovan jämför inbjudaren mot den inbjudna, och stoppar den som bjuder in sig själv. Men
   * det ser inte de inbjudna sinsemellan: fem konton med var sin e-postadress, alla med samma
   * telefon eller samma adress, gav fem krediter så länge ingen av dem delade uppgift med
   * inbjudaren. Regeln är en kredit per PERSON, inte en per konto — annars är inbjudan en knapp som
   * trycker fram gratis provisioner åt den som orkar skapa konton.
   *
   * Jämförs mot dem som faktiskt gett en kredit, inte mot alla som någonsin klickat: en nekad
   * inbjuden ska inte kunna blockera en riktig vän som råkar ha samma avtryck av något skäl vi inte
   * tänkt på. Listan är kort — taket ovan håller den under tio i praktiken.
   */
  for (const tidigare of await krediterFor(inbjudare.userId, nu)) {
    if (!tidigare.referredUserId || tidigare.referredUserId === profil.userId) continue;
    const syskon = await store.profil(tidigare.referredUserId);
    if (!syskon) continue;
    const samma = delarIdentitet(syskon, profil);
    if (samma) return neka("delar_identitet", `tidigare_inbjuden_${samma}`);
  }

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

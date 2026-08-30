/**
 * De juridiska sidorna, och adresserna de ligger på.
 *
 * Appen har ingen router — skärmen är ett fält i en useState (se App.tsx) — och de här tre sidorna
 * ska inte vara skälet att införa en. De läses ur adressen en gång vid start, precis som det publika
 * kortet, och länkarna till dem är vanliga <a> som öppnas i EN NY FLIK.
 *
 * Den nya fliken är inte en stilfråga. Länken till villkoren står bland annat på inloggningen mitt i
 * säljflödet, och där ligger säljarens filmade bildrutor i minnet — inte på servern än. En vanlig
 * navigering dit hade kastat bort varvet de just filmat för att de ville läsa vad de godkänner.
 */

export type LegalDoc = "privacy" | "cookies" | "terms";

const PATHS: Record<LegalDoc, string> = {
  privacy: "/integritetspolicy",
  cookies: "/cookies",
  terms: "/villkor",
};

export const LEGAL_TITLES: Record<LegalDoc, string> = {
  privacy: "Integritetspolicy",
  cookies: "Cookies och lagring",
  terms: "Användarvillkor",
};

/**
 * Datumet som står överst på alla tre.
 *
 * En policy utan datum går inte att veta om den beskriver dagens tjänst. Ändras något av det den
 * beskriver — en ny mottagare, en ny sorts uppgift — ska den här flyttas fram i samma ändring.
 */
export const LEGAL_UPDATED_ISO = "2026-08-29";

/** Datumet på läsarens språk: "29 augusti 2026", "29 August 2026", "29 août 2026". */
export function legalUpdated(lang: string): string {
  return new Date(LEGAL_UPDATED_ISO).toLocaleDateString(lang, { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Den personuppgiftsansvarige, på ett ställe.
 *
 * FYLL I firmanamn, organisationsnummer och postadress innan appen möter riktiga säljare. GDPR
 * artikel 13 kräver den ansvariges identitet och kontaktuppgifter, och en policy som utelämnar dem
 * uppfyller inte kravet oavsett hur bra resten är. Platshållarna står kvar som platshållare med
 * flit — ett påhittat organisationsnummer i en integritetspolicy vore värre än ett tomt fält.
 */
export const CONTROLLER = {
  name: "Loopa",
  legalName: "[FYLL I: registrerat firmanamn]",
  orgNumber: "[FYLL I: organisationsnummer]",
  address: "[FYLL I: postadress]",
  email: "info@loopa.nu",
} as const;

export function legalHref(doc: LegalDoc): string {
  return PATHS[doc];
}

/** Vilken juridisk sida adressen pekar på, eller null. Tål avslutande snedstreck. */
export function legalDocFromPath(pathname: string): LegalDoc | null {
  const clean = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const hit = (Object.keys(PATHS) as LegalDoc[]).find((doc) => PATHS[doc] === clean);
  return hit ?? null;
}

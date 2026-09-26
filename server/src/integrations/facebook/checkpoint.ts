/**
 * UPPTÄCKT av Facebooks säkerhetssidor — aldrig kringgående.
 *
 * När något av mönstren nedan träffar ska arbetaren STANNA och skriva NEEDS_MANUAL_ACTION med tid,
 * adress, skäl, skärmbild och sista genomförda steg. Ingenting här försöker lösa en CAPTCHA, klicka
 * sig igenom en kontrollpunkt eller dölja att det är en robot som kör.
 *
 * Ren funktion utan webbläsare, så att den går att pröva på text: det är mönstren som är farliga när
 * de missar, inte Chromium.
 */

import type { FacebookSessionStatus, InterruptKind } from "./types.js";

export interface InterruptDetection {
  kind: InterruptKind;
  reason: string;
}

const URL_PATTERNS: Array<{ re: RegExp; kind: InterruptKind; why: string }> = [
  { re: /\/checkpoint\//i, kind: "CHECKPOINT", why: "Adressen innehåller /checkpoint/" },
  { re: /\/login(\.php|\/|\?|$)/i, kind: "LOGIN_REQUIRED", why: "Omdirigerad till inloggningen" },
  { re: /\/recover\//i, kind: "CHECKPOINT", why: "Kontoåterställning" },
  { re: /\/confirmemail|\/confirm_code|\/verify/i, kind: "CHECKPOINT", why: "Verifieringsflöde" },
  { re: /\/captcha/i, kind: "CAPTCHA", why: "CAPTCHA-adress" },
];

const TEXT_PATTERNS: Array<{ re: RegExp; kind: InterruptKind; why: string }> = [
  { re: /confirm your identity|bekräfta din identitet|verifiera din identitet/i, kind: "CHECKPOINT", why: "Identitetsbekräftelse begärd" },
  {
    re: /security check|säkerhetskontroll|prove you'?re (a )?human|bevisa att du är en människa|enter the (text|characters) you see/i,
    kind: "CAPTCHA",
    why: "CAPTCHA / säkerhetskontroll visas",
  },
  { re: /temporarily blocked|tillfälligt blockerad|you'?re temporarily restricted|du är tillfälligt begränsad/i, kind: "RESTRICTED", why: "Tillfällig blockering" },
  {
    re: /you can'?t use this feature|du kan inte använda den här funktionen|this feature is (temporarily )?unavailable|funktionen är (tillfälligt )?otillgänglig/i,
    kind: "RESTRICTED",
    why: "Funktionen är begränsad",
  },
  { re: /suspicious activity|misstänkt aktivitet|unusual activity|ovanlig aktivitet/i, kind: "SUSPICIOUS_ACTIVITY", why: "Varning om misstänkt aktivitet" },
  {
    re: /your account has been (locked|disabled|suspended)|ditt konto har (låsts|inaktiverats|stängts av)|account restricted|kontot är begränsat/i,
    kind: "CHECKPOINT",
    why: "Kontot är låst eller begränsat",
  },
  { re: /log in to facebook|logga in på facebook|log into facebook|create new account.*forgot(ten)? password/i, kind: "LOGIN_REQUIRED", why: "Inloggningsformulär synligt" },
  { re: /we limit how often|vi begränsar hur ofta|you'?re going too fast|du går för fort fram|slow down/i, kind: "RESTRICTED", why: "Hastighetsgräns visas" },
  {
    re: /posting (is )?(temporarily )?restricted|du kan inte publicera just nu|you can'?t post (right now|at the moment)|marketplace.{0,40}(restricted|begränsad|inte tillgänglig)/i,
    kind: "RESTRICTED",
    why: "Publicering eller Marketplace begränsad",
  },
];

/** Avbrottet på sidan, eller null. `bodyText` är sidans synliga text; bara de första 20 000 tecknen läses. */
export function detectInterrupt(url: string, bodyText: string, hasCaptchaFrame = false): InterruptDetection | null {
  for (const p of URL_PATTERNS) if (p.re.test(url)) return { kind: p.kind, reason: p.why };
  if (hasCaptchaFrame) return { kind: "CAPTCHA", reason: "CAPTCHA-iframe finns på sidan" };
  const text = bodyText.slice(0, 20_000);
  for (const p of TEXT_PATTERNS) {
    const m = text.match(p.re);
    if (m) return { kind: p.kind, reason: `${p.why}: "${m[0]}"` };
  }
  return null;
}

/** Sessionsläget ett avbrott motsvarar. Inloggningen är DISCONNECTED; resten är kontrollpunkter eller spärrar. */
export function sessionStatusFor(kind: InterruptKind): FacebookSessionStatus {
  if (kind === "LOGIN_REQUIRED") return "DISCONNECTED";
  if (kind === "RESTRICTED") return "RESTRICTED";
  return "CHECKPOINT";
}

/**
 * Felet som kastas när ett avbrott upptäcks. Arbetaren fångar det, skriver NEEDS_MANUAL_ACTION och
 * stannar. Aldrig ett automatiskt omförsök.
 */
export class FacebookInterrupt extends Error {
  constructor(
    public readonly kind: InterruptKind,
    message: string,
    public readonly url: string,
    public readonly screenshot: string | null = null,
  ) {
    super(message);
    this.name = "FacebookInterrupt";
  }
}

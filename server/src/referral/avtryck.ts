/**
 * Avtrycken skydden jämför: samma person bakom två konton.
 *
 * VAD UPPDRAGET BAD OM OCH VAD SOM GÅR. Kravet var "delar telefonnummer eller Stripe-konto". Vi sparar
 * i dag inget av dem — registreringen frågar efter e-post och adress, och säljaren betalas ut via
 * Swish/bank för hand. Kontrollen jämför därför det vi HAR:
 *
 *   - e-posten, normaliserad så att "anna+2@gmail.com" och "a.nna@gmail.com" är samma som
 *     "anna@gmail.com". Supabase tillåter inte två konton på exakt samma adress, så en exakt
 *     jämförelse hade aldrig slagit till — tilläggen är just hur man gör ett andra konto.
 *   - gatuadressen PLUS postnumret. Aldrig postnumret ensamt: grannar delar postnummer, och en
 *     inbjudan till grannen är precis vad funktionen är till för.
 *   - telefon och Stripe-konto, när de finns. De är null för alla i dag, och jämförelsen hoppar över
 *     null. Den dag de börjar sparas slår kontrollen till utan att en rad här behöver ändras.
 *
 * Ett avtryck som saknas på någon av sidorna jämförs inte. Ett saknat avtryck är inte ett bevis för
 * att två konton är olika personer, men inte heller för att de är samma.
 */

import type { ReferralProfil } from "./store.js";

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

export function emailNyckel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  let lokal = email.slice(0, at).split("+")[0];
  let doman = email.slice(at + 1);
  if (GMAIL.has(doman)) {
    lokal = lokal.replace(/\./g, "");
    doman = "gmail.com";
  }
  return lokal ? `${lokal}@${doman}` : null;
}

/** "an•••@gmail.com". Nog för att inbjudaren ska känna igen sin vän, inte nog för att skriva till dem. */
export function maskeraEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const [lokal, doman] = raw.trim().toLowerCase().split("@");
  if (!lokal || !doman) return null;
  return `${lokal.slice(0, Math.min(2, lokal.length))}•••@${doman}`;
}

/**
 * Gata + postnummer, i en form. "Storgatan 1 A" och "storgatan 1a" är samma adress.
 * Null när någon av delarna saknas — se toppen av filen.
 */
export function adressNyckel(adress: { gatuadress?: unknown; postnummer?: unknown } | null | undefined): string | null {
  if (!adress) return null;
  const gata = typeof adress.gatuadress === "string" ? adress.gatuadress.toLowerCase().replace(/[^a-z0-9åäöéü]/g, "") : "";
  const post = typeof adress.postnummer === "string" || typeof adress.postnummer === "number" ? String(adress.postnummer).replace(/\D/g, "") : "";
  if (!gata || post.length !== 5) return null;
  return `${gata}|${post}`;
}

/** Svenska nummer i en form: 070-123 45 67, +46701234567 och 0046701234567 blir 46701234567. */
export function telefonNyckel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "46" + d.slice(1);
  return d.length >= 9 ? d : null;
}

/**
 * Varför två profiler räknas som samma person, eller null när de inte gör det.
 * Svaret är en maskinläsbar orsak — den skrivs i huvudboken, aldrig till användaren.
 */
export function delarIdentitet(a: ReferralProfil, b: ReferralProfil): string | null {
  if (a.userId === b.userId) return "samma_konto";
  const lika = (x: string | null, y: string | null) => x !== null && y !== null && x === y;
  if (lika(a.telefonNyckel, b.telefonNyckel)) return "samma_telefon";
  if (lika(a.stripeKonto, b.stripeKonto)) return "samma_stripe_konto";
  if (lika(a.emailNyckel, b.emailNyckel)) return "samma_epost";
  if (lika(a.adressNyckel, b.adressNyckel)) return "samma_adress";
  return null;
}

/**
 * Förnamnet som visas för den som öppnar en inbjudan: "Victor bjöd in dig!".
 *
 * Profilens namn först, och bara första ordet — ett efternamn på en publik landningssida är mer än
 * inbjudan behöver. Utan namn tas e-postadressens första del ("victor.ruiz@…" blir "Victor"), men
 * bara när den ser ut som ett namn: "vr1987" är ingen hälsning, och då blir svaret null och sidan
 * säger "En vän bjöd in dig!".
 */
export function fornamn(fullName: unknown, email: string | null | undefined): string | null {
  const snygga = (s: string) => s.charAt(0).toLocaleUpperCase("sv-SE") + s.slice(1).toLocaleLowerCase("sv-SE");
  if (typeof fullName === "string") {
    const forsta = fullName.trim().split(/\s+/)[0];
    if (forsta && /^[\p{L}-]{2,20}$/u.test(forsta)) return snygga(forsta);
  }
  const lokal = email?.split("@")[0]?.split(/[._+-]/)[0] ?? "";
  return /^\p{L}{2,12}$/u.test(lokal) ? snygga(lokal) : null;
}

import { createHash } from "node:crypto";

/**
 * Loopa-ID:t — annonsens publika namn.
 *
 * Varje annons är publik och nås utifrån på sitt ID. Det står i Tradera-annonsen och skrivs in i
 * sökrutan hos Loopa, alltså läses det av en människa ur en annonstext och knappas in för hand. Därför
 * är det inte jobbets UUID: 36 tecken med bindestreck går inte att skriva av utan att tappa bort sig.
 *
 * ID:t HÄRLEDS ur jobb-id:t i stället för att lottas och sparas. Ett lottat ID hade krävt ett register
 * över vilka som är tagna, och det registret hade varit en andra sanning som kan glida isär från
 * jobben — en kopierad datakatalog, en halvskriven fil, ett jobb som städas bort. Härledningen har
 * inget att glida ifrån: samma jobb ger samma ID, i dag och efter en flytt, utan migrering av de kort
 * som redan finns.
 */

/**
 * Crockford base32. Utelämnar I, L, O och U — de tre första för att de förväxlas med 1 och 0 i tryck
 * och handstil, det sista för att det annars går att lotta fram ord ingen vill ha i sin annons.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 8 tecken ur 32 = 2^40 möjliga ID. Långt nog att inte gå att gissa, kort nog att skriva av. */
const LENGTH = 8;

/**
 * Sammanhanget i hashen gör att ID:t inte går att räkna baklänges till jobb-id:t utan att känna
 * strängen — och framför allt att en annan hash av samma jobb-id någon annanstans i systemet aldrig
 * kan råka bli samma tal som det här.
 *
 * Strängen bär det gamla namnet "truth-card" och SKA fortsätta göra det. Den är ingen etikett utan
 * ingående data i hashen: ett annat sammanhang ger andra ID åt exakt samma jobb, och varje Loopa-ID
 * som redan står i en publicerad annons skulle sluta hitta sitt kort. Namnbytet är i språket, inte
 * i nycklarna.
 */
const NAMESPACE = "loopa:truth-card:";

function group(body: string): string {
  return `LP-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** Annonsens publika ID, på formen LP-XXXX-XXXX. Rent avbildat: samma jobb ger alltid samma ID. */
export function loopaIdFor(jobId: string): string {
  const digest = createHash("sha256").update(NAMESPACE + jobId).digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
      if (out.length === LENGTH) return group(out);
    }
  }
  return group(out);
}

/**
 * Läser ett inknackat ID.
 *
 * Den som skriver av ett ID ur en annons skriver O för 0 och I eller l för 1 — det är samma glyfer i
 * de flesta snitt, och just därför finns inte de tecknen i alfabetet. Att översätta dem här är
 * skillnaden mellan ett kort som hittas och ett "ingen träff" på en korrekt avläst kod. Bindestreck,
 * mellanslag och prefixet är kosmetik och får utelämnas.
 *
 * null = det här är inte ett Loopa-ID, och ska besvaras utan att jobben ens slås upp.
 */
export function normalizeLoopaId(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
  const body = (cleaned.startsWith("LP") ? cleaned.slice(2) : cleaned)
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (body.length !== LENGTH) return null;
  if ([...body].some((c) => !ALPHABET.includes(c))) return null;
  return group(body);
}

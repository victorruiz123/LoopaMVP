/**
 * Loopa-ID:t i klienten.
 *
 * ID:t räknas ut på servern (server/src/loopaId.ts) — här finns bara det som behövs för att läsa ett
 * inknackat sådant och för att bygga adressen till det publika kortet. Formen hålls medvetet slapp:
 * den som klistrar in "lp 4k9m2qx7" eller hela adressen ska hitta sitt kort ändå, och det är servern
 * som avgör vad som faktiskt är ett giltigt ID.
 */

/** Adressen ett publikt kort ligger på. Samma väg som skrivs ut i Tradera-annonsen. */
export function publicCardPath(loopaId: string): string {
  return `/c/${encodeURIComponent(loopaId)}`;
}

/** Loopa-ID:t ur en adress, eller null när adressen inte pekar på ett publikt kort. */
export function loopaIdFromPath(pathname: string): string | null {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Vad säljaren knackat in, som ett ID att fråga servern om.
 *
 * Tar även en hel adress: den som kopierar länken ur en annons klistrar in hela raden, och att svara
 * "hittades inte" på ett korrekt ID vore att skylla på användaren för vår egen strikthet.
 */
export function readTypedLoopaId(raw: string): string {
  const trimmed = raw.trim();
  const fromUrl = /\/c\/([^/?#\s]+)/.exec(trimmed);
  return (fromUrl ? fromUrl[1] : trimmed).trim();
}

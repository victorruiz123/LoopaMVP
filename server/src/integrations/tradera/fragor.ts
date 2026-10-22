/**
 * Har en köpare skrivit till Tradera-annonsen? Läses innan veckans omläggning avslutar den
 * (integrations/omlaggning.ts). Har den det får den ligga kvar, och den nya läggs upp bredvid — en
 * avslutad annons tar frågorna och köparens bevakning med sig.
 *
 * KÄLLAN ÄR MEJLEN. Tradera-API:t har ingen läsning av frågor eller meddelanden, men varje fråga kommer
 * som ett mejl ("Du har fått ett nytt meddelande. Angående: <rubrik> (<annons-id>) …"), och
 * mejlbevakningen (mailwatch.ts) sparar dem som `fraga` med annonsens id. Inkorgen läses en gång till
 * precis innan, så att en fråga från de senaste minuterna också räknas.
 *
 * GÅR MEJLEN INTE ATT LÄSA räknas annonsen som att den har frågor: en dubblett är billigare än en köpare
 * som blir utan svar.
 */

import type { TraderaPost } from "./mailwatch.js";

export interface TraderaFragor {
  harFragor: boolean;
  skal: string;
}

/** Frågorna om just den annonsen. Ren funktion. */
export function fragorOmAnnonsen(poster: Pick<TraderaPost, "kind" | "itemId">[], itemId: number): number {
  return poster.filter((p) => p.kind === "fraga" && p.itemId === itemId).length;
}

export async function lasTraderaFragor(itemId: number): Promise<TraderaFragor> {
  const { listTraderaPost, pollTraderaMail, traderaMailConfigured } = await import("./mailwatch.js");
  if (!traderaMailConfigured()) {
    return { harFragor: true, skal: "Tradera-mejlen läses inte på servern (GMAIL_* saknas) — frågorna går inte att se, räknas som att de finns." };
  }
  const poll = await pollTraderaMail().catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
  if (poll.error) {
    return { harFragor: true, skal: `Tradera-mejlen gick inte att läsa just nu (${poll.error}) — räknas som att frågor finns.` };
  }
  const { poster } = await listTraderaPost(Number.MAX_SAFE_INTEGER);
  const antal = fragorOmAnnonsen(poster, itemId);
  return antal > 0
    ? { harFragor: true, skal: `Annonsen har ${antal} ${antal === 1 ? "fråga" : "frågor"} från köpare.` }
    : { harFragor: false, skal: "Inga frågor från köpare." };
}

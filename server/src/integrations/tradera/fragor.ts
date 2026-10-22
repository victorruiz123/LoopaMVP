/**
 * Har en köpare skrivit till Tradera-annonsen? Läses innan veckans omläggning avslutar den
 * (integrations/omlaggning.ts). Har den det får den ligga kvar, och den nya läggs upp bredvid — en
 * avslutad annons tar frågorna och köparens bevakning med sig.
 *
 * KÄLLAN ÄR MEDDELANDEFUNKTIONEN på tradera.com (inkorg.ts), läst med säljarens sparade inloggning.
 * Tradera-API:t har ingen läsning av frågor eller meddelanden. Varje konversation i inkorgen bär
 * annonsens id i sin adress, så en tråd om just den här annonsen räknas — prisförslag också.
 *
 * GÅR INKORGEN INTE ATT LÄSA räknas annonsen som att den har frågor: en dubblett är billigare än en
 * köpare som blir utan svar.
 */

import { lasTraderaInkorg, traderaInkorgKonfigurerad, tradarOmAnnonsen } from "./inkorg.js";

export interface TraderaFragor {
  harFragor: boolean;
  skal: string;
}

/** Utfallet som regel. Null = inkorgen gick inte att läsa. Ren funktion. */
export function bedomTraderaFragor(antal: number | null, fel?: string): TraderaFragor {
  if (antal === null) {
    return { harFragor: true, skal: `Tradera-inkorgen gick inte att läsa (${fel ?? "okänt fel"}) — räknas som att köpare skrivit.` };
  }
  return antal > 0
    ? { harFragor: true, skal: `Annonsen har ${antal} ${antal === 1 ? "konversation" : "konversationer"} med köpare i Tradera-inkorgen.` }
    : { harFragor: false, skal: "Inga konversationer om annonsen i Tradera-inkorgen." };
}

export async function lasTraderaFragor(itemId: number): Promise<TraderaFragor> {
  if (!traderaInkorgKonfigurerad()) {
    return bedomTraderaFragor(null, "ingen Tradera-session på servern, kör npm run tradera:logga-in");
  }
  try {
    return bedomTraderaFragor(tradarOmAnnonsen(await lasTraderaInkorg(), itemId));
  } catch (err) {
    return bedomTraderaFragor(null, err instanceof Error ? err.message : String(err));
  }
}

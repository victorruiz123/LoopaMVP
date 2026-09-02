/**
 * Prisbekräftelsen: från granskat kort till låst pris.
 *
 * VARFÖR LOOPA LÄGGER FÖRSTA BUDET. Alternativet är att någon av parterna måste namnge en siffra
 * först, och i en förhandling förlorar den som gör det — köparen som säger för mycket, säljaren som
 * säger för lite. Prismotorn räknar i stället fram ett utgångsbud ur det VERIFIERADE skicket, och
 * båda får säga ja eller nej till samma tal. Det tar bort det taktiska momentet ur en affär som inte
 * handlar om att förhandla.
 *
 * EN RUNDA MOTBUD, sedan är det ja eller nej. Briefen är tydlig, och skälet är att en
 * motbudsslinga gör Trygg affär till en marknadsplats: två parter som pratar priser är precis det
 * de redan gjorde på Blocket, och det vi ersätter är risken — inte samtalet.
 *
 * BÅDA MÅSTE ACCEPTERA SAMMA BELOPP. `acceptedBy` nollställs vid varje nytt förslag, för ett ja
 * gäller ett tal och inte en affär.
 */

import { MAX_COUNTER_ROUNDS, type Deal, type PriceProposal } from "./types.js";
import { move, store } from "./store.js";
import { verifiedCardFor, type VerifiedCard } from "./scan.js";

/** Vad prisförslaget bygger på, skrivet så att båda parter kan läsa det. */
export interface PriceContext {
  /** Beloppet som ligger på bordet just nu. */
  amountSek: number;
  /** Varför det ser ut så. En eller två meningar. */
  rationale: string;
  /** Skillnaden mot vad säljaren begärde i annonsen. Negativt = lägre. */
  deltaFromAskingSek: number | null;
  /** Vad granskningen hittade som annonsen inte visade. Tomt när inget nytt dök upp. */
  newFindings: string[];
}

/**
 * Utgångsbudet, räknat ur det granskade skicket.
 *
 * TRE FALL, och de ska läsa olika:
 *
 * 1. Granskningen hittade fel som annonsbilderna inte visade. Då finns ett konkret skäl att sänka,
 *    och skälet ska stå utskrivet — "AI-granskningen hittade nedtryckt stoppning" — för att en
 *    sänkning utan angiven orsak är ett prut, och prut är vad vi tar bort.
 * 2. Granskningen bekräftade annonsen. Då står det begärda priset kvar; vi sänker inte för att vi
 *    kan.
 * 3. Prismotorn har inget att säga (okänd modell, för få jämförbara). Då blir det begärda priset
 *    utgångsbudet, och det sägs rakt ut att vi inte kunde värdera.
 */
export function openingProposal(deal: Deal, card: VerifiedCard): PriceContext {
  const asking = deal.submission?.askingPriceSek ?? null;
  const suggested = card.suggestedPriceSek;

  /**
   * Vad granskningen hittade som annonsen inte visade.
   *
   * Jämförelsen är grov med flit: den preliminära bedömningen är fritext ur annonsbilder och fynden
   * är strukturerade rader ur en besiktning, och att para ihop dem exakt går inte. Den frågar därför
   * bara om fyndets möbeldel över huvud taget NÄMNDES i det köparen redan sett. Ett fynd på en del
   * ingen talat om är nytt för båda parter, och det är den enda skillnad som behöver stå med.
   */
  const alreadyKnown = (deal.assessment?.observations ?? []).join(" ").toLowerCase();
  const newFindings = card.defects
    .filter((d) => !alreadyKnown.includes(d.part.toLowerCase()))
    .map((d) => `${d.description} (${d.part})`);

  if (suggested === null) {
    return {
      amountSek: asking ?? 0,
      rationale: asking
        ? "Vi kunde inte värdera just den här modellen mot jämförbara annonser, så förslaget är det pris säljaren begärde."
        : "Vi har varken ett begärt pris eller en värdering att utgå från. Kom överens om ett belopp.",
      deltaFromAskingSek: null,
      newFindings,
    };
  }

  if (asking === null) {
    return {
      amountSek: suggested,
      rationale: `Förslaget är prismotorns värdering för skicket granskningen visade (${card.gradeLabel ?? card.grade}).`,
      deltaFromAskingSek: null,
      newFindings,
    };
  }

  const delta = suggested - asking;
  const kr = (n: number) => `${Math.abs(n).toLocaleString("sv-SE")} kr`;

  /**
   * Vi sänker inte för att vi kan.
   *
   * Ligger värderingen under det begärda men granskningen hittade INGET nytt, står det begärda
   * priset kvar. Säljaren satte sitt pris med kunskap om sin egen möbel, och en sänkning som bara
   * grundas på att motorn räknat lägre är ett prut utan orsak — precis det Trygg affär ska slippa.
   */
  if (delta < 0 && newFindings.length === 0) {
    return {
      amountSek: asking,
      rationale: `Granskningen bekräftade annonsen — inga nya fel hittades. Det begärda priset står kvar.`,
      deltaFromAskingSek: 0,
      newFindings,
    };
  }

  if (delta < 0) {
    const first = newFindings[0];
    return {
      amountSek: suggested,
      rationale: `AI-granskningen hittade ${first}. Föreslagen justering: −${kr(delta)}.`,
      deltaFromAskingSek: delta,
      newFindings,
    };
  }

  // Värderingen ligger över det begärda. Säljarens pris står kvar — vi höjer inte åt någon.
  return {
    amountSek: asking,
    rationale:
      `Granskningen visade ${card.gradeLabel ?? card.grade}, och möbeln värderas till ${kr(suggested)}. ` +
      `Säljarens pris ligger under det, så det står kvar.`,
    deltaFromAskingSek: 0,
    newFindings,
  };
}

/**
 * Öppnar prisrundan när möbeln är granskad.
 *
 * Anropas vid läsning av affären, som `syncScanState` — och av samma skäl: ingen annan del av
 * systemet behöver veta att en prisrunda finns. Idempotent; ett andra anrop lägger inget nytt bud.
 */
export async function openPriceRound(deal: Deal): Promise<Deal> {
  if (deal.state !== "scanned") return deal;
  const card = await verifiedCardFor(deal);
  if (!card) return deal;

  const ctx = openingProposal(deal, card);
  const proposal: PriceProposal = {
    amountSek: ctx.amountSek,
    by: "loopa",
    at: new Date().toISOString(),
    rationale: ctx.rationale,
  };
  const updated = await move(
    deal.id,
    ["scanned"],
    "price_pending",
    { kind: "system", job: "openPriceRound" },
    `Prisförslag: ${ctx.amountSek.toLocaleString("sv-SE")} kr.`,
    { proposals: [...deal.proposals, proposal], acceptedBy: [], awaiting: null },
  );
  return updated ?? deal;
}

export class PriceError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

/**
 * En part accepterar det liggande beloppet.
 *
 * Låser priset först när BÅDA gjort det. Att den andres accept ligger kvar sedan tidigare är hela
 * poängen med `acceptedBy` — den som svarar sist behöver inte veta vem som svarade först.
 */
export async function acceptPrice(deal: Deal, role: "buyer" | "seller"): Promise<Deal> {
  if (deal.state !== "price_pending") throw new PriceError("Det finns inget prisförslag att ta ställning till.");
  const current = deal.proposals.at(-1);
  if (!current) throw new PriceError("Det finns inget prisförslag att ta ställning till.");

  const accepted = deal.acceptedBy.includes(role) ? deal.acceptedBy : [...deal.acceptedBy, role];
  const bothAgree = accepted.includes("buyer") && accepted.includes("seller");

  if (!bothAgree) {
    const other = role === "buyer" ? "seller" : "buyer";
    const updated = await move(
      deal.id, ["price_pending"], "price_pending",
      { kind: role, userId: role === "buyer" ? deal.buyerId : deal.sellerId } as never,
      `${role === "buyer" ? "Köparen" : "Säljaren"} accepterade ${current.amountSek.toLocaleString("sv-SE")} kr.`,
      { acceptedBy: accepted, awaiting: other },
    );
    if (!updated) throw new PriceError("Affären hann ändras. Ladda om och försök igen.");
    return updated;
  }

  const updated = await move(
    deal.id, ["price_pending"], "price_agreed",
    { kind: role, userId: role === "buyer" ? deal.buyerId : deal.sellerId } as never,
    `Båda har accepterat ${current.amountSek.toLocaleString("sv-SE")} kr. Priset är låst.`,
    { acceptedBy: accepted, awaiting: null, agreedPriceSek: current.amountSek },
  );
  if (!updated) throw new PriceError("Affären hann ändras. Ladda om och försök igen.");
  return updated;
}

/**
 * En part lägger ett motbud. En gång.
 *
 * Att lägga ett bud är att acceptera sitt eget tal, så motbudaren står redan som accepterande och
 * bollen ligger hos motparten. Nästa svar därifrån kan bara vara ja eller nej — se `mayCounter`.
 */
export async function counterPrice(deal: Deal, role: "buyer" | "seller", amountSek: number): Promise<Deal> {
  if (deal.state !== "price_pending") throw new PriceError("Det finns ingen prisrunda att lägga ett bud i.");
  if (deal.counterRounds >= MAX_COUNTER_ROUNDS) {
    throw new PriceError("Det går bara att lägga ett motbud. Acceptera eller tacka nej.");
  }
  if (!Number.isFinite(amountSek) || amountSek <= 0 || amountSek > 500_000) {
    throw new PriceError("Ange ett rimligt belopp.", 400);
  }
  const amount = Math.round(amountSek);
  const other = role === "buyer" ? "seller" : "buyer";
  const proposal: PriceProposal = {
    amountSek: amount,
    by: role,
    at: new Date().toISOString(),
    rationale: null,
  };
  const updated = await move(
    deal.id, ["price_pending"], "price_pending",
    { kind: role, userId: role === "buyer" ? deal.buyerId : deal.sellerId } as never,
    `${role === "buyer" ? "Köparen" : "Säljaren"} lade ett motbud: ${amount.toLocaleString("sv-SE")} kr.`,
    {
      proposals: [...deal.proposals, proposal],
      // Ett nytt belopp nollställer tidigare ja. Den som bjuder accepterar sitt eget tal.
      acceptedBy: [role],
      awaiting: other,
      counterRounds: deal.counterRounds + 1,
    },
  );
  if (!updated) throw new PriceError("Affären hann ändras. Ladda om och försök igen.");
  return updated;
}

/** En part tackar nej. Affären är slut — det finns inget att förhandla vidare om. */
export async function declineDeal(deal: Deal, role: "buyer" | "seller"): Promise<Deal> {
  const updated = await move(
    deal.id,
    [deal.state],
    "declined",
    { kind: role, userId: role === "buyer" ? deal.buyerId : deal.sellerId } as never,
    `${role === "buyer" ? "Köparen" : "Säljaren"} tackade nej.`,
    { awaiting: null },
  );
  if (!updated) throw new PriceError("Affären går inte att avbryta i sitt nuvarande läge.");
  return updated;
}

/** Vad den som tittar får göra just nu. Driver knapparna, och prövas om på servern. */
export function actionsFor(deal: Deal, role: "buyer" | "seller"): {
  canAccept: boolean;
  canCounter: boolean;
  canDecline: boolean;
  hasAccepted: boolean;
} {
  const open = deal.state === "price_pending";
  const hasAccepted = deal.acceptedBy.includes(role);
  return {
    canAccept: open && !hasAccepted,
    canCounter: open && deal.counterRounds < MAX_COUNTER_ROUNDS && !hasAccepted,
    canDecline: open || deal.state === "scanned" || deal.state === "seller_joined",
    hasAccepted,
  };
}

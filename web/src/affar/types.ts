/**
 * Trygg affär, klientens typer.
 *
 * Speglar server/src/affar/types.ts för hand, som resten av projektet gör över den gränsen (se
 * web/src/types.ts och web/src/butik/types.ts). Ändras serverns modell ska den här följa med i
 * samma ändring.
 */

export type DealState =
  | "created" | "invited" | "seller_joined" | "scanned" | "price_pending" | "price_agreed"
  | "paid" | "pickup_booked" | "picked_up" | "delivered" | "approved" | "paid_out"
  | "declined" | "expired";

export interface PreliminaryAssessment {
  brand: string | null;
  model: string | null;
  categorySlug: string | null;
  /** Möbeln i ett ord: "soffa", "matbord". Det som skrivs i meddelandet till säljaren. */
  categoryNoun: string | null;
  /** Null vid låg säkerhet — vi sätter inget betyg på en möbel vi inte sett tillräckligt av. */
  grade: string | null;
  gradeNote: string | null;
  observations: string[];
  confidence: "low" | "medium" | "high";
  marketLowSek: number | null;
  marketHighSek: number | null;
  questions: string[];
  redFlags: string[];
  assessedAt: string;
}

export interface PriceVerdict {
  verdict: "under" | "inom" | "over" | "okant";
  text: string;
}

export interface PriceProposal {
  amountSek: number;
  /** "loopa" = prismotorns utgångsbud. Ingen av parterna behöver namnge en siffra först. */
  by: "buyer" | "seller" | "loopa";
  at: string;
  rationale: string | null;
}

/** Affären som en av parterna ser den. Säljaren får aldrig med `assessment`. */
export interface DealView {
  id: string;
  state: DealState;
  role: "buyer" | "seller";
  what: string;
  askingPriceSek: number | null;
  proposals: PriceProposal[];
  awaiting: "buyer" | "seller" | null;
  /** Vilka som accepterat det SENASTE förslaget. Nollställs vid varje nytt. */
  acceptedBy: Array<"buyer" | "seller">;
  counterRounds: number;
  agreedPriceSek: number | null;
  scanJobId: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** Bara för köparen. */
  inviteToken?: string;
  assessment?: PreliminaryAssessment | null;
  submission?: { adUrl: string | null; description: string | null; askingPriceSek: number | null; imagePaths: number } | null;
  priceVerdict?: PriceVerdict;
  /**
   * Följer med i LISTAN (GET /api/affar), inte i affärsrummet — där hämtas de var för sig.
   *
   * Profilen ska kunna säga vad som väntar på vem och vad man får göra åt det utan att man öppnar
   * varje affär för att ta reda på det.
   */
  actions?: DealActions;
  /** Det verifierade kortet, när säljaren filmat. Null före det — vi har inget kort att visa än. */
  card?: VerifiedCard | null;
}

export interface DealEvent {
  id: string;
  from: DealState | null;
  to: DealState;
  at: string;
  actor: { kind: string; userId?: string | null; job?: string };
  note: string | null;
}

/** Säljarens vy av inbjudan, innan de skapat konto. Inga uppgifter om köparen. */
export interface PublicInvite {
  token: string;
  state: DealState;
  what: string;
  askingPriceSek: number | null;
  offeredPriceSek: number | null;
  expiresAt: string | null;
  closed: boolean;
}

/** Svaret från den publika bedömningen — innan någon affär finns. */
export interface Analysis {
  assessment: PreliminaryAssessment;
  submission: { adUrl: string | null; description: string | null; askingPriceSek: number | null; imagePaths: number };
  priceVerdict: PriceVerdict;
  scratchId: string;
  source: "MANUAL_CONTENT" | "LINK_FETCH";
  /** Satt när hämtningen inte gick och vi föll tillbaka på köparens eget material. */
  fallbackReason?: string | null;
}

/**
 * Vad säljaren får förifyllt.
 *
 * IDENTIFIERINGEN, aldrig skicket. Se prefillFor i server/src/affar/scan.ts för varför gränsen går
 * just där — och tests/affar-scan.test.ts, som håller den.
 */
export interface ScanPrefill {
  brand: string | null;
  model: string | null;
  categoryNoun: string | null;
  askingPriceSek: number | null;
  descriptionDraft: string | null;
}

/** Det verifierade kortet. Efter skanningen ser båda parter exakt detta. */
export interface VerifiedCard {
  jobId: string;
  loopaId: string;
  brand: string | null;
  model: string | null;
  grade: string | null;
  gradeLabel: string | null;
  gradeRationale: string | null;
  defects: Array<{ id: string; part: string; description: string; severity: string }>;
  measurements: Array<{ label: string; value: string }>;
  suggestedPriceSek: number | null;
  imageCount: number;
  reviewed: boolean;
  inspectedAt: string | null;
}

/** Vad den som tittar får göra just nu. Prövas om på servern — det här styr bara knapparna. */
export interface DealActions {
  canAccept: boolean;
  canCounter: boolean;
  canDecline: boolean;
  hasAccepted: boolean;
}

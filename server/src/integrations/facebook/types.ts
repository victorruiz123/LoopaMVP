/**
 * Facebook-distributionens datamodell.
 *
 * LOOPA ÄR SANNINGEN. Ingenting här beskriver en möbel — titel, pris, skick och bilder bor i jobbet och
 * butiksprojektionen (butik/normalize.ts), och Facebook-posterna pekar tillbaka på Loopa-ID:t. Det som
 * bor här är det Facebook vet och Loopa inte vet: vilka grupper som finns, om vi är medlemmar, vad som
 * publicerats var, och var en körning stannade.
 *
 * Publikationsposterna bär `facebookUrl`/`facebookPostUrl` och `phase` med flit: den dag en såld möbel
 * ska tas ner eller uppdateras på Facebook är det de här fälten som gör det möjligt utan att modellen
 * ritas om. V1 gör ingen sådan städning — den sålda möbelns Loopa-sida svarar i stället "såld" och
 * visar liknande möbler (butik/similar.ts).
 */

// ---------------------------------------------------------------------------
// Sessionen och avbrotten
// ---------------------------------------------------------------------------

export type FacebookSessionStatus = "CONNECTED" | "DISCONNECTED" | "CHECKPOINT" | "RESTRICTED" | "UNKNOWN";

export interface FacebookSessionRecord {
  status: FacebookSessionStatus;
  checkedAt: string;
  url: string | null;
  detail: string;
  /** Kontots Facebook-id (c_user-kakan) när det gick att läsa. Jämförs med FACEBOOK_ACCOUNT_ID. */
  accountId?: string | null;
}

/** Vad Facebook visade som fick roboten att STANNA. Upptäcks, kringgås aldrig — se checkpoint.ts. */
export type InterruptKind = "CAPTCHA" | "LOGIN_REQUIRED" | "CHECKPOINT" | "RESTRICTED" | "SUSPICIOUS_ACTIVITY";

/**
 * En post som kräver en människa. Skrivs när ett avbrott upptäckts eller när en skrivning trycktes men
 * inte gick att verifiera (då får den ALDRIG göras om automatiskt — det kan bli två annonser).
 */
export interface ManualAction {
  id: string;
  at: string;
  kind: InterruptKind | "UNVERIFIED_WRITE" | "OTHER";
  reason: string;
  url: string | null;
  screenshot: string | null;
  lastCompletedStep: string | null;
  /** Vilken arbetare, och vad den höll på med. */
  context: { worker: string; listingId?: string; groupId?: string };
  resolvedAt: string | null;
  resolvedBy: string | null;
}

// ---------------------------------------------------------------------------
// Grupperna
// ---------------------------------------------------------------------------

export type GroupCategory =
  /** Köp/sälj-grupper som handlar om just möbler eller inredning. Bäst. */
  | "FURNITURE_BUY_SELL"
  /** Allmänna köp/sälj/bortskänkes-grupper för Stockholm eller en stadsdel. */
  | "LOCAL_BUY_SELL"
  /** Secondhand, loppis, vintage, återbruk. */
  | "SECONDHAND"
  /** Märkesgemenskaper där andrahandsförsäljning är normalt (IKEA, Sweef …). */
  | "BRAND_COMMUNITY"
  /** Lokala anslagstavlor och grannskapsgrupper där möbelannonser förekommer. */
  | "GENERAL"
  | "OTHER";

export type AdsStatus = "ALLOWED" | "LIKELY_ALLOWED" | "UNCLEAR" | "PROHIBITED";

/**
 * Medlemskapets tillståndsmaskin. Övergångarna står i membership.ts (`MEMBERSHIP_TRANSITIONS`) och
 * ingenting annat får flytta en grupp mellan lägena.
 */
export type MembershipStatus =
  | "UNKNOWN"
  | "NOT_MEMBER"
  | "JOIN_REQUESTED"
  | "PENDING_APPROVAL"
  | "MEMBER"
  | "QUESTIONS_REQUIRED"
  | "JOIN_REJECTED"
  | "JOIN_BLOCKED"
  | "NEEDS_MANUAL_ACTION";

export type GroupVisibility = "PUBLIC" | "PRIVATE" | "UNKNOWN";

/** Vilken sorts skrivruta gruppen erbjuder. Köp/sälj-grupper har ofta bara "Sälj något". */
export type ComposerKind = "post" | "listing" | "none";

export interface MembershipQuestion {
  text: string;
  kind: "text" | "choice" | "agree_rules" | "unknown";
  options?: string[];
  /** Svaret som gavs, eller null när frågan inte kunde besvaras sanningsenligt. */
  answer: string | null;
  answerable: boolean;
  /** Varför svaret blev som det blev — vilket fält i operatörsprofilen det vilar på. */
  basis: string;
  askedAt: string;
}

export interface MembershipEvent {
  at: string;
  from: MembershipStatus;
  to: MembershipStatus;
  detail: string;
  screenshot?: string | null;
}

export interface FacebookGroup {
  /** Gruppnyckeln: det numeriska id:t eller slugen, gemener. Unik och stabil. Se groups.ts. */
  id: string;
  facebookGroupId: string;
  name: string;
  canonicalUrl: string;
  category: GroupCategory;
  /** "Stockholm", "Södermalm", "Nacka" … Det vi kunnat läsa ur namnet eller beskrivningen. */
  geography: string;
  visibility: GroupVisibility;
  memberCount: number | null;
  relevanceScore: number;
  activityScore: number;
  /** Varför gruppen fick sin poäng, en rad per delpoäng. Visas i panelen. */
  rankingReasons: string[];
  rulesText: string | null;
  aboutText: string | null;
  rulesLastCheckedAt: string | null;
  /** De fraser i reglerna som avgjorde `adsStatus`. */
  rulesEvidence: string[];
  adsStatus: AdsStatus;
  /** Reglerna förbjuder länkar. Våra inlägg bär alltid Loopa-adressen, så det är ett nej — se rules.ts. */
  linksProhibited?: boolean;
  /** Gruppens egen takt ("ett inlägg per vecka") i timmar, när reglerna säger en. Null = ingen läst. */
  postCooldownHours?: number | null;
  composerKind: ComposerKind | null;
  membershipStatus: MembershipStatus;
  membershipDetail: string | null;
  joinEligible: boolean;
  joinReasons: string[];
  postEligible: boolean;
  postReasons: string[];
  /** Adminens brytare. Sätts automatiskt när gruppen blir MEMBER + postbar; kan stängas av för hand. */
  enabledForDistribution: boolean;
  /** Vem som satte brytaren senast. "admin" fryser den mot automatiken — se membership.ts. */
  enabledForDistributionSetBy: "auto" | "admin" | null;
  joinAttempts: number;
  joinRequestedAt: string | null;
  joinedAt: string | null;
  membershipLastCheckedAt: string | null;
  lastPostedAt: string | null;
  lastValidatedAt: string | null;
  questions: MembershipQuestion[];
  history: MembershipEvent[];
  /** Sökfrågorna som hittade gruppen. */
  discoveredVia: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Publiceringarna
// ---------------------------------------------------------------------------

export type PublicationStatus = "QUEUED" | "PREPARING" | "WOULD_PUBLISH" | "PUBLISHED" | "FAILED" | "NEEDS_MANUAL_ACTION";

/**
 * Var en körning står i förhållande till den externa skrivningen.
 *
 *   before_publish   allt före sista knappen — ett omförsök är säkert
 *   publish_clicked  knappen är tryckt men utfallet inte läst — ett omförsök kan ge två annonser
 *   verified         utfallet är läst
 */
export type PublicationPhase = "before_publish" | "publish_clicked" | "verified" | null;

/**
 * Var en publicerad post står i FACEBOOKS granskning. FACEBOOK_REVIEW = "Säljinlägget granskas"
 * (Facebooks egen standardgranskning av säljinlägg, synlig för andra först när den släppt).
 * ADMIN_APPROVAL = gruppens administratörer måste godkänna inlägget.
 */
export type ModerationState = "FACEBOOK_REVIEW" | "ADMIN_APPROVAL";

export interface MarketplaceContentSnapshot {
  title: string;
  price: number;
  description: string;
  category: string;
  condition: string | null;
  location: string;
  imageCount: number;
  canonicalUrl: string;
}

export interface MarketplacePublication {
  /** Loopa-ID:t. Unikt — en annons har högst en Marketplace-publicering. */
  listingId: string;
  jobId: string;
  status: PublicationStatus;
  phase: PublicationPhase;
  attempts: number;
  queuedAt: string;
  attemptedAt: string | null;
  publishedAt: string | null;
  facebookUrl: string | null;
  facebookListingId: string | null;
  /** Facebooks granskningsläge efter publiceringen, när det gick att läsa. */
  moderation?: ModerationState | null;
  failureReason: string | null;
  screenshot: string | null;
  contentSnapshot: MarketplaceContentSnapshot | null;
  /** Vad körningen gjordes som. Sant = stannade före Publicera. */
  dryRun: boolean;
  /** Robotens steg, senast först kapade. Samma idé som Blockets `steps`. */
  steps: PublicationStep[];
  updatedAt: string;
}

export interface GroupContentSnapshot {
  /** Textinlägg ("post") eller säljinlägg ("listing"). Saknas på poster från före 2026-09-26 = post. */
  kind?: "post" | "listing";
  /** Inläggets text, eller säljinläggets beskrivning. */
  text: string;
  /** Säljinläggets rubrik och pris — textinlägget bär dem i texten. */
  title?: string | null;
  price?: number | null;
  imageCount: number;
  canonicalUrl: string;
}

export interface GroupPublication {
  listingId: string;
  groupId: string;
  jobId: string;
  status: PublicationStatus;
  phase: PublicationPhase;
  attempts: number;
  queuedAt: string;
  attemptedAt: string | null;
  publishedAt: string | null;
  facebookPostUrl: string | null;
  /** Vilken ruta som användes. Saknas på poster från före 2026-09-26. */
  composer?: ComposerKind | null;
  /** Marketplace-annonsens id när säljinlägget fick ett. */
  facebookListingId?: string | null;
  /** Facebooks eller gruppadministratörernas granskningsläge efter publiceringen. */
  moderation?: ModerationState | null;
  failureReason: string | null;
  screenshot: string | null;
  contentSnapshot: GroupContentSnapshot | null;
  dryRun: boolean;
  steps: PublicationStep[];
  updatedAt: string;
}

export interface PublicationStep {
  name: string;
  status: "ok" | "warning" | "error" | "running";
  at: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Inställningarna
// ---------------------------------------------------------------------------

/**
 * Operatörsprofilen: de SANNA uppgifter som medlemsfrågor får besvaras med. Tomt fält = frågan kan
 * inte besvaras och gruppen blir QUESTIONS_REQUIRED. Ingenting hittas på. Se questions.ts.
 */
export interface OperatorProfile {
  displayName: string;
  city: string;
  region: string;
  interests: string;
  businessAffiliation: string;
  defaultJoinReason: string;
}

export interface FacebookSettings {
  operatorProfile: OperatorProfile;
  discoveryPaused: boolean;
  autoJoinPaused: boolean;
  marketplacePaused: boolean;
  groupPublishingPaused: boolean;
  /** Panelens tak för grupper per annons. Null = miljöns FACEBOOK_MAX_GROUPS_PER_LISTING gäller. */
  maxGroupsPerListing: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const EMPTY_OPERATOR_PROFILE: OperatorProfile = {
  displayName: "",
  city: "",
  region: "",
  interests: "",
  businessAffiliation: "",
  defaultJoinReason: "",
};

export const DEFAULT_FACEBOOK_SETTINGS: FacebookSettings = {
  operatorProfile: EMPTY_OPERATOR_PROFILE,
  discoveryPaused: false,
  autoJoinPaused: false,
  marketplacePaused: false,
  groupPublishingPaused: false,
  maxGroupsPerListing: null,
  updatedAt: null,
  updatedBy: null,
};

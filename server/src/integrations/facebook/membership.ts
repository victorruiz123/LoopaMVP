/**
 * Medlemskapets tillståndsmaskin och behörigheterna — REN, ingen webbläsare.
 *
 * Övergångstabellen ÄR regeln, som i butik/types.ts: en övergång som inte står här kan inte ske av
 * misstag någonstans. Den som flyttar en grupp gör det genom `applyMembership`, som också skriver
 * historiken och tidsstämplarna.
 *
 * IDEMPOTENS FÖR ANSÖKNINGAR. En grupp i något av `NON_JOINABLE` får aldrig ett nytt klick på "Gå med":
 * antingen är vi redan medlemmar, väntar på svar, eller väntar på en människa. Det är den listan
 * som hindrar att samma ansökan skickas var sjätte timme.
 */

import type { FacebookLimits } from "./config.js";
import { detectGeography } from "./ranking.js";
import { adsStatusAllowsPosting, joinBlockedBy } from "./rules.js";
import type { FacebookGroup, FacebookSettings, MembershipStatus } from "./types.js";

export const MEMBERSHIP_TRANSITIONS: Readonly<Record<MembershipStatus, readonly MembershipStatus[]>> = {
  UNKNOWN: ["NOT_MEMBER", "MEMBER", "PENDING_APPROVAL", "JOIN_BLOCKED", "NEEDS_MANUAL_ACTION"],
  NOT_MEMBER: ["JOIN_REQUESTED", "MEMBER", "PENDING_APPROVAL", "QUESTIONS_REQUIRED", "JOIN_BLOCKED", "NEEDS_MANUAL_ACTION"],
  JOIN_REQUESTED: ["PENDING_APPROVAL", "MEMBER", "QUESTIONS_REQUIRED", "JOIN_BLOCKED", "JOIN_REJECTED", "NEEDS_MANUAL_ACTION", "NOT_MEMBER"],
  PENDING_APPROVAL: ["MEMBER", "JOIN_REJECTED", "NOT_MEMBER", "NEEDS_MANUAL_ACTION"],
  MEMBER: ["NOT_MEMBER", "NEEDS_MANUAL_ACTION"],
  QUESTIONS_REQUIRED: ["JOIN_REQUESTED", "MEMBER", "PENDING_APPROVAL", "NOT_MEMBER", "NEEDS_MANUAL_ACTION"],
  JOIN_REJECTED: ["NOT_MEMBER", "MEMBER"],
  JOIN_BLOCKED: ["NOT_MEMBER", "MEMBER"],
  NEEDS_MANUAL_ACTION: ["NOT_MEMBER", "MEMBER", "PENDING_APPROVAL", "QUESTIONS_REQUIRED"],
};

export function canTransition(from: MembershipStatus, to: MembershipStatus): boolean {
  return from === to || MEMBERSHIP_TRANSITIONS[from].includes(to);
}

/** Lägen där ett nytt klick på "Gå med" vore dubbelt eller osäkert. */
export const NON_JOINABLE: readonly MembershipStatus[] = [
  "MEMBER",
  "JOIN_REQUESTED",
  "PENDING_APPROVAL",
  "QUESTIONS_REQUIRED",
  "JOIN_BLOCKED",
  "JOIN_REJECTED",
  "NEEDS_MANUAL_ACTION",
];

/** Lägen som vakten ska titta till igen: en ansökan som väntar på Facebook eller på en admin. */
export const PENDING_STATUSES: readonly MembershipStatus[] = ["JOIN_REQUESTED", "PENDING_APPROVAL"];

export class MembershipTransitionError extends Error {}

/**
 * Flyttar gruppen. Skriver historiken och de tidsstämplar övergången äger. Kastar när övergången inte
 * står i tabellen — det är ett programfel, inte ett Facebook-utfall.
 *
 * Samma läge igen är tillåtet och skriver bara `membershipLastCheckedAt` och detaljen: vakten ser
 * PENDING_APPROVAL varje gång den tittar, och det ska synas att den tittat.
 */
export function applyMembership(
  group: FacebookGroup,
  to: MembershipStatus,
  detail: string,
  opts: { at?: string; screenshot?: string | null; countAttempt?: boolean } = {},
): FacebookGroup {
  const from = group.membershipStatus;
  if (!canTransition(from, to)) {
    throw new MembershipTransitionError(`Medlemskapet kan inte gå från ${from} till ${to} (${group.id}).`);
  }
  const at = opts.at ?? new Date().toISOString();
  const next: FacebookGroup = {
    ...group,
    membershipStatus: to,
    membershipDetail: detail,
    membershipLastCheckedAt: at,
    joinAttempts: group.joinAttempts + (opts.countAttempt ? 1 : 0),
    history: from === to ? group.history : [...group.history, { at, from, to, detail, screenshot: opts.screenshot ?? null }].slice(-100),
  };
  if (to === "JOIN_REQUESTED" || (to === "PENDING_APPROVAL" && from !== "PENDING_APPROVAL")) {
    next.joinRequestedAt = group.joinRequestedAt ?? at;
  }
  if (to === "MEMBER" && from !== "MEMBER") next.joinedAt = at;
  if (to === "NOT_MEMBER" && from === "MEMBER") next.joinedAt = null;
  return next;
}

// ---------------------------------------------------------------------------
// Behörigheterna
// ---------------------------------------------------------------------------

export interface Eligibility {
  eligible: boolean;
  reasons: string[];
}

/**
 * Får roboten försöka gå med? Kräver relevans, storlek, att ingen regel förbjuder företag som medlemmar,
 * och att medlemskapet står i ett läge där ett klick betyder något.
 */
export function computeJoinEligibility(
  group: Pick<FacebookGroup, "membershipStatus" | "relevanceScore" | "memberCount" | "rulesText" | "aboutText" | "adsStatus" | "category">,
  limits: Pick<FacebookLimits, "minRelevanceToJoin" | "minMembersToJoin">,
): Eligibility {
  const reasons: string[] = [];
  if (NON_JOINABLE.includes(group.membershipStatus)) reasons.push(`medlemskapet är ${group.membershipStatus}`);
  if (group.relevanceScore < limits.minRelevanceToJoin) reasons.push(`relevans ${group.relevanceScore} under gränsen ${limits.minRelevanceToJoin}`);
  if (group.memberCount !== null && group.memberCount < limits.minMembersToJoin) reasons.push(`${group.memberCount} medlemmar, under gränsen ${limits.minMembersToJoin}`);
  if (group.category === "OTHER") reasons.push("kategorin OTHER — ingen möbel- eller köp/sälj-grupp");
  /**
   * PROHIBITED hindrar inte medlemskap i sig — men det finns inget att vinna: vi publicerar aldrig dit.
   * En ansökan vi inte har någon användning för är en ansökan för mycket.
   */
  if (group.adsStatus === "PROHIBITED") reasons.push("reglerna förbjuder företagsinlägg — inget att vinna på medlemskap");
  const blocked = joinBlockedBy(`${group.rulesText ?? ""} ${group.aboutText ?? ""}`);
  if (blocked) reasons.push(`reglerna begränsar medlemskapet: "${blocked}"`);
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Får en annons läggas ut i gruppen? Medlem + regler som tillåter + en skrivruta.
 *
 * Båda rutorna duger: textinlägget ("Skriv något") och säljinlägget ("Sälj något", annonsformuläret
 * i köp/sälj-grupper — stött sedan 2026-09-26, se publisher.ts). Bara en grupp helt utan ruta för
 * medlemmar är opostbar.
 */
export function computePostEligibility(
  group: Pick<FacebookGroup, "membershipStatus" | "adsStatus" | "composerKind" | "rulesLastCheckedAt">,
): Eligibility {
  const reasons: string[] = [];
  if (group.membershipStatus !== "MEMBER") reasons.push(`inte medlem (${group.membershipStatus})`);
  if (!adsStatusAllowsPosting(group.adsStatus)) reasons.push(`reglerna är ${group.adsStatus}`);
  if (group.composerKind === "none") reasons.push("ingen skrivruta för medlemmar");
  if (!group.rulesLastCheckedAt) reasons.push("reglerna har inte lästs");
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Räknar om båda behörigheterna och sätter distributionsbrytaren AUTOMATISKT när gruppen blir postbar
 * — men rör den aldrig när en admin satt den för hand.
 */
export function refreshEligibility(group: FacebookGroup, limits: FacebookLimits): FacebookGroup {
  const join = computeJoinEligibility(group, limits);
  const post = computePostEligibility(group);
  let enabled = group.enabledForDistribution;
  if (group.enabledForDistributionSetBy !== "admin") {
    enabled = post.eligible;
  } else if (!post.eligible) {
    // Adminens ja gäller bara så länge gruppen faktiskt går att publicera i. Ett nej står alltid.
    enabled = false;
  }
  return {
    ...group,
    joinEligible: join.eligible,
    joinReasons: join.reasons,
    postEligible: post.eligible,
    postReasons: post.reasons,
    enabledForDistribution: enabled,
    enabledForDistributionSetBy: group.enabledForDistributionSetBy === "admin" ? "admin" : enabled ? "auto" : group.enabledForDistributionSetBy,
  };
}

// ---------------------------------------------------------------------------
// Urvalet per annons
// ---------------------------------------------------------------------------

/** Det urvalet behöver veta om möbeln. Byggs ur FacebookListing eller ur butikens Product — samma fält. */
export interface ListingProfile {
  categorySlug: string;
  brand: string | null;
  /** Regionen på varan, t.ex. "Stockholm". */
  location: string;
}

export interface GroupSelection {
  group: FacebookGroup;
  score: number;
  reasons: string[];
}

export interface SelectionOptions {
  /** Taket: panelens inställning eller miljöns FACEBOOK_MAX_GROUPS_PER_LISTING. */
  max: number;
  /** Minsta paus per grupp när reglerna inte säger en strängare. */
  defaultCooldownHours: number;
  /** Grupper med en olöst manuell åtgärd — där är läget okänt och ingenting publiceras. */
  blockedGroupIds?: ReadonlySet<string>;
  now?: Date;
}

export interface SelectionResult {
  selected: GroupSelection[];
  skipped: Array<{ id: string; name: string; reason: string }>;
}

function brandInName(brand: string | null, name: string): boolean {
  if (!brand) return false;
  const b = brand.toLowerCase().replace(/[^a-zåäö0-9]+/g, " ").trim();
  return b.length >= 3 && name.toLowerCase().includes(b);
}

/**
 * Vilka grupper JUST DEN HÄR möbeln ska ut i, och i vilken ordning.
 *
 * Poolen är `distributionTargets` (medlem + postbar + påslagen). Ovanpå det, per annons:
 *
 *   - en olöst manuell åtgärd på gruppen  -> hoppas över (läget är okänt tills en människa tittat)
 *   - länkförbud i reglerna                -> hoppas över (våra inlägg bär alltid Loopa-adressen)
 *   - en annan stad i gruppens geografi    -> hoppas över (möbeln står i Stockholm)
 *   - märkesgrupp för ett annat märke      -> hoppas över
 *   - paus per grupp (gruppens egen takt eller förvalet) sedan senaste Loopa-inlägget -> hoppas över
 *
 * Poängen är gruppens relevans plus det möbeln tillför: möbelspecifik köp/sälj-grupp, samma märke i
 * gruppnamnet, Storstockholm. Skälen följer med — panelen ska kunna svara på "varför den gruppen".
 * Taket kapar sist. Idempotensen ligger inte här utan i lagret (listing × grupp).
 */
export function selectGroupsForListing(groups: FacebookGroup[], listing: ListingProfile, opts: SelectionOptions): SelectionResult {
  const now = opts.now ?? new Date();
  const skipped: SelectionResult["skipped"] = [];
  const pool = distributionTargets(groups, Number.MAX_SAFE_INTEGER);
  const poolIds = new Set(pool.map((g) => g.id));
  for (const g of groups) {
    if (!poolIds.has(g.id) && g.membershipStatus === "MEMBER") {
      skipped.push({ id: g.id, name: g.name, reason: g.postReasons.length ? g.postReasons.join("; ") : g.enabledForDistribution ? "inte postbar" : "avstängd i panelen" });
    }
  }
  const selected: GroupSelection[] = [];
  for (const g of pool) {
    if (opts.blockedGroupIds?.has(g.id)) {
      skipped.push({ id: g.id, name: g.name, reason: "olöst manuell åtgärd på gruppen" });
      continue;
    }
    if (g.linksProhibited) {
      skipped.push({ id: g.id, name: g.name, reason: "reglerna förbjuder länkar" });
      continue;
    }
    const geo = detectGeography(`${g.name} ${g.geography ?? ""}`);
    if (geo.score === 0) {
      skipped.push({ id: g.id, name: g.name, reason: `annan stad (${geo.geography})` });
      continue;
    }
    if (g.category === "BRAND_COMMUNITY" && !brandInName(listing.brand, g.name)) {
      skipped.push({ id: g.id, name: g.name, reason: "märkesgrupp för ett annat märke" });
      continue;
    }
    const cooldownHours = Math.max(g.postCooldownHours ?? 0, opts.defaultCooldownHours);
    if (g.lastPostedAt && now.getTime() - Date.parse(g.lastPostedAt) < cooldownHours * 3_600_000) {
      skipped.push({ id: g.id, name: g.name, reason: `Loopa postade där för mindre än ${cooldownHours} timmar sedan` });
      continue;
    }
    const reasons: string[] = [`relevans ${g.relevanceScore}`];
    let score = g.relevanceScore;
    if (g.category === "FURNITURE_BUY_SELL") {
      score += 10;
      reasons.push("möbelspecifik köp/sälj-grupp: +10");
    }
    if (brandInName(listing.brand, g.name)) {
      score += 15;
      reasons.push(`${listing.brand} i gruppnamnet: +15`);
    }
    if (geo.score >= 0.9) {
      score += 5;
      reasons.push(`${geo.geography} — samma region som möbeln: +5`);
    }
    selected.push({ group: g, score, reasons });
  }
  selected.sort((a, b) => b.score - a.score || (b.group.memberCount ?? 0) - (a.group.memberCount ?? 0) || a.group.id.localeCompare(b.group.id));
  const max = Math.max(0, Math.floor(opts.max));
  for (const cut of selected.slice(max)) skipped.push({ id: cut.group.id, name: cut.group.name, reason: `över taket ${max} grupper per annons` });
  return { selected: selected.slice(0, max), skipped };
}

/** Grupperna en ny annons ska ut i: medlem, postbar, påslagen. Bäst först. */
export function distributionTargets(groups: FacebookGroup[], maxGroups: number): FacebookGroup[] {
  return groups
    .filter((g) => g.membershipStatus === "MEMBER" && g.postEligible && g.enabledForDistribution)
    .sort((a, b) => b.relevanceScore - a.relevanceScore || (b.memberCount ?? 0) - (a.memberCount ?? 0))
    .slice(0, Math.max(0, maxGroups));
}

/** Ska vakten titta på gruppen nu? Väntande ansökningar, inte oftare än intervallet. */
export function shouldRecheckMembership(group: FacebookGroup, intervalMinutes: number, now: Date = new Date()): boolean {
  if (!PENDING_STATUSES.includes(group.membershipStatus)) return false;
  if (!group.membershipLastCheckedAt) return true;
  return now.getTime() - Date.parse(group.membershipLastCheckedAt) >= intervalMinutes * 60_000;
}

/** Är automatiska ansökningar på just nu? Miljön OCH panelens pausknapp måste båda säga ja. */
export function autoJoinActive(envAutoJoin: boolean, settings: Pick<FacebookSettings, "autoJoinPaused">): boolean {
  return envAutoJoin && !settings.autoJoinPaused;
}

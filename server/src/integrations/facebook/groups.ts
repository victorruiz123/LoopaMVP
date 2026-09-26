/**
 * Gruppadresser, gruppnycklar och sammanslagning — allt rent, ingen webbläsare.
 *
 * EN GRUPP, EN POST. Facebook skriver samma grupp på fem sätt: `/groups/123/`, `/groups/123/about`,
 * `m.facebook.com/groups/slug?ref=…`, `web.facebook.com/groups/Slug/permalink/…`. Nyckeln nedan kokar
 * dem alla ner till en sträng, och det är den lagret använder som id. Utan den hade varje sökning
 * skapat dubbletter, och dubbletter är hur samma annons hamnar två gånger i samma grupp.
 */

import type { FacebookGroup, GroupCategory } from "./types.js";

/** Sökvägar under /groups/ som inte är grupper. */
const RESERVED = new Set(["feed", "discover", "joins", "search", "create", "notifications", "your_groups", "browse", "category", "explore"]);

/**
 * Gruppnyckeln ur en adress: det numeriska id:t, eller slugen i gemener. Null när adressen inte pekar
 * på en grupp.
 */
export function groupKeyFromUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`);
  } catch {
    return null;
  }
  if (!/(^|\.)facebook\.com$/i.test(url.hostname) && !/^(127\.0\.0\.1|localhost)$/.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/groups\/([^/?#]+)/i);
  if (!m) return null;
  const key = decodeURIComponent(m[1]).trim();
  if (!key || RESERVED.has(key.toLowerCase())) return null;
  return /^\d+$/.test(key) ? key : key.toLowerCase();
}

/** Den kanoniska adressen: alltid www, alltid avslutande snedstreck, aldrig frågesträng. */
export function canonicalGroupUrl(raw: string, base = "https://www.facebook.com"): string | null {
  const key = groupKeyFromUrl(raw);
  return key ? `${base.replace(/\/+$/, "")}/groups/${key}/` : null;
}

export function isNumericGroupId(key: string): boolean {
  return /^\d+$/.test(key);
}

/** "1,2 tn medlemmar" -> 1200, "97,4 tn members" -> 97400, "1 152 medlemmar" -> 1152, "12K members" -> 12000. */
export function parseMemberCount(text: string): number | null {
  const m = text.match(/([\d][\d\s.,]*)\s*(tn|k)?\s*(medlemmar|members)\b/i);
  if (!m?.[1]) return null;
  const raw = m[1].trim();
  const unit = (m[2] ?? "").toLowerCase();
  let n: number;
  if (unit) n = Number(raw.replace(/\s/g, "").replace(",", ".")) * 1000;
  else n = Number(raw.replace(/[\s.,]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** En träff ur sökningen eller en gruppsida, innan den blivit en post i lagret. */
export interface GroupHit {
  url: string;
  name: string;
  memberCount: number | null;
  visibility: FacebookGroup["visibility"];
  snippet: string;
  query: string;
}

/** Unika träffar per gruppnyckel. Första namnet vinner; medlemsantalet fylls på från vilken träff som helst. */
export function dedupeHits(hits: GroupHit[]): GroupHit[] {
  const byKey = new Map<string, GroupHit>();
  for (const hit of hits) {
    const key = groupKeyFromUrl(hit.url);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...hit, url: canonicalGroupUrl(hit.url)! });
      continue;
    }
    byKey.set(key, {
      ...existing,
      memberCount: existing.memberCount ?? hit.memberCount,
      visibility: existing.visibility === "UNKNOWN" ? hit.visibility : existing.visibility,
      snippet: existing.snippet.length >= hit.snippet.length ? existing.snippet : hit.snippet,
    });
  }
  return [...byKey.values()];
}

/** En ny grupp med alla förval. Poängen och kategorin sätts av ranking.ts efteråt. */
export function newGroup(input: {
  key: string;
  name: string;
  canonicalUrl: string;
  category?: GroupCategory;
  geography?: string;
  visibility?: FacebookGroup["visibility"];
  memberCount?: number | null;
  discoveredVia?: string[];
  now?: string;
}): FacebookGroup {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.key,
    facebookGroupId: input.key,
    name: input.name,
    canonicalUrl: input.canonicalUrl,
    category: input.category ?? "OTHER",
    geography: input.geography ?? "",
    visibility: input.visibility ?? "UNKNOWN",
    memberCount: input.memberCount ?? null,
    relevanceScore: 0,
    activityScore: 0,
    rankingReasons: [],
    rulesText: null,
    aboutText: null,
    rulesLastCheckedAt: null,
    rulesEvidence: [],
    adsStatus: "UNCLEAR",
    composerKind: null,
    membershipStatus: "UNKNOWN",
    membershipDetail: null,
    joinEligible: false,
    joinReasons: [],
    postEligible: false,
    postReasons: [],
    enabledForDistribution: false,
    enabledForDistributionSetBy: null,
    joinAttempts: 0,
    joinRequestedAt: null,
    joinedAt: null,
    membershipLastCheckedAt: null,
    lastPostedAt: null,
    lastValidatedAt: null,
    questions: [],
    history: [],
    discoveredVia: input.discoveredVia ?? [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Slår ihop en ny observation med en befintlig post.
 *
 * SKRIV ALDRIG ÖVER ETT KÄNT VÄRDE MED NULL, och rör aldrig det en admin bestämt (brytaren för
 * distribution) eller det tillståndsmaskinen äger (medlemskapet, historiken). Det som får uppdateras
 * fritt är det Facebook själv visar: namn, medlemsantal, synlighet.
 */
export function mergeObservation(
  existing: FacebookGroup,
  incoming: Partial<Pick<FacebookGroup, "name" | "memberCount" | "visibility" | "aboutText" | "rulesText" | "composerKind" | "discoveredVia">>,
): FacebookGroup {
  return {
    ...existing,
    name: incoming.name?.trim() || existing.name,
    memberCount: incoming.memberCount ?? existing.memberCount,
    visibility: incoming.visibility && incoming.visibility !== "UNKNOWN" ? incoming.visibility : existing.visibility,
    aboutText: incoming.aboutText ?? existing.aboutText,
    rulesText: incoming.rulesText ?? existing.rulesText,
    composerKind: incoming.composerKind ?? existing.composerKind,
    discoveredVia: [...new Set([...existing.discoveredVia, ...(incoming.discoveredVia ?? [])])],
  };
}

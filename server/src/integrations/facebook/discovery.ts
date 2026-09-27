/**
 * Upptäckten: riktiga Facebook-sökningar -> grupper i lagret -> validering av regler och läge.
 *
 * TVÅ STEG, BÅDA LÄSNING. `runDiscovery` söker på frågorna i queries.ts och skriver träffarna som
 * grupper — kategoriserade och rangordnade på det som syns i sökresultatet. `validateGroups` öppnar
 * gruppsidan och Om-sidan för de grupper som inte validerats (eller vars regler är gamla), läser
 * medlemsantal, synlighet, skrivruta, regler och vårt eget medlemskap, och räknar om poängen.
 *
 * INGA ADRESSER HITTAS PÅ. Allt som skrivs i lagret har lästs ur en Facebook-sida. Det är det som
 * gör att en grupp i panelen går att lita på — den finns, och det står vad vi såg där.
 */

import type { Page } from "playwright";
import { facebookLimits } from "./config.js";
import { FacebookInterrupt } from "./checkpoint.js";
import { canonicalGroupUrl, dedupeHits, groupKeyFromUrl, mergeObservation, newGroup, parseMemberCount, type GroupHit } from "./groups.js";
import { applyMembership, refreshEligibility } from "./membership.js";
import { nextQueries } from "./queries.js";
import { activityFromFeed, classifyGroup, compareGroups, detectGeography, rankGroup } from "./ranking.js";
import { assessRules, extractRulesSection } from "./rules.js";
import { FB, TEXT } from "./selectors.js";
import { assertNoInterrupt, fbUrl, goto, recordInterrupt, screenshot, withFacebookBrowser } from "./session.js";
import { allGroups, getGroup, logEvent, putGroup, readDiscoveryState, readSettings, updateGroup, writeDiscoveryState } from "./store.js";
import type { ComposerKind, FacebookGroup, GroupVisibility, MembershipStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Sökningen
// ---------------------------------------------------------------------------

/** En sökning på riktiga Facebook. Läser gruppkorten i resultatet; skapar ingenting. */
export async function searchGroups(page: Page, query: string, limit = 25): Promise<GroupHit[]> {
  await goto(page, fbUrl(`/search/groups/?q=${encodeURIComponent(query)}`), `sökning "${query}"`);
  await page.locator(FB.searchGroupLinks).first().waitFor({ state: "attached", timeout: 20_000 }).catch(() => undefined);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 2200);
    await page.waitForTimeout(900);
  }
  await assertNoInterrupt(page, `sökning "${query}" (efter rullning)`);

  const raw = await page.evaluate((max: number) => {
    const out: Array<{ name: string; url: string; snippet: string }> = [];
    const seen = new Set<string>();
    const anchors = Array.from(document.querySelectorAll('[role="main"] a[href*="/groups/"]')) as HTMLAnchorElement[];
    for (const a of anchors) {
      const m = a.href.match(/\/groups\/([^/?#]+)/);
      if (!m || !m[1]) continue;
      const key = m[1].toLowerCase();
      if (["feed", "discover", "joins", "search", "create", "notifications", "your_groups"].includes(key)) continue;
      const name = (a.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!name || name.length < 3 || seen.has(key)) continue;
      seen.add(key);
      const container = a.closest('[role="article"]') ?? a.parentElement?.parentElement?.parentElement?.parentElement ?? a.parentElement;
      out.push({ name, url: a.href, snippet: (container?.textContent ?? "").replace(/\s+/g, " ").slice(0, 400) });
      if (out.length >= max) break;
    }
    return out;
  }, limit);

  return dedupeHits(
    raw.map((h) => ({
      url: h.url,
      name: h.name,
      memberCount: parseMemberCount(h.snippet),
      visibility: TEXT.publicGroup.test(h.snippet) ? "PUBLIC" : TEXT.privateGroup.test(h.snippet) ? "PRIVATE" : "UNKNOWN",
      snippet: h.snippet,
      query,
    })),
  );
}

/** En träff blir en grupp i lagret, eller uppdaterar den som finns. Kategori och poäng sätts direkt. */
export async function upsertHit(hit: GroupHit): Promise<{ group: FacebookGroup; created: boolean }> {
  const key = groupKeyFromUrl(hit.url);
  const url = canonicalGroupUrl(hit.url);
  if (!key || !url) throw new Error(`Inte en gruppadress: ${hit.url}`);
  const limits = facebookLimits();
  const existing = await getGroup(key);
  if (existing) {
    const merged = mergeObservation(existing, { name: hit.name, memberCount: hit.memberCount, visibility: hit.visibility, discoveredVia: [hit.query] });
    const saved = await putGroup(rescore(merged, limits));
    return { group: saved, created: false };
  }
  const { category, reasons } = classifyGroup(hit.name, hit.snippet);
  const geo = detectGeography(hit.name);
  const fresh = newGroup({ key, name: hit.name, canonicalUrl: url, category, geography: geo.geography, visibility: hit.visibility, memberCount: hit.memberCount, discoveredVia: [hit.query] });
  fresh.rankingReasons = reasons;
  const saved = await putGroup(rescore(fresh, limits));
  return { group: saved, created: true };
}

/** Räknar om relevans, skäl och behörigheter ur det gruppen bär just nu. */
export function rescore(group: FacebookGroup, limits = facebookLimits()): FacebookGroup {
  const { category, reasons } = classifyGroup(group.name, group.aboutText);
  const geo = detectGeography(`${group.name} ${group.geography}`);
  const rank = rankGroup({
    name: group.name,
    category,
    geography: group.geography || geo.geography,
    memberCount: group.memberCount,
    adsStatus: group.adsStatus,
    composerKind: group.composerKind,
    activityScore: group.activityScore,
    about: group.aboutText,
  });
  return refreshEligibility(
    {
      ...group,
      category,
      geography: group.geography || geo.geography,
      relevanceScore: rank.relevanceScore,
      rankingReasons: [...reasons, ...rank.reasons],
    },
    limits,
  );
}

// ---------------------------------------------------------------------------
// Medlemskapen kontot redan har — Facebooks EGEN lista, inte vår gissning
// ---------------------------------------------------------------------------

/**
 * Facebooks egen sida över grupperna kontot gått med i. En annan yta än sökningen
 * (searchGroups): ingen fråga, bara rullning tills inga fler kort laddas. Samma
 * gruppkorts-mönster som sökresultatet (VERIFIERAT gäller sökningen 2026-09-23; den
 * här sidan är ANTAGEN tills en riktig körning bekräftat den — se docs/facebook.md).
 */
export async function listJoinedGroups(page: Page, opts: { maxScrolls?: number; stableRoundsToStop?: number } = {}): Promise<GroupHit[]> {
  await goto(page, fbUrl("/groups/joins/"), "dina grupper (medlemslistan)");
  await assertNoInterrupt(page, "dina grupper");

  const maxScrolls = opts.maxScrolls ?? 60;
  const stableRoundsToStop = opts.stableRoundsToStop ?? 3;
  let stableRounds = 0;
  let lastCount = -1;
  for (let i = 0; i < maxScrolls; i++) {
    const count = await page.locator(FB.searchGroupLinks).count().catch(() => 0);
    if (count === lastCount) {
      stableRounds += 1;
      if (stableRounds >= stableRoundsToStop) break;
    } else {
      stableRounds = 0;
      lastCount = count;
    }
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(900 + Math.floor(Math.random() * 700));
    await assertNoInterrupt(page, "dina grupper (rullning)");
  }

  const raw = await page.evaluate(() => {
    const out: Array<{ name: string; url: string; snippet: string }> = [];
    const seen = new Set<string>();
    const anchors = Array.from(document.querySelectorAll('[role="main"] a[href*="/groups/"]')) as HTMLAnchorElement[];
    for (const a of anchors) {
      const m = a.href.match(/\/groups\/([^/?#]+)/);
      if (!m || !m[1]) continue;
      const key = m[1].toLowerCase();
      if (["feed", "discover", "joins", "search", "create", "notifications", "your_groups", "browse", "category", "explore"].includes(key)) continue;
      const name = (a.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!name || name.length < 2 || seen.has(key)) continue;
      seen.add(key);
      const container = a.closest('[role="article"]') ?? a.parentElement?.parentElement?.parentElement?.parentElement ?? a.parentElement;
      out.push({ name, url: a.href, snippet: (container?.textContent ?? "").replace(/\s+/g, " ").slice(0, 400) });
    }
    return out;
  });

  return dedupeHits(
    raw.map((h) => ({
      url: h.url,
      name: h.name,
      memberCount: parseMemberCount(h.snippet),
      visibility: TEXT.publicGroup.test(h.snippet) ? "PUBLIC" : TEXT.privateGroup.test(h.snippet) ? "PRIVATE" : "UNKNOWN",
      snippet: h.snippet,
      query: "dina grupper",
    })),
  );
}

/**
 * En träff från DINA GRUPPER blir MEDLEM direkt — det är inte en gissning, Facebook visade den i
 * kontots egen medlemslista. Samma sammanslagning som upsertHit, men medlemskapet sätts genom
 * tillståndsmaskinen (membership.ts) i stället för att lämnas UNKNOWN till en senare validering.
 */
async function upsertOwnMembership(hit: GroupHit, limits = facebookLimits()): Promise<{ group: FacebookGroup; created: boolean; becameMember: boolean }> {
  const key = groupKeyFromUrl(hit.url);
  const url = canonicalGroupUrl(hit.url);
  if (!key || !url) throw new Error(`Inte en gruppadress: ${hit.url}`);
  const now = new Date().toISOString();
  const detail = "Kontot är medlem (funnen i Facebooks egen lista över dina grupper).";
  const existing = await getGroup(key);
  if (existing) {
    let merged = mergeObservation(existing, { name: hit.name, memberCount: hit.memberCount, visibility: hit.visibility, discoveredVia: [hit.query] });
    const wasMember = merged.membershipStatus === "MEMBER";
    if (!wasMember) {
      try {
        merged = applyMembership(merged, "MEMBER", detail, { at: now });
      } catch {
        // En övergång tillståndsmaskinen inte tillåter lämnas som den var — syns i loggen som avvikelse.
      }
    }
    const saved = await putGroup(rescore(merged, limits));
    return { group: saved, created: false, becameMember: !wasMember && saved.membershipStatus === "MEMBER" };
  }
  const { category, reasons } = classifyGroup(hit.name, hit.snippet);
  const geo = detectGeography(hit.name);
  let fresh = newGroup({ key, name: hit.name, canonicalUrl: url, category, geography: geo.geography, visibility: hit.visibility, memberCount: hit.memberCount, discoveredVia: [hit.query] });
  fresh.rankingReasons = reasons;
  fresh = applyMembership(fresh, "MEMBER", detail, { at: now });
  const saved = await putGroup(rescore(fresh, limits));
  return { group: saved, created: true, becameMember: true };
}

export interface MembershipSyncResult {
  found: number;
  newGroups: number;
  updatedGroups: number;
  markedMember: number;
  alreadyMember: number;
  stoppedBy: string | null;
}

/**
 * Synkar HELA kontots medlemslista in i lagret — läsning, inget klickas. Det här är svaret på "vilka
 * grupper är kontot redan med i", oberoende av vad sökningen (runDiscovery) råkat hitta förut.
 */
export async function syncOwnMemberships(): Promise<MembershipSyncResult> {
  const limits = facebookLimits();
  const result: MembershipSyncResult = { found: 0, newGroups: 0, updatedGroups: 0, markedMember: 0, alreadyMember: 0, stoppedBy: null };
  await withFacebookBrowser("membership-sync", async ({ page }) => {
    try {
      const hits = await listJoinedGroups(page);
      result.found = hits.length;
      for (const hit of hits) {
        const { created, becameMember } = await upsertOwnMembership(hit, limits);
        if (created) result.newGroups += 1;
        else result.updatedGroups += 1;
        if (becameMember) result.markedMember += 1;
        else result.alreadyMember += 1;
      }
      await logEvent({ worker: "membership-sync", level: "ok", action: "SYNKAD", target: null, detail: `${result.found} grupper i Facebooks lista: ${result.newGroups} nya, ${result.markedMember} nya medlemskap.` });
    } catch (err) {
      if (err instanceof FacebookInterrupt) {
        await recordInterrupt(err, { worker: "membership-sync" }, "dina grupper");
        result.stoppedBy = err.message;
        return;
      }
      throw err;
    }
  });
  return result;
}

export interface DiscoveryRunResult {
  queries: string[];
  hits: number;
  newGroups: number;
  updatedGroups: number;
  stoppedBy: string | null;
}

/**
 * Ett upptäcktsvarv: nästa handfull frågor ur listan, sökta på riktigt. Stannar vid första avbrott.
 * Skriver var det slutade så nästa varv fortsätter där.
 */
export async function runDiscovery(opts: { queries?: string[]; limitPerQuery?: number; force?: boolean } = {}): Promise<DiscoveryRunResult> {
  const settings = await readSettings();
  if (settings.discoveryPaused && !opts.force) {
    return { queries: [], hits: 0, newGroups: 0, updatedGroups: 0, stoppedBy: "Upptäckten är pausad i panelen." };
  }
  const limits = facebookLimits();
  const state = await readDiscoveryState();
  const planned = opts.queries?.length ? { queries: opts.queries, nextCursor: state.queryCursor } : nextQueries(state.queryCursor, limits.discoveryQueriesPerRun);

  const result: DiscoveryRunResult = { queries: [], hits: 0, newGroups: 0, updatedGroups: 0, stoppedBy: null };
  await withFacebookBrowser("discovery", async ({ page }) => {
    for (const query of planned.queries) {
      try {
        const hits = await searchGroups(page, query, opts.limitPerQuery ?? 25);
        result.queries.push(query);
        result.hits += hits.length;
        for (const hit of hits) {
          const { created } = await upsertHit(hit);
          if (created) result.newGroups += 1;
          else result.updatedGroups += 1;
        }
        await logEvent({ worker: "discovery", level: "ok", action: "SÖKNING", target: query, detail: `${hits.length} grupper i resultatet` });
        await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
      } catch (err) {
        if (err instanceof FacebookInterrupt) {
          await recordInterrupt(err, { worker: "discovery" }, `sökning "${query}"`);
          result.stoppedBy = err.message;
          break;
        }
        await logEvent({ worker: "discovery", level: "warning", action: "SÖKNING FÖLL", target: query, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  await writeDiscoveryState({
    lastRunAt: new Date().toISOString(),
    queryCursor: opts.queries?.length ? state.queryCursor : planned.nextCursor,
    runs: [...state.runs, { at: new Date().toISOString(), queries: result.queries, hits: result.hits, newGroups: result.newGroups }],
  });
  return result;
}

// ---------------------------------------------------------------------------
// Gruppsidan
// ---------------------------------------------------------------------------

export interface GroupSnapshot {
  exists: boolean;
  finalUrl: string;
  name: string | null;
  memberCount: number | null;
  visibility: GroupVisibility;
  membership: MembershipStatus | null;
  composerKind: ComposerKind;
  recentPostCount: number;
  aboutText: string | null;
  rulesText: string | null;
  hasRulesSection: boolean;
  joinBlockedText: boolean;
}

/** Läser gruppsidan och Om-sidan. Ingenting klickas utom navigering. */
export async function inspectGroup(page: Page, url: string): Promise<GroupSnapshot> {
  await goto(page, url, `gruppsida ${url}`);
  const main = page.locator(FB.main).first();
  const header = (await main.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 3000);
  const finalUrl = page.url();
  const empty: GroupSnapshot = {
    exists: false,
    finalUrl,
    name: null,
    memberCount: null,
    visibility: "UNKNOWN",
    membership: null,
    composerKind: "none",
    recentPostCount: 0,
    aboutText: null,
    rulesText: null,
    hasRulesSection: false,
    joinBlockedText: false,
  };
  if (TEXT.notAvailable.test(header) || !/\/groups\//.test(finalUrl)) return empty;

  const name = (await page.locator(FB.groupTitle).first().innerText().catch(() => "")).replace(/\s+/g, " ").trim() || null;
  const memberCount = parseMemberCount(header);
  const visibility: GroupVisibility = TEXT.publicGroup.test(header) ? "PUBLIC" : TEXT.privateGroup.test(header) ? "PRIVATE" : "UNKNOWN";

  let membership: MembershipStatus | null = null;
  if (TEXT.member.test(header) || (await page.locator(FB.memberIndicator).count()) > 0) membership = "MEMBER";
  else if (TEXT.pending.test(header) || (await page.locator(FB.pendingIndicator).count()) > 0) membership = "PENDING_APPROVAL";
  else if (TEXT.notMember.test(header) || (await page.locator(FB.joinButton).count()) > 0) membership = "NOT_MEMBER";

  const hasPost = (await page.locator(FB.composerPost).count()) > 0;
  const hasListing = (await page.locator(FB.composerListing).count()) > 0;
  const composerKind: ComposerKind = hasPost ? "post" : hasListing ? "listing" : "none";
  const recentPostCount = await page.locator(FB.feedArticle).filter({ has: page.locator(FB.feedAuthorLink) }).count().catch(() => 0);

  let aboutText: string | null = null;
  let rulesText: string | null = null;
  let hasRulesSection = false;
  try {
    await goto(page, url.replace(/\/?(\?.*)?$/, "/about"), `om-sida ${url}`);
    const about = (await page.locator(FB.main).first().innerText().catch(() => "")).trim();
    aboutText = about.slice(0, 8000) || null;
    const section = extractRulesSection(about);
    rulesText = section.rules;
    hasRulesSection = section.hasRulesSection;
  } catch (err) {
    if (err instanceof FacebookInterrupt) throw err;
  }

  return {
    exists: true,
    finalUrl,
    name,
    memberCount,
    visibility,
    membership,
    composerKind,
    recentPostCount,
    aboutText,
    rulesText,
    hasRulesSection,
    joinBlockedText: TEXT.joinBlocked.test(header),
  };
}

/**
 * Skriver in det gruppsidan visade: observationerna, reglerna, poängen — och medlemskapet, när
 * övergången är tillåten. Ett medlemskap som redan finns (kontot gick med tidigare, för hand) blir
 * MEMBER här utan att någon knapp tryckts.
 */
export async function applySnapshot(group: FacebookGroup, snap: GroupSnapshot, opts: { screenshot?: string | null } = {}): Promise<FacebookGroup> {
  const limits = facebookLimits();
  const now = new Date().toISOString();
  let next = mergeObservation(group, {
    name: snap.name ?? undefined,
    memberCount: snap.memberCount,
    visibility: snap.visibility,
    aboutText: snap.aboutText,
    rulesText: snap.rulesText,
    composerKind: snap.composerKind,
  });
  const { category } = classifyGroup(next.name, next.aboutText);
  const rules = assessRules(snap.rulesText, category, next.name);
  next = {
    ...next,
    category,
    adsStatus: rules.adsStatus,
    rulesEvidence: rules.evidence,
    linksProhibited: rules.linksProhibited,
    postCooldownHours: rules.postCooldownHours,
    rulesLastCheckedAt: now,
    lastValidatedAt: now,
    activityScore: activityFromFeed(snap.recentPostCount, snap.memberCount),
  };
  if (snap.membership && next.membershipStatus !== snap.membership) {
    const detail =
      snap.membership === "MEMBER"
        ? "Kontot är medlem (avläst på gruppsidan)."
        : snap.membership === "PENDING_APPROVAL"
          ? "En ansökan väntar på godkännande (avläst på gruppsidan)."
          : "Kontot är inte medlem (Gå med-knappen syns).";
    try {
      next = applyMembership(next, snap.membership, detail, { at: now, screenshot: opts.screenshot ?? null });
    } catch {
      // En övergång tabellen inte tillåter (t.ex. QUESTIONS_REQUIRED -> NOT_MEMBER) lämnas åt vakten.
      next = { ...next, membershipLastCheckedAt: now };
    }
  } else if (snap.membership) {
    next = { ...next, membershipLastCheckedAt: now };
  }
  if (snap.joinBlockedText && !["MEMBER", "PENDING_APPROVAL"].includes(next.membershipStatus)) {
    try {
      next = applyMembership(next, "JOIN_BLOCKED", "Facebook säger att gruppen inte tar emot nya medlemmar.", { at: now });
    } catch {
      // Lämnas.
    }
  }
  return rescore(next, limits);
}

export interface ValidationRunResult {
  validated: string[];
  gone: string[];
  stoppedBy: string | null;
}

/**
 * Öppnar gruppsidorna för de grupper som saknar validering, eller vars regler blivit gamla, bäst
 * rangordnade först. `max` grupper per varv — varje grupp är två sidladdningar.
 */
export async function validateGroups(opts: { max?: number; groupIds?: string[]; staleHours?: number } = {}): Promise<ValidationRunResult> {
  const limits = facebookLimits();
  const staleMs = (opts.staleHours ?? limits.rulesMaxAgeHours) * 3_600_000;
  const now = Date.now();
  const groups = await allGroups();
  const candidates = (opts.groupIds
    ? groups.filter((g) => opts.groupIds!.includes(g.id))
    : groups.filter((g) => !g.lastValidatedAt || now - Date.parse(g.lastValidatedAt) > staleMs).sort(compareGroups)
  ).slice(0, opts.max ?? 6);

  const result: ValidationRunResult = { validated: [], gone: [], stoppedBy: null };
  if (candidates.length === 0) return result;

  await withFacebookBrowser("validation", async ({ page }) => {
    for (const group of candidates) {
      try {
        const snap = await inspectGroup(page, group.canonicalUrl);
        if (!snap.exists) {
          result.gone.push(group.id);
          await updateGroup(group.id, (g) => ({ ...g, lastValidatedAt: new Date().toISOString(), rankingReasons: [...g.rankingReasons, "gruppsidan är inte tillgänglig"], relevanceScore: 0 }));
          await logEvent({ worker: "validation", level: "warning", action: "GRUPP SAKNAS", target: group.id, detail: `${group.name}: sidan svarar att innehållet inte är tillgängligt.` });
          continue;
        }
        const shot = await screenshot(page, `grupp_${group.id}`);
        const current = (await getGroup(group.id)) ?? group;
        const next = await applySnapshot(current, snap, { screenshot: shot });
        await putGroup(next);
        result.validated.push(group.id);
        await logEvent({
          worker: "validation",
          level: "ok",
          action: "VALIDERAD",
          target: group.id,
          detail: `${next.name}: ${next.memberCount ?? "?"} medlemmar, ${next.visibility}, regler ${next.adsStatus}, medlemskap ${next.membershipStatus}, relevans ${next.relevanceScore}.`,
        });
        await page.waitForTimeout(1200 + Math.floor(Math.random() * 1200));
      } catch (err) {
        if (err instanceof FacebookInterrupt) {
          await recordInterrupt(err, { worker: "validation", groupId: group.id }, `validering ${group.canonicalUrl}`);
          result.stoppedBy = err.message;
          break;
        }
        await logEvent({ worker: "validation", level: "warning", action: "VALIDERING FÖLL", target: group.id, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  return result;
}

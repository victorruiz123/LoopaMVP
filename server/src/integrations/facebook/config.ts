/**
 * Facebook-distributionens inställningar, lästa VID ANROP.
 *
 * Samma regel som blocket.ts och tradera.ts, av samma skäl: server.ts kallar `loadEnvFile` i sin
 * modulkropp, och ESM kör alla importerade moduler före den — en konstant här hade aldrig sett
 * server/.env.
 *
 * FÖRVALEN ÄR DE FÖRSIKTIGA. Integrationen är AV tills FACEBOOK_ENABLED=1 sätts, varje körning är en
 * TORRKÖRNING tills FACEBOOK_DRY_RUN=false sätts uttryckligen, och automatiska medlemsansökningar är
 * av tills FACEBOOK_AUTO_JOIN=1. En utrullning av den här koden ändrar därför ingenting i drift förrän
 * någon bestämt sig.
 *
 * Gränserna nedan är SKYDDSRÄCKEN mot att en bugg skriver för mycket på en riktig plattform — inte ett
 * sätt att undvika upptäckt. Koden gör ingenting för att dölja att den är automatiserad.
 */

import path from "node:path";
import { DATA_DIR } from "../../jobStore.js";

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function tal(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Hela integrationen. Av = inga bakgrundsarbetare startar, inga köposter skrivs. */
export function facebookEnabled(): boolean {
  return flag("FACEBOOK_ENABLED", false);
}

/**
 * `live` = riktiga facebook.com. `mock` = attrappen i tests/ (FACEBOOK_BASE_URL måste då peka dit),
 * och då tillåts aldrig ett anrop mot facebook.com — se `isRealFacebook`.
 */
export function facebookMode(): "live" | "mock" {
  return process.env.FACEBOOK_MODE?.trim().toLowerCase() === "mock" ? "mock" : "live";
}

/**
 * TORRKÖRNING ÄR FÖRVALET. Bara ett uttryckligt FACEBOOK_DRY_RUN=false (eller 0) gör att sista knappen
 * trycks. Torrkörningen använder ändå riktiga Facebook för allt som är LÄSNING — sökning, regler,
 * medlemskap, formulärvalidering — och stannar precis före den externa skrivningen.
 */
export function facebookDryRun(): boolean {
  return flag("FACEBOOK_DRY_RUN", true);
}

export function facebookAutoDiscover(): boolean {
  return flag("FACEBOOK_AUTO_DISCOVER", true);
}

/** Automatiska medlemsansökningar. Av som förval — det är en riktig skrivning på plattformen. */
export function facebookAutoJoin(): boolean {
  return flag("FACEBOOK_AUTO_JOIN", false);
}

export function facebookMarketplaceEnabled(): boolean {
  return flag("FACEBOOK_MARKETPLACE_ENABLED", true);
}

export function facebookGroupPublishingEnabled(): boolean {
  return flag("FACEBOOK_GROUP_PUBLISHING_ENABLED", true);
}

/**
 * Det Facebook-konto profilen SKA vara inloggad på (kontots numeriska id). Satt = webbläsaren vägrar
 * köra med något annat konto i profilen. Tom = ingen kontroll. Två konton med samma namn på samma
 * maskin är precis det som hände 2026-09-25; det här är räcket mot att det händer igen.
 */
export function facebookAccountId(): string | null {
  return process.env.FACEBOOK_ACCOUNT_ID?.trim() || null;
}

/** Synlig webbläsare. Behövs för inloggningen och för att titta på en torrkörning. */
export function facebookHeadful(): boolean {
  return flag("FACEBOOK_HEADFUL", false);
}

/** Katalogen för lagret: grupper, köer, session, skärmbilder. FACEBOOK_DATA_DIR pekar om den (testerna). */
export function facebookDataDir(): string {
  return process.env.FACEBOOK_DATA_DIR?.trim() || path.join(DATA_DIR, "facebook");
}

/**
 * Den inloggade webbläsarprofilen. Skapas av `npm run facebook:login`. Ligger under server/data och är
 * därmed gitignorerad — inloggade kakor hör aldrig hemma i historiken.
 */
export function facebookProfileDir(): string {
  const raw = process.env.FACEBOOK_PROFILE_DIR?.trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return path.join(facebookDataDir(), "profile");
}

export function facebookScreenshotDir(): string {
  return path.join(facebookDataDir(), "screenshots");
}

/** Adressen till Facebook. Pekas om till attrappen i tests/ med FACEBOOK_BASE_URL. */
export function facebookBaseUrl(): string {
  return (process.env.FACEBOOK_BASE_URL?.trim() || "https://www.facebook.com").replace(/\/+$/, "");
}

/** Sant bara mot riktiga facebook.com. */
export function isRealFacebook(): boolean {
  try {
    return /(^|\.)facebook\.com$/i.test(new URL(facebookBaseUrl()).hostname);
  } catch {
    return false;
  }
}

/** Skyddsräcken. Konservativa tal; se kommentaren överst. */
export interface FacebookLimits {
  maxJoinsPerDay: number;
  maxGroupPostsPerDay: number;
  maxMarketplacePerDay: number;
  /** Minsta paus mellan två skrivningar (join, post, publicera), i sekunder. */
  minSecondsBetweenWrites: number;
  /**
   * Taket för hur många grupper en enskild annons SOM MEST distribueras till — en nödbroms, inte
   * produktmålet. Produktmålet är att posta i VARJE grupp som är relevant och tillåten (se
   * selectGroupsForListing: medlem, postbar, rätt stad, ingen spärr, ingen paus). Förvalet ska därför
   * ligga gott över den verkliga gruppoolen (VERIFIERAT 2026-09-27) — panelens inställning kan sätta
   * ett lägre tak för hand om det någonsin behövs.
   */
  maxGroupsPerListing: number;
  /**
   * Minsta tid mellan två Loopa-inlägg i SAMMA grupp, i timmar. En grupps egen regel ("ett inlägg per
   * vecka") vinner när den är strängare — se rules.ts och membership.ts.
   */
  groupCooldownHours: number;
  minRelevanceToJoin: number;
  minMembersToJoin: number;
  /** Hur gamla reglerna får vara innan de läses om före en publicering, i timmar. */
  rulesMaxAgeHours: number;
  discoveryIntervalMinutes: number;
  membershipCheckMinutes: number;
  publishTickSeconds: number;
  /** Så många sökfrågor per upptäcktsvarv. Resten tas nästa varv. */
  discoveryQueriesPerRun: number;
}

export function facebookLimits(): FacebookLimits {
  return {
    maxJoinsPerDay: tal("FACEBOOK_MAX_JOINS_PER_DAY", 3),
    maxGroupPostsPerDay: tal("FACEBOOK_MAX_GROUP_POSTS_PER_DAY", 100),
    maxMarketplacePerDay: tal("FACEBOOK_MAX_MARKETPLACE_PER_DAY", 5),
    minSecondsBetweenWrites: tal("FACEBOOK_MIN_SECONDS_BETWEEN_WRITES", 120),
    maxGroupsPerListing: tal("FACEBOOK_MAX_GROUPS_PER_LISTING", 50),
    groupCooldownHours: tal("FACEBOOK_GROUP_COOLDOWN_HOURS", 24),
    minRelevanceToJoin: tal("FACEBOOK_MIN_RELEVANCE_TO_JOIN", 60),
    minMembersToJoin: tal("FACEBOOK_MIN_MEMBERS_TO_JOIN", 300),
    rulesMaxAgeHours: tal("FACEBOOK_RULES_MAX_AGE_HOURS", 72),
    discoveryIntervalMinutes: tal("FACEBOOK_DISCOVERY_INTERVAL_MINUTES", 720),
    membershipCheckMinutes: tal("FACEBOOK_MEMBERSHIP_CHECK_MINUTES", 360),
    publishTickSeconds: tal("FACEBOOK_PUBLISH_TICK_SECONDS", 60),
    discoveryQueriesPerRun: tal("FACEBOOK_DISCOVERY_QUERIES_PER_RUN", 8),
  };
}

/** Vilka variabler som saknas för att integrationen ska räknas som konfigurerad. */
export function missingFacebookEnv(): string[] {
  return facebookEnabled() ? [] : ["FACEBOOK_ENABLED"];
}

export function facebookConfigured(): boolean {
  return missingFacebookEnv().length === 0;
}

/**
 * Trygg affärs anrop.
 *
 * TVÅ SORTER, och skillnaden är inte en detalj: bedömningen och inbjudan är PUBLIKA och får inte
 * bära något inloggningshuvud — en köpare ska kunna se vad vi säger om annonsen innan de skapar
 * konto, och en säljare ska kunna läsa erbjudandet innan de registrerar sig. Affärsrummet är
 * motsatsen och bär alltid en token.
 */

import { supabase } from "../lib/supabase";
import type { Analysis, DealActions, DealEvent, DealView, PublicInvite, ScanPrefill, VerifiedCard } from "./types";

async function publicJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Anropet misslyckades (${res.status})`);
  return body as T;
}

async function authJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Logga in för att fortsätta.");
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Anropet misslyckades (${res.status})`);
  return body as T;
}

export interface IntakePayload {
  images?: string[];
  adUrl?: string | null;
  description?: string | null;
  askingPriceSek?: number | null;
}

/** Bedöm en annons utan att skapa något. Publik — se filens topp. */
export function analyse(payload: IntakePayload): Promise<Analysis> {
  return publicJson("/api/affar/tolka", { method: "POST", body: JSON.stringify(payload) });
}

/** Skapa affärsrummet. Kräver konto: affären ska ha en ägare. */
export function createDeal(payload: IntakePayload & { postnummer: string }): Promise<{ deal: DealView }> {
  return authJson("/api/affar", { method: "POST", body: JSON.stringify(payload) });
}

export function fetchDeal(id: string): Promise<{
  deal: DealView;
  events: DealEvent[];
  verified: VerifiedCard | null;
  actions: DealActions;
  prefill?: ScanPrefill;
}> {
  return authJson(`/api/affar/${encodeURIComponent(id)}`);
}

/**
 * Acceptera, lägg ett motbud, eller tacka nej.
 *
 * EN väg för alla tre: det är samma beslut med tre utfall, och de ska prövas mot samma tillstånd.
 */
export function actOnPrice(
  id: string,
  handling: "acceptera" | "motbud" | "avbryt",
  belopp?: number,
): Promise<{ deal: DealView; actions: DealActions; verified: VerifiedCard | null }> {
  return authJson(`/api/affar/${encodeURIComponent(id)}/pris`, {
    method: "POST",
    body: JSON.stringify({ handling, belopp }),
  });
}

/**
 * Säljaren går med. Adresseras med TOKEN — säljaren har aldrig sett affärens id, de kom från en länk.
 */
export function joinDeal(token: string): Promise<{ deal: DealView; prefill: ScanPrefill }> {
  return authJson(`/api/affar/ga-med/${encodeURIComponent(token)}`, { method: "POST" });
}

export function fetchMyDeals(): Promise<{ deals: DealView[] }> {
  return authJson("/api/affar");
}

/** Markerar att köparen hämtat sin länk. VI skickar aldrig något till säljaren. */
export function markInvited(id: string): Promise<{ deal: DealView }> {
  return authJson(`/api/affar/${encodeURIComponent(id)}/bjud-in`, { method: "POST" });
}

/** Säljarens vy av inbjudan. Publik: token är åtkomsten. */
export function fetchInvite(token: string): Promise<{ invite: PublicInvite }> {
  return publicJson(`/api/affar/inbjudan/${encodeURIComponent(token)}`);
}

/** Analysen läggs i webbläsaren mellan bedömningen och inloggningen, så den överlever en omväg. */
const STASH_KEY = "loopa.affar.analys";

export function stashAnalysis(payload: IntakePayload, analysis: Analysis): void {
  try {
    // Bilderna följer INTE med. De är stora, de ligger redan på servern under scratchId, och en
    // annons i webbläsarens lagring är precis den sortens spår briefen ber oss låta bli att lämna.
    const { images, ...rest } = payload;
    void images;
    sessionStorage.setItem(STASH_KEY, JSON.stringify({ payload: rest, analysis }));
  } catch {
    // Privat läge eller full lagring. Köparen får göra om bedömningen — inget går sönder.
  }
}

export function takeStashedAnalysis(): { payload: IntakePayload; analysis: Analysis } | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STASH_KEY);
    return JSON.parse(raw) as { payload: IntakePayload; analysis: Analysis };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Köparens analys — samma pipeline som säljflödet
// ---------------------------------------------------------------------------

/** Svaret när en länk startade pipelinen. Analysen kör; klienten pollar på jobbet. */
export interface StartedAnalysis {
  mode: "pipeline";
  jobId: string;
  identity: { brand: string | null; model: string | null };
  submission: { adUrl: string | null; description: string | null; askingPriceSek: number | null; imagePaths: number };
}

/** Startar analysen. Publik: köparen har ännu inte konto. */
export function startAnalysis(adUrl: string): Promise<StartedAnalysis> {
  return publicJson("/api/affar/tolka", { method: "POST", body: JSON.stringify({ adUrl }) });
}

/**
 * Analysjobbet, som köparen ser det.
 *
 * HELA jobbet, inte ett färdigt resultat: köparen går samma skärmar som säljaren — modellförslag,
 * mått, pris — och de läser jobbet allteftersom det fylls i. Ett svar som bara kom när allt var
 * klart hade gjort tre steg till en spinner.
 */
export function analysisJob(jobId: string): Promise<{ job: import("../types").ConditionJob }> {
  return publicJson(`/api/affar/analys/${encodeURIComponent(jobId)}`);
}

/**
 * Köparen anger märket — samma fråga säljaren får först.
 *
 * Behövs när annonsen inte namnger något: pipelinen startar kandidatsökningen bara med ett märke.
 */
export function chooseBrand(jobId: string, marke: string): Promise<{ ok: boolean }> {
  return publicJson(`/api/affar/analys/${encodeURIComponent(jobId)}/marke`, {
    method: "POST",
    body: JSON.stringify({ marke }),
  });
}

/** Köparen väljer modell ur förslagen — samma val säljaren gör, samma funktion bakom. */
export function chooseModel(jobId: string, choice: { index?: number; manuell?: string }): Promise<{ ok: boolean }> {
  return publicJson(`/api/affar/analys/${encodeURIComponent(jobId)}/modell`, {
    method: "POST",
    body: JSON.stringify(choice),
  });
}

/**
 * "Ingen av dem" — fyra andra modellförslag.
 *
 * Samma knapp och samma sökning som säljaren har. Publik av samma skäl som resten av analysvägen:
 * köparen har ännu inte ett konto.
 */
export function findMoreModels(jobId: string): Promise<{ ok?: boolean }> {
  return publicJson(`/api/affar/analys/${encodeURIComponent(jobId)}/fler`, { method: "POST" });
}

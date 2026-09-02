/**
 * Köpsidans anrop.
 *
 * TVÅ SORTER, och gränsen är hela konverteringsmodellen: att TOLKA och att SVEPA är publikt —
 * köparen ska se att vi hittar saker innan de bestämt sig om oss — medan att SPARA kräver konto,
 * eftersom en bevakning åt någon vi inte kan nå är ett löfte vi inte kan hålla.
 */

import { supabase } from "../lib/supabase";
import type { Product } from "../butik/types";

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

/** Specen, i exakt den form servern skickar och tar emot. Klienten ändrar bara `filter`-fälten. */
export interface Spec {
  filter: {
    q?: string | null;
    categorySlug?: string | null;
    brands?: string[] | null;
    maxPriceSek?: number | null;
    maxWidthMm?: number | null;
    maxDepthMm?: number | null;
    maxHeightMm?: number | null;
    colors?: string[] | null;
    materials?: string[] | null;
    grades?: string[] | null;
  };
  styleTags: string[];
  deadline: string | null;
  urgency: "none" | "soon" | "urgent";
  note: string | null;
  summary: string;
  /** Falskt = modellen svarade inte. Klienten visar då formuläret i stället för sammanfattningen. */
  aiUsed: boolean;
}

export interface FollowUp {
  field: "kategori" | "maxpris" | "matt";
  question: string;
  options?: string[];
}

export interface Traff {
  produkt: Product;
  kalla: "loopa_live" | "loopa_incoming" | "tradera" | "own_find";
  typ: "exact" | "near";
  passform: string;
}

export interface Efterlysning {
  id: string;
  state: "active" | "paused" | "fulfilled" | "expired";
  summary: string;
  filter: Spec["filter"];
  styleTags: string[];
  deadline: string | null;
  urgency: Spec["urgency"];
  note: string | null;
  createdAt: string;
  expiresAt: string;
  scannedCount: number;
  scannedClearances: number;
}

export function tolka(text: string): Promise<{ spec: Spec; fragor: FollowUp[] }> {
  return publicJson("/api/efterlysning/tolka", { method: "POST", body: JSON.stringify({ text }) });
}

/** Väver in ett svar på en följdfråga. Hela meningen tolkas INTE om — se applyAnswer på servern. */
export function svara(spec: Spec, field: string, answer: string): Promise<{ spec: Spec; fragor: FollowUp[] }> {
  return publicJson("/api/efterlysning/tolka", {
    method: "POST",
    body: JSON.stringify({ spec, svar: [{ field, answer }] }),
  });
}

export function svep(spec: Spec): Promise<{
  traffar: Traff[]; lasta: number; traderaDegraded: boolean; prognos: string | null;
}> {
  return publicJson("/api/efterlysning/svep", { method: "POST", body: JSON.stringify({ spec }) });
}

export function spara(spec: Spec, omrade: string | null, parseMethod: "chat" | "form"): Promise<{ efterlysning: Efterlysning; dagar: number }> {
  return authJson("/api/efterlysning", { method: "POST", body: JSON.stringify({ spec, omrade, parseMethod }) });
}

export function minaEfterlysningar(): Promise<{ efterlysningar: Array<{ efterlysning: Efterlysning; traffar: number }> }> {
  return authJson("/api/efterlysning");
}

export function andra(id: string, patch: { state?: Efterlysning["state"]; spec?: Spec }): Promise<{ efterlysning: Efterlysning }> {
  return authJson(`/api/efterlysning/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function taBort(id: string): Promise<{ ok: boolean }> {
  return authJson(`/api/efterlysning/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fornya(id: string): Promise<{ efterlysning: Efterlysning }> {
  return authJson(`/api/efterlysning/${encodeURIComponent(id)}/fornya`, { method: "POST" });
}

/** Bevisremsan. Tomma listor = för lite data, och remsan ritar då ingenting. */
export function bevis(): Promise<{ uppfyllda: Array<{ vad: string; dagar: number }>; efterfragan: Array<{ vad: string; antal: number }> }> {
  return publicJson("/api/efterlysning/bevis");
}

export interface WallItem {
  key: string;
  title: string;
  categorySlug: string | null;
  categoryLabel: string | null;
  area: string | null;
  waitingDays: number;
  count: number;
}

/** Efterlysningsväggen. Publik och anonym — se wall.ts för reglerna. */
export function vagg(kategori?: string | null): Promise<{ poster: WallItem[] }> {
  const q = kategori ? `?kategori=${encodeURIComponent(kategori)}` : "";
  return publicJson(`/api/efterlysning/vagg${q}`);
}

/** Hur många som efterlyst en möbel som den här. Ett antal, aldrig mer. */
export function efterfragan(signals: { kategori?: string | null; marke?: string | null; pris?: number | null }): Promise<{ antal: number }> {
  const q = new URLSearchParams();
  if (signals.kategori) q.set("kategori", signals.kategori);
  if (signals.marke) q.set("marke", signals.marke);
  if (signals.pris) q.set("pris", String(signals.pris));
  return publicJson(`/api/efterlysning/efterfragan?${q.toString()}`);
}

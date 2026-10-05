/**
 * Annonsgranskningarna på disk: en fil per annons, senaste körningen.
 *
 * EGEN FIL OCH INTE ETT FÄLT PÅ JOBBET. Agenten kör i minuter i bakgrunden, och jobbet skrivs under
 * tiden av prisstegen, publiceringen och adminens rättelser. Ett fält på jobbet hade betytt att den
 * som skriver sist vinner — och att en granskning kunde sudda ut ett godkännande.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";

export type Beslut = "godkann" | "godkann_inte";
export type Omrade = "beskrivning" | "rubrik" | "kategori" | "bilder" | "postnummer" | "ovrigt";

export interface Problem {
  omrade: Omrade;
  /** Vad som är fel, så som en människa hade sagt det. */
  vad: string;
  /** Vad admin bör göra åt det. */
  forslag: string;
}

/** Ett varv i loopen: vilket verktyg agenten valde, varför, och vad det gav. */
export interface Steg {
  verktyg: string;
  argument: Record<string, unknown>;
  /** Kort sammanfattning av resultatet — hela svaret ligger bara i modellens historik. */
  resultat: string;
  tid: string;
}

export interface AnnonsGranskning {
  loopaId: string;
  status: "pagar" | "klar" | "fel";
  beslut: Beslut | null;
  sammanfattning: string | null;
  problem: Problem[];
  steg: Steg[];
  /** Felet när status är "fel". */
  fel: string | null;
  modell: string;
  tokens: number;
  startad: string;
  klar: string | null;
  /** "auto" när annonsen kom in i kön, annars admins användar-id. */
  startadAv: string;
}

const DIR = () => process.env.GRANSKNING_DATA_DIR?.trim() || path.join(DATA_DIR, "granskning");
const fil = (loopaId: string) => path.join(DIR(), `${loopaId.replace(/[^A-Za-z0-9-]/g, "_")}.json`);

/**
 * En körning som stått på "pagar" längre än så avbröts — servern startades om mitt i. Den visas som
 * misslyckad i stället för att snurra för alltid i panelen.
 */
const AVBRUTEN_EFTER_MS = 10 * 60_000;

function medAvbrott(g: AnnonsGranskning, nu = Date.now()): AnnonsGranskning {
  if (g.status !== "pagar" || nu - new Date(g.startad).getTime() < AVBRUTEN_EFTER_MS) return g;
  return { ...g, status: "fel", fel: "Granskningen avbröts innan den blev klar. Starta den igen." };
}

export async function hamtaGranskning(loopaId: string): Promise<AnnonsGranskning | null> {
  try {
    return medAvbrott(JSON.parse(await readFile(fil(loopaId), "utf-8")) as AnnonsGranskning);
  } catch {
    return null;
  }
}

export async function sparaGranskning(g: AnnonsGranskning): Promise<void> {
  await mkdir(DIR(), { recursive: true });
  await writeFile(fil(g.loopaId), JSON.stringify(g, null, 2), "utf-8");
}

/** Alla granskningar, per Loopa-ID. För listan i panelen. */
export async function allaGranskningar(): Promise<Map<string, AnnonsGranskning>> {
  const ut = new Map<string, AnnonsGranskning>();
  let filer: string[] = [];
  try {
    filer = await readdir(DIR());
  } catch {
    return ut;
  }
  for (const f of filer) {
    if (!f.endsWith(".json")) continue;
    try {
      const g = medAvbrott(JSON.parse(await readFile(path.join(DIR(), f), "utf-8")) as AnnonsGranskning);
      ut.set(g.loopaId, g);
    } catch {
      // En halvskriven fil hoppas över; nästa körning skriver om den.
    }
  }
  return ut;
}

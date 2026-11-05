/**
 * Nordstjärnan: den siffra teamet styr mot, och målet för den.
 *
 * EN FIL, EN RAD. Målet är ett beslut, inte en mätning — det sätts av en människa i panelen och ska
 * vara detsamma för varje admin som öppnar den. Därför bor det här på servern och inte i webbläsaren.
 *
 * MÅTTET ÄR VALBART, men bara bland de tre som räknas ur översikten (data/oversikt.ts, perVecka). Ett
 * mått panelen inte kan räkna är ett mål ingen kan se om man når.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";

const KATALOG = () => process.env.DATA_FLODE_DIR?.trim() || path.join(DATA_DIR, "data");
const FIL = () => path.join(KATALOG(), "mal.json");

export const MATT = ["nyaAnnonser", "nyaSaljare", "salda"] as const;
export type Matt = (typeof MATT)[number];

export interface Mal {
  matt: Matt;
  /** Per vecka. Null = inget mål satt; panelen visar då bara trenden. */
  perVecka: number | null;
  andradAv: string | null;
  andradAt: string | null;
}

const STANDARD: Mal = { matt: "nyaAnnonser", perVecka: null, andradAv: null, andradAt: null };

export async function lasMal(): Promise<Mal> {
  try {
    const m = JSON.parse(await readFile(FIL(), "utf-8")) as Partial<Mal>;
    return {
      matt: MATT.includes(m.matt as Matt) ? (m.matt as Matt) : STANDARD.matt,
      perVecka: typeof m.perVecka === "number" && m.perVecka > 0 ? Math.round(m.perVecka) : null,
      andradAv: typeof m.andradAv === "string" ? m.andradAv : null,
      andradAt: typeof m.andradAt === "string" ? m.andradAt : null,
    };
  } catch {
    return STANDARD;
  }
}

/** Sparar målet. Kastar ett läsbart fel när indata inte går att använda. */
export async function sparaMal(indata: { matt?: unknown; perVecka?: unknown }, av: string | null): Promise<Mal> {
  const matt = indata.matt;
  if (!MATT.includes(matt as Matt)) throw new Error("Okänt mått.");
  const perVecka =
    indata.perVecka === null || indata.perVecka === "" || indata.perVecka === undefined ? null : Number(indata.perVecka);
  if (perVecka !== null && (!Number.isFinite(perVecka) || perVecka <= 0 || perVecka > 100_000)) {
    throw new Error("Målet ska vara ett tal större än noll.");
  }
  const mal: Mal = {
    matt: matt as Matt,
    perVecka: perVecka === null ? null : Math.round(perVecka),
    andradAv: av,
    andradAt: new Date().toISOString(),
  };
  await mkdir(KATALOG(), { recursive: true });
  await writeFile(FIL(), JSON.stringify(mal, null, 2), "utf-8");
  return mal;
}

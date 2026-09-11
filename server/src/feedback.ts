/**
 * Säljarens omdöme om processen, och adminpanelens läsning av det.
 *
 * VARFÖR DEN FRÅGAS PRECIS EFTER JA:ET. Flödet — filma, vänta på bedömningen, sätta pris, godkänna —
 * är långt, och det enda ögonblick säljaren har hela det minnet färskt OCH ingenting kvar att göra
 * är sekunden efter att möbeln lämnats över. Frågas den senare, i ett mejl eller i profilen, svarar
 * bara den som redan är arg eller redan är nöjd; frågas den mitt i flödet är den ett hinder i ett
 * arbete som pågår. Kvittot är den enda platsen där den varken stör eller har hunnit kallna.
 *
 * FILER, inte Supabase — samma val som efterlysningarnas lager (efterlysning/store.ts) och av samma
 * skäl: ingenting här är en transaktion, två personer tävlar aldrig om samma rad, och ett omdöme som
 * går förlorat kostar ingen pengar. Skrivningarna serialiseras ändå, för två `writeFile` mot samma
 * fil i samma millisekund ger en halv fil.
 *
 * SVARET FÅR VARA HALVT. Betyget ensamt duger, texten ensam duger. Att kräva båda är att växla in
 * svar mot tystnad: den som bara vill trycka på en siffra gör inte om sig till en som skriver ett
 * stycke — de stänger rutan, och då har vi varken siffran eller stycket.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, getJob, ownerIdOf } from "./jobStore.js";
import { loopaIdFor } from "./loopaId.js";

const DIR = () => process.env.FEEDBACK_DATA_DIR?.trim() || path.join(DATA_DIR, "feedback");
const FILE = () => path.join(DIR(), "feedback.json");

/** Vad säljaren tyckte, och om vilken möbel. */
export interface Feedback {
  id: string;
  /** Jobbet omdömet gäller. Null om rutan någon gång visas utanför ett enskilt flöde. */
  jobId: string | null;
  /** Loopa-ID:t, så panelen kan slå upp annonsen utan att först översätta jobb-id:t. */
  loopaId: string | null;
  /** Möbelns namn vid svarstillfället — fruset, för det är den annons säljaren hade framför sig. */
  titel: string | null;
  userId: string;
  epost: string | null;
  /** 1-5, eller null när säljaren bara skrev något. */
  betyg: number | null;
  /** Fritexten, eller null när säljaren bara tryckte på en siffra. */
  text: string | null;
  skapad: string;
}

/** Fel som beror på vad som skickades in, och som därför ska bli 400 och inte 500. */
export class FeedbackFel extends Error {}

let cache: Feedback[] | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function load(): Promise<Feedback[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE(), "utf-8")) as Feedback[];
  } catch {
    cache = [];
  }
  return cache;
}

/**
 * Möbelns namn, i samma trappa som adminpanelens annonslista går ner för (adminAnnonser.ts).
 *
 * Namnet fryses in i raden i stället för att slås upp när panelen läses. Ett omdöme handlar om det
 * säljaren såg — och titeln kan ändras i efterhand av en admin, eller försvinna helt när annonsen
 * tas bort. Att då visa dagens titel, eller ett tomrum, vore att byta ut frågan svaret gällde.
 */
async function titelFor(jobId: string): Promise<{ titel: string | null; agare: string | null }> {
  const job = await getJob(jobId);
  if (!job) return { titel: null, agare: null };
  const namn = [job.identity?.brand, job.identity?.model].filter(Boolean).join(" ");
  return { titel: namn || null, agare: ownerIdOf(job) };
}

export async function sparaFeedback(input: {
  jobId?: string | null;
  betyg?: number | null;
  text?: string | null;
  userId: string;
  epost: string | null;
}): Promise<Feedback> {
  const betyg = input.betyg === null || input.betyg === undefined ? null : Math.round(Number(input.betyg));
  if (betyg !== null && (!Number.isFinite(betyg) || betyg < 1 || betyg > 5)) {
    throw new FeedbackFel("Betyget ska vara 1-5.");
  }
  // Texten kapas i stället för att avvisas: den som skrivit för mycket ska inte mötas av ett fel som
  // kastar bort allt de skrev. 4 000 tecken är flera stycken mer än någon skriver i en sådan här ruta.
  const text = (input.text ?? "").trim().slice(0, 4000) || null;
  if (betyg === null && !text) throw new FeedbackFel("Sätt ett betyg eller skriv några ord.");

  const jobId = input.jobId?.trim() || null;
  /**
   * ÄGARSKAPET PRÖVAS. Vägen är öppen för varje inloggat konto, och utan den här kontrollen kunde
   * vem som helst hänga ett omdöme på någon annans annons — panelen läser raderna som säljarens ord
   * om sin egen försäljning, och det måste den kunna göra.
   */
  const { titel, agare } = jobId ? await titelFor(jobId) : { titel: null, agare: null };
  if (jobId && agare && agare !== input.userId) throw new FeedbackFel("Annonsen tillhör någon annan.");

  return serialize(async () => {
    const rows = await load();
    const row: Feedback = {
      id: randomUUID(),
      jobId,
      loopaId: jobId ? loopaIdFor(jobId) : null,
      titel,
      userId: input.userId,
      epost: input.epost,
      betyg,
      text,
      skapad: new Date().toISOString(),
    };
    rows.push(row);
    await mkdir(DIR(), { recursive: true });
    await writeFile(FILE(), JSON.stringify(rows, null, 2), "utf-8");
    return row;
  });
}

/**
 * Allt som kommit in, nyast först, med snittbetyget räknat.
 *
 * Snittet räknas HÄR och inte i panelen: det ska vila på alla rader, och listan kommer förr eller
 * senare att behöva kapas. Bara satta betyg räknas — en fritext utan siffra är inte en nolla.
 */
export async function listaFeedback(): Promise<{ poster: Feedback[]; snitt: number | null; antalBetyg: number }> {
  const rows = [...(await load())].sort((a, b) => b.skapad.localeCompare(a.skapad));
  const betyg = rows.map((r) => r.betyg).filter((b): b is number => b !== null);
  return {
    poster: rows,
    snitt: betyg.length ? Math.round((betyg.reduce((s, b) => s + b, 0) / betyg.length) * 10) / 10 : null,
    antalBetyg: betyg.length,
  };
}

/**
 * Kampanjlänkarna: en kort adress per ställe vi delar Loopa, så att varje kanal får sin egen rad.
 *
 * VARFÖR DEN HÄR FILEN FINNS. Kanalerna i panelen var bara så bra som länkarna folk kom in genom, och
 * de flesta länkar bar ingenting: Instagram, Messenger och TikTok skickar ingen referrer, och de två
 * adresser som skulle bära en UTM-märkning till säljsidan dog på vägen — `loopa.nu/?utm_…` går till
 * marknadssajten (roten med query går inte att routa, se wrangler.toml) och `/salj?utm_…` 301:as
 * till roten utan sin query. Allt det hamnade under "Direkt", och "Direkt" är inget svar.
 *
 * EN SÖKVÄG, INTE EN QUERY. `loopa.nu/k/KOD` går att routa, precis som inbjudans `/i/KOD`, och
 * koden slås upp HÄR — källan, mediet och kampanjen skrivs in av servern och inte av länken. Det
 * gör att en affisch tryckt i oktober fortfarande räknas rätt om kampanjen döps om, och att ingen
 * kan skriva "utm_source=instagramm" och skapa en ny kanal av ett stavfel.
 *
 * NAMNEN ÄR PANELENS. Varje länk skapas i panelen med ett namn och ett ställe den ska ligga på, och
 * därför blir källorna samma ord varje gång. Se `PLATSER`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";

const KATALOG = () => process.env.DATA_FLODE_DIR?.trim() || path.join(DATA_DIR, "data");
const FIL = () => path.join(KATALOG(), "kampanjer.json");

/**
 * Ställena en länk kan ligga på, och vad de blir i mätningen.
 *
 * Källan och mediet följer den form `kanalFor` i besok.ts sorterar på, så att en länk från en
 * Facebook-grupp hamnar under Sociala medier och en från en affisch under Offline — utan att någon
 * behöver kunna UTM.
 */
export const PLATSER = {
  instagram_bio: { namn: "Instagram, profilen", kalla: "instagram", medium: "social" },
  instagram_inlagg: { namn: "Instagram, inlägg eller story", kalla: "instagram", medium: "social" },
  instagram_annons: { namn: "Instagram, betald annons", kalla: "instagram", medium: "paid_social" },
  facebook_grupp: { namn: "Facebook, grupp", kalla: "facebook", medium: "social" },
  facebook_annons: { namn: "Facebook, betald annons", kalla: "facebook", medium: "paid_social" },
  tiktok: { namn: "TikTok", kalla: "tiktok", medium: "social" },
  blocket: { namn: "Blocket-annons", kalla: "blocket", medium: "marknadsplats" },
  tradera: { namn: "Tradera-annons", kalla: "tradera", medium: "marknadsplats" },
  affisch: { namn: "Affisch, flyer eller QR-kod", kalla: "affisch", medium: "offline" },
  nyhetsbrev: { namn: "Nyhetsbrev eller mejl", kalla: "nyhetsbrev", medium: "email" },
  marknadssajten: { namn: "Marknadssajten loopa.nu", kalla: "loopa.nu", medium: "webb" },
  annat: { namn: "Annat", kalla: "annat", medium: "kampanj" },
} as const;

export type Plats = keyof typeof PLATSER;

/** Vart länken leder. Bara sidor som har en egen ingång — ett id i en länk på en affisch åldras. */
export const MAL = { "/": "Säljsidan", "/butik": "Butiken", "/efterlyses": "Efterlysningarna" } as const;
export type KampanjMal = keyof typeof MAL;

export interface Kampanj {
  kod: string;
  namn: string;
  plats: Plats;
  mal: KampanjMal;
  skapad: string;
  av: string | null;
}

/** Kodens form. Kort nog att skriva av från ett papper, utan tecken som går att förväxla. */
const KOD = /^[a-hjkmnp-z2-9]{5}$/;
const ALFABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function arKod(kod: unknown): kod is string {
  return typeof kod === "string" && KOD.test(kod);
}

let cache: Kampanj[] | null = null;
let kedja: Promise<unknown> = Promise.resolve();

export async function allaKampanjer(): Promise<Kampanj[]> {
  if (cache) return cache;
  try {
    const lista = JSON.parse(await readFile(FIL(), "utf-8")) as Kampanj[];
    cache = Array.isArray(lista) ? lista.filter((k) => arKod(k?.kod) && k.plats in PLATSER && k.mal in MAL) : [];
  } catch {
    cache = [];
  }
  return cache;
}

export async function kampanjFor(kod: string): Promise<Kampanj | null> {
  if (!arKod(kod)) return null;
  return (await allaKampanjer()).find((k) => k.kod === kod) ?? null;
}

/** UTM-fälten en kampanj står för. Det är dem besöksmätningen sorterar kanalen på. */
export function utmFor(k: Kampanj): { utm_source: string; utm_medium: string; utm_campaign: string } {
  const p = PLATSER[k.plats];
  return { utm_source: p.kalla, utm_medium: p.medium, utm_campaign: k.namn.toLowerCase() };
}

async function skriv(lista: Kampanj[]): Promise<void> {
  await mkdir(KATALOG(), { recursive: true });
  await writeFile(FIL(), JSON.stringify(lista, null, 2), "utf-8");
  cache = lista;
}

/** Skapar en länk. Kastar ett läsbart fel när indata inte går att använda. */
export async function skapaKampanj(indata: { namn?: unknown; plats?: unknown; mal?: unknown }, av: string | null): Promise<Kampanj> {
  const namn = typeof indata.namn === "string" ? indata.namn.trim().replace(/\s+/g, " ") : "";
  if (!namn || namn.length > 60) throw new Error("Ge länken ett namn, högst 60 tecken.");
  if (typeof indata.plats !== "string" || !(indata.plats in PLATSER)) throw new Error("Välj var länken ska ligga.");
  const mal = typeof indata.mal === "string" && indata.mal in MAL ? (indata.mal as KampanjMal) : "/";
  const jobb = kedja.then(async () => {
    const lista = [...(await allaKampanjer())];
    let kod = "";
    do {
      kod = [...randomBytes(5)].map((b) => ALFABET[b % ALFABET.length]).join("");
    } while (lista.some((k) => k.kod === kod));
    const k: Kampanj = { kod, namn, plats: indata.plats as Plats, mal, skapad: new Date().toISOString(), av };
    await skriv([k, ...lista]);
    return k;
  });
  kedja = jobb.catch(() => undefined);
  return jobb;
}

/**
 * Tar bort en länk ur listan. Länken slutar INTE fungera — en tryckt affisch ska aldrig leda till ett
 * fel — men den räknas inte längre som en egen kampanj; besöken därifrån hamnar under Direkt.
 */
export async function taBortKampanj(kod: string): Promise<boolean> {
  const jobb = kedja.then(async () => {
    const lista = await allaKampanjer();
    if (!lista.some((k) => k.kod === kod)) return false;
    await skriv(lista.filter((k) => k.kod !== kod));
    return true;
  });
  kedja = jobb.catch(() => undefined);
  return jobb;
}

/** Bara för tester. */
export function nollstall(): void {
  cache = null;
}

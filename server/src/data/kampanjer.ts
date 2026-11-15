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
 * Facebook-grupp hamnar under Sociala medier, en från en affisch under Offline och en från en
 * samarbetspartner under Samarbeten — utan att någon
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
  // Samarbetspartner som delar vår länk i sina egna kanaler. Mediet "partner" ger dem en egen kanal,
  // Samarbeten, i stället för att de drunknar under Kampanj. En rad per partner, så att varje
  // samarbete syns för sig under Varifrån.
  massproduction: { namn: "Mass Production AB (samarbete)", kalla: "massproduction", medium: "partner" },
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
  /** Inbyggd i koden: finns alltid, och går inte att ta bort i panelen. Se `FASTA_KAMPANJER`. */
  fast?: boolean;
}

/** Kodens form. Kort nog att skriva av från ett papper, utan tecken som går att förväxla. */
const KOD = /^[a-hjkmnp-z2-9]{5}$/;
const ALFABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * Samarbetslänkarna: läsbara adresser med partnerns namn, t.ex. loopa.nu/k/massproduction.
 *
 * I KODEN OCH INTE I DATAFILEN, med flit. En partner trycker och delar länken i sina egna kanaler,
 * och den får aldrig sluta räknas för att datafilen skrevs över, flyttades till en ny server eller
 * någon tryckte "Ta bort" i panelen. Den finns från första utrullningen, utan att någon behöver
 * skapa den.
 *
 * ALIASEN är stavningar folk faktiskt skriver av för hand. De leder till samma kampanj, men servern
 * omdirigerar till den riktiga adressen först (server.ts), så att det är EN kod som räknas.
 */
export const FASTA_KAMPANJER: ReadonlyArray<Kampanj & { aliaser: readonly string[] }> = [
  {
    kod: "massproduction",
    namn: "Mass Production",
    plats: "massproduction",
    mal: "/",
    skapad: "2026-11-15T00:00:00.000Z",
    av: null,
    fast: true,
    aliaser: ["mass-production", "mass_production", "massproductionab", "mass-production-ab", "massprod"],
  },
];

/** En läsbar kod: små bokstäver, siffror och bindestreck. Det en partnerlänk får se ut som. */
const LASBAR = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export function arKod(kod: unknown): kod is string {
  return typeof kod === "string" && (KOD.test(kod) || LASBAR.test(kod));
}

/**
 * Det adressfältet bar, som en kod att slå upp: avkodad, utan blanksteg, med små bokstäver. Folk
 * skriver "MassProduction" och telefoner sätter versal först — det ska gå till samma länk.
 */
export function normaliseraKod(ra: string): string | null {
  let kod: string;
  try {
    kod = decodeURIComponent(ra);
  } catch {
    return null;
  }
  kod = kod.trim().toLowerCase().replace(/[_\s]+/g, "-");
  return arKod(kod) ? kod : null;
}

let cache: Kampanj[] | null = null;
let kedja: Promise<unknown> = Promise.resolve();

/** Panelens egna länkar, de som ligger i datafilen. */
async function filKampanjer(): Promise<Kampanj[]> {
  if (cache) return cache;
  try {
    const lista = JSON.parse(await readFile(FIL(), "utf-8")) as Kampanj[];
    cache = Array.isArray(lista)
      ? lista.filter((k) => arKod(k?.kod) && k.plats in PLATSER && k.mal in MAL && !FASTA_KAMPANJER.some((f) => f.kod === k.kod))
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

const utanAliaser = ({ aliaser: _a, ...k }: Kampanj & { aliaser: readonly string[] }): Kampanj => k;

export async function allaKampanjer(): Promise<Kampanj[]> {
  return [...FASTA_KAMPANJER.map(utanAliaser), ...(await filKampanjer())];
}

/** Kampanjen för en kod ur adressfältet — normaliserad, och med de fasta länkarnas alias. */
export async function kampanjFor(ra: string): Promise<Kampanj | null> {
  const kod = normaliseraKod(ra);
  if (!kod) return null;
  const fast = FASTA_KAMPANJER.find((f) => f.kod === kod || f.aliaser.includes(kod));
  if (fast) return utanAliaser(fast);
  return (await filKampanjer()).find((k) => k.kod === kod) ?? null;
}

/**
 * Vad servern svarar på /k/KOD. En ren funktion, så att varje form av länken går att pröva i test
 * utan en server (tests/kampanjlank.test.ts) — det är den här logiken en partner litar på.
 *
 * - okänd kod → till säljsidan (en tryckt eller delad länk ska aldrig ge ett fel)
 * - mål utanför säljsidan → dit, med koden som ?k=
 * - versaler, alias, snedstreck sist → omdirigeras till den exakta adressen, med queryn kvar
 * - exakt adress → appskalet, som läser koden (web/src/lib/besok.ts)
 */
export async function kampanjSvar(pathname: string, search: string): Promise<{ typ: "omdirigera"; location: string } | { typ: "appen"; kod: string } | null> {
  if (!/^\/k(\/|$)/i.test(pathname)) return null;
  const vag = /^\/k\/([^/]{1,80})\/?$/i.exec(pathname);
  if (!vag) return { typ: "omdirigera", location: "/" };
  const k = await kampanjFor(vag[1]);
  if (!k) return { typ: "omdirigera", location: "/" };
  if (k.mal !== "/") return { typ: "omdirigera", location: `${k.mal}?k=${k.kod}` };
  if (pathname !== `/k/${k.kod}`) return { typ: "omdirigera", location: `/k/${k.kod}${search}` };
  return { typ: "appen", kod: k.kod };
}

/**
 * Samma länk under /salj/KOD, t.ex. loopa.nu/salj/massproduction.
 *
 * VARFÖR EN ANDRA FORM. /salj/* är en Worker-rutt som redan ligger ute, medan /k/* kräver en ny
 * Cloudflare-utrullning. Under /salj/ fungerar en partnerlänk alltså från första serverutrullningen,
 * och den landade på säljsidan redan innan — servern 301:ade allt där till roten. Bara KÄNDA koder
 * får appskalet här; allt annat under /salj/ omdirigeras som förut (null → anroparens 301).
 */
export async function saljKampanjSvar(pathname: string, search: string): Promise<{ typ: "omdirigera"; location: string } | { typ: "appen"; kod: string } | null> {
  const vag = /^\/salj\/([^/]{1,80})\/?$/i.exec(pathname);
  if (!vag) return null;
  const k = await kampanjFor(vag[1]);
  if (!k) return null;
  if (k.mal !== "/") return { typ: "omdirigera", location: `${k.mal}?k=${k.kod}` };
  if (pathname !== `/salj/${k.kod}`) return { typ: "omdirigera", location: `/salj/${k.kod}${search}` };
  return { typ: "appen", kod: k.kod };
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
    const lista = [...(await filKampanjer())];
    let kod = "";
    do {
      kod = [...randomBytes(5)].map((b) => ALFABET[b % ALFABET.length]).join("");
    } while (lista.some((k) => k.kod === kod) || FASTA_KAMPANJER.some((f) => f.kod === kod));
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
  if (FASTA_KAMPANJER.some((f) => f.kod === kod)) return false;
  const jobb = kedja.then(async () => {
    const lista = await filKampanjer();
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

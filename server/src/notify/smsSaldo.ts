/**
 * Saldot hos 46elks, och en varning innan det tar slut.
 *
 * Kontot fylls på för hand och har kreditgräns 0: när saldot är slut går SMS:en inte iväg, och
 * köparen får bara mejlet. Det märks inte förrän någon undrar varför de aldrig fick länken. Därför
 * läses saldot efter varje skickat SMS och var sjätte timme, och under gränsen
 * (SMS_SALDO_VARNING_KR, förval 10 kr) mejlas FRAKT_NOTIFY_TO — högst en gång per dygn.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";
import { sendLetter } from "../efterlysning/notify.js";
import { smsProvider } from "./sms.js";

const FIL = () => path.join(process.env.SMS_SALDO_DIR?.trim() || DATA_DIR, "sms-saldo.json");
const DYGN_MS = 24 * 3_600_000;

interface SaldoLage {
  saldoKr: number | null;
  lastAt: string | null;
  varnadAt: string | null;
}

let senast: SaldoLage = { saldoKr: null, lastAt: null, varnadAt: null };

async function lasLage(): Promise<SaldoLage> {
  try {
    senast = { ...senast, ...(JSON.parse(await readFile(FIL(), "utf-8")) as SaldoLage) };
  } catch {
    // Ingen fil än — första kontrollen.
  }
  return senast;
}

async function sparaLage(l: SaldoLage): Promise<void> {
  senast = l;
  await mkdir(path.dirname(FIL()), { recursive: true });
  await writeFile(FIL(), JSON.stringify(l, null, 2), "utf-8");
}

/** Senast kända saldo, utan nätanrop. För panelen. */
export function senastKandaSaldo(): { saldoKr: number | null; lastAt: string | null; grans: number } {
  return { saldoKr: senast.saldoKr, lastAt: senast.lastAt, grans: varningsgrans() };
}

export function varningsgrans(): number {
  const n = Number(process.env.SMS_SALDO_VARNING_KR ?? 10);
  return Number.isFinite(n) ? n : 10;
}

/** 46elks redovisar saldot i tiotusendels kronor: 189600 = 18,96 kr. */
export async function hamtaSaldoKr(): Promise<number | null> {
  const user = process.env.ELKS_API_USERNAME?.trim();
  const pass = process.env.ELKS_API_PASSWORD?.trim();
  if (!user || !pass) return null;
  const res = await fetch("https://api.46elks.com/a1/me", {
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`46elks svarade ${res.status}`);
  const me = (await res.json()) as { balance?: number };
  return typeof me.balance === "number" ? Math.round(me.balance / 100) / 100 : null;
}

/**
 * Läser saldot och varnar om det behövs. Fel sväljs och loggas: en saldokoll får aldrig stoppa
 * ett SMS eller en serverstart.
 */
export async function kollaSmsSaldo(nu: Date = new Date()): Promise<{ saldoKr: number | null; varnade: boolean }> {
  if (smsProvider() !== "46elks") return { saldoKr: null, varnade: false };
  try {
    const lage = await lasLage();
    const saldoKr = await hamtaSaldoKr();
    if (saldoKr === null) return { saldoKr: null, varnade: false };
    const grans = varningsgrans();
    const nyss = lage.varnadAt && nu.getTime() - new Date(lage.varnadAt).getTime() < DYGN_MS;
    let varnadAt = saldoKr >= grans ? null : lage.varnadAt;
    let varnade = false;
    if (saldoKr < grans && !nyss) {
      const mottagare = (process.env.FRAKT_NOTIFY_TO ?? "isacekelund07@gmail.com").split(",").map((e) => e.trim()).filter(Boolean);
      for (const to of mottagare) {
        varnade =
          (await sendLetter({
            to,
            subject: `Lågt SMS-saldo: ${saldoKr.toFixed(2).replace(".", ",")} kr kvar hos 46elks`,
            kind: "ops-sms-saldo",
            body: [
              `Saldot hos 46elks är ${saldoKr.toFixed(2).replace(".", ",")} kr (varningsgränsen är ${grans} kr).`,
              "",
              "Ett SMS kostar ungefär 0,52 kr per del. Fraktlänken är oftast två delar och bekräftelsen en.",
              "När saldot är slut går SMS:en inte iväg — köparen får då bara mejlet.",
              "",
              "Fyll på: https://46elks.se/account",
            ].join("\n"),
          })) || varnade;
      }
      if (varnade) varnadAt = nu.toISOString();
    }
    await sparaLage({ saldoKr, lastAt: nu.toISOString(), varnadAt });
    return { saldoKr, varnade };
  } catch (err) {
    console.warn(`[sms-saldo] kunde inte läsa saldot: ${err instanceof Error ? err.message : String(err)}`);
    return { saldoKr: senast.saldoKr, varnade: false };
  }
}

/** Startas från server.ts. Läser vid start och sedan var sjätte timme. */
export function startaSaldoBevakning(): void {
  if (smsProvider() !== "46elks") return;
  void kollaSmsSaldo();
  setInterval(() => void kollaSmsSaldo(), 6 * 3_600_000).unref();
}

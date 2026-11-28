/**
 * SMS-utskicket. Samma tanke som brevens (outbox.ts): en riktig leverantör när den är konfigurerad,
 * annars hamnar SMS:et som en fil i /outbox — och det står i svaret att det inte gick iväg.
 *
 *   46elks  ELKS_API_USERNAME + ELKS_API_PASSWORD (46elks.se → Konto → API-nycklar). Svensk
 *           leverantör, ett HTTP-anrop, ingen SDK. Avsändaren är SMS_FROM, förval "Loopa" — ett
 *           alfanumeriskt namn går att läsa men inte att svara till, och det är rätt här: svaret
 *           ska komma via länken, inte som ett SMS ingen läser.
 *   file    skriver SMS:et till /outbox som en .txt. Förvalet när nycklarna saknas.
 *
 * SMS_PROVIDER=none stänger av helt. SMS_DRYRUN=1 låter 46elks ta emot anropet utan att skicka —
 * deras eget provläge, för att se att nycklarna fungerar utan att någon telefon piper.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { outboxDir } from "./outbox.js";

export interface SmsMessage {
  /** E.164, "+46701234567". */
  to: string;
  text: string;
  /** Vad SMS:et gäller. Står i filnamnet i /outbox och i loggen. */
  kind: string;
}

export interface SmsResult {
  /** Sant bara när en leverantör tagit emot SMS:et för leverans. En fil i /outbox är INTE skickat. */
  sent: boolean;
  provider: "46elks" | "file" | "none";
  /** Leverantörens id, när det finns. */
  id: string | null;
  error: string | null;
}

export function smsProvider(): "46elks" | "file" | "none" {
  const choice = process.env.SMS_PROVIDER?.trim().toLowerCase();
  if (choice === "none") return "none";
  if (choice === "file") return "file";
  if (process.env.ELKS_API_USERNAME?.trim() && process.env.ELKS_API_PASSWORD?.trim()) return "46elks";
  return "file";
}

/** Avsändarnamnet. 46elks tar högst 11 tecken, bokstäver och siffror. */
function from(): string {
  const raw = process.env.SMS_FROM?.trim() || "Loopa";
  return raw.replace(/[^A-Za-z0-9+]/g, "").slice(0, 11) || "Loopa";
}

/** Ett nummer vi vågar skicka till: plus och 8–15 siffror. */
export function giltigtNummer(to: string): boolean {
  return /^\+\d{8,15}$/.test(to);
}

/**
 * Hur många SMS texten blir. Å, ä och ö ryms i GSM-alfabetet, så ett svenskt SMS är 160 tecken
 * — 153 per del när det delas. Används i testerna och i förhandsvisningen.
 */
export function smsDelar(text: string): number {
  const gsm = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/.test(text);
  const per = gsm ? 160 : 70;
  const perDel = gsm ? 153 : 67;
  return text.length <= per ? 1 : Math.ceil(text.length / perDel);
}

async function toFile(msg: SmsMessage): Promise<void> {
  const dir = outboxDir();
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}__sms-${msg.kind}__${msg.to.replace(/[^0-9+]/g, "")}.txt`;
  await writeFile(
    path.join(dir, name),
    [`SMS till: ${msg.to}`, `Från: ${from()}`, `Sort: ${msg.kind}`, `Delar: ${smsDelar(msg.text)}`, "", msg.text].join("\n"),
    "utf-8",
  );
}

export async function sendSms(msg: SmsMessage): Promise<SmsResult> {
  if (!giltigtNummer(msg.to)) return { sent: false, provider: smsProvider(), id: null, error: `Ogiltigt nummer: ${msg.to}` };
  const provider = smsProvider();
  if (provider === "none") {
    console.info(`[sms] SMS_PROVIDER=none — "${msg.kind}" till ${msg.to} skickades inte.`);
    return { sent: false, provider, id: null, error: "SMS är avstängt (SMS_PROVIDER=none)." };
  }
  if (provider === "file") {
    try {
      await toFile(msg);
      return { sent: false, provider, id: null, error: "Ingen SMS-leverantör konfigurerad — SMS:et ligger i /outbox." };
    } catch (err) {
      return { sent: false, provider, id: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const user = process.env.ELKS_API_USERNAME!.trim();
  const pass = process.env.ELKS_API_PASSWORD!.trim();
  const body = new URLSearchParams({ from: from(), to: msg.to, message: msg.text });
  if (process.env.SMS_DRYRUN === "1") body.set("dryrun", "yes");
  try {
    const res = await fetch("https://api.46elks.com/a1/sms", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    if (!res.ok) return { sent: false, provider, id: null, error: `46elks svarade ${res.status}: ${raw.slice(0, 200)}` };
    let id: string | null = null;
    try {
      id = (JSON.parse(raw) as { id?: string }).id ?? null;
    } catch {
      // Ett 200 utan JSON är fortfarande ett mottaget SMS.
    }
    // Saldot efter varje riktigt SMS (inte provläget). Väntas inte in — se smsSaldo.ts.
    if (process.env.SMS_DRYRUN !== "1") void import("./smsSaldo.js").then((m) => m.kollaSmsSaldo()).catch(() => {});
    return { sent: true, provider, id, error: null };
  } catch (err) {
    return { sent: false, provider, id: null, error: err instanceof Error ? err.message : String(err) };
  }
}

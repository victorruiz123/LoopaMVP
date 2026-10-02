/**
 * Glömt lösenord: mejlet med länken skickas av OSS, inte av Supabase.
 *
 * VARFÖR. Supabase-projektet (delat med Vips) har ingen egen mejlserver inkopplad — registreringen
 * bekräftas inte ens via mejl (`mailer_autoconfirm`). Utan en sådan skickar Supabase bara till
 * projektets egna teammedlemmar, ett par brev i timmen, och tyst ingenting till alla andra. Knappen
 * "Glömt lösenordet?" såg ut att fungera och inget mejl kom fram.
 *
 * SÅ HÄR GÅR DET TILL I STÄLLET. Servern ber Supabase om en engångskod med servicenyckeln
 * (`admin/generate_link`, som SKAPAR länken utan att skicka något), och mejlar den själv genom samma
 * one.com-konto som utskicket. Länken är vår egen: `https://loopa.nu/#aterstall=<kod>`. Klienten löser
 * in koden med `verifyOtp` (web/src/auth/AuthProvider.tsx) och får då sessionen som låter den byta
 * lösenordet.
 *
 * KODEN STÅR EFTER #, med flit. Den delen skickas aldrig till någon server, så de mejlfilter som
 * förhandsöppnar varje länk i ett brev (Outlook, Hotmail) kan inte förbruka den innan människan
 * klickar — vilket är den vanligaste orsaken till "länken har redan gått ut" med Supabases egen länk.
 * Det gör oss också oberoende av Supabases lista över tillåtna adresser.
 *
 * SVARET ÄR DETSAMMA OM KONTOT FINNS ELLER INTE. Annars går vägen att använda för att pröva vilka
 * adresser som har konto hos oss. Taket per IP och per adress hindrar att den blir en spamkanon.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { supabaseUrl } from "./supabaseAuth.js";
import { skickaEttBrev, smtpKonfigurerat } from "./utskick.js";

const FONSTER_MS = 60 * 60_000;
/** Per adress och timme. Den som inte hittar mejlet trycker igen — tre gånger räcker gott. */
const PER_ADRESS = 3;
/** Per IP och timme. Någon som prövar många adresser från samma ställe. */
const PER_IP = 10;
/** Totalt per timme. Taket per IP hjälper inte mot någon som byter IP; det här gör. */
const TOTALT = 200;

const traffar = new Map<string, number[]>();

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Se chatClientKey i server.ts: bakom tunneln är x-forwarded-for det enda som skiljer besökare åt. */
function klientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  return (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim() || req.socket.remoteAddress || "okänd";
}

/** Räknar och svarar om taket är nått. Exporterad för testerna, som nollställer mellan fallen. */
export function overTaket(ip: string, epost: string, nu = Date.now()): boolean {
  let totalt = 0;
  for (const [k, t] of traffar) {
    const farska = t.filter((x) => nu - x < FONSTER_MS);
    if (farska.length) {
      traffar.set(k, farska);
      if (k.startsWith("ip:")) totalt += farska.length;
    } else traffar.delete(k);
  }
  const ipT = traffar.get(`ip:${ip}`) ?? [];
  const adrT = traffar.get(`adr:${epost}`) ?? [];
  if (totalt >= TOTALT || ipT.length >= PER_IP || adrT.length >= PER_ADRESS) return true;
  traffar.set(`ip:${ip}`, [...ipT, nu]);
  traffar.set(`adr:${epost}`, [...adrT, nu]);
  return false;
}

export function nollstallTaket(): void {
  traffar.clear();
}

const EPOST = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"'.]{2,}$/;

/** Vart länken pekar. Roten, för att den är den adress Cloudflare-routern alltid släpper fram till appen. */
function lankBas(): string {
  return (process.env.LOOPA_PUBLIC_URL?.trim() || "https://loopa.nu").replace(/\/+$/, "");
}

/**
 * Engångskoden från Supabase, eller null när kontot inte finns.
 *
 * Svaret har bytt form mellan GoTrue-versioner — fälten har legat både på toppnivån och under
 * `properties` — så båda läses.
 */
async function engangskod(epost: string): Promise<string | null> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY saknas på servern.");
  const res = await fetch(`${supabaseUrl()}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "recovery", email: epost }),
  });
  if (res.status === 404 || res.status === 422) return null;
  if (!res.ok) throw new Error(`generate_link svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { hashed_token?: string; properties?: { hashed_token?: string } };
  const kod = data.properties?.hashed_token ?? data.hashed_token;
  if (!kod) throw new Error("generate_link svarade utan hashed_token.");
  return kod;
}

export function brevet(lank: string): { subject: string; text: string } {
  return {
    subject: "Välj ett nytt lösenord hos Loopa",
    text: [
      "Hej!",
      "",
      "Någon – förhoppningsvis du – bad om att få byta lösenordet till ditt konto hos Loopa.",
      "Öppna länken för att välja ett nytt:",
      "",
      lank,
      "",
      "Länken fungerar en gång och slutar gälla efter en stund.",
      "Bad du inte om det här kan du strunta i mejlet. Ditt lösenord är oförändrat.",
      "",
      "/Loopa",
    ].join("\n"),
  };
}

/** POST /api/losenord/aterstall { email }. Segmenten efter /api/losenord. */
export async function handleLosenord(
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  body: () => Promise<unknown>,
): Promise<boolean> {
  if (!(segments[0] === "aterstall" && segments.length === 1 && req.method === "POST")) return false;

  const kropp = (await body().catch(() => ({}))) as { email?: unknown };
  const epost = typeof kropp.email === "string" ? kropp.email.trim().toLowerCase() : "";
  if (!EPOST.test(epost)) return (json(res, 400, { error: "Ogiltig e-postadress." }), true);

  if (overTaket(klientIp(req), epost)) {
    return (json(res, 429, { error: "Vänta en stund innan du ber om en ny länk." }), true);
  }
  // Prövas för ALLA adresser, så att ett trasigt SMTP inte svarar olika för konton som finns och inte.
  if (!smtpKonfigurerat()) {
    console.error("[losenord] SMTP_USER/SMTP_PASS saknas — inget återställningsmejl kan skickas.");
    return (json(res, 503, { error: "Mejlet kan inte skickas just nu. Försök igen senare." }), true);
  }

  try {
    const kod = await engangskod(epost);
    if (kod) {
      await skickaEttBrev({ to: epost, ...brevet(`${lankBas()}/#aterstall=${encodeURIComponent(kod)}`) });
      console.info(`[losenord] återställningslänk skickad till ${epost}.`);
    } else {
      console.info(`[losenord] inget konto för ${epost} — inget mejl.`);
    }
    json(res, 200, { ok: true });
  } catch (err) {
    console.error("[losenord] kunde inte skicka:", err instanceof Error ? err.message : err);
    json(res, 502, { error: "Mejlet kunde inte skickas. Försök igen om en stund." });
  }
  return true;
}

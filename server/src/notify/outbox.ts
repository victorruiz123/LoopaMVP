/**
 * Utskicket, med två implementationer och ingen leverantör vald.
 *
 * PROJEKTET HAR INGEN E-POSTAVSÄNDARE — varken paket, nyckel eller avsändaradress — och att välja en
 * åt hela produkten är inte den här funktionens beslut. Notiserna får ändå inte vänta på det
 * beslutet, för hela efterlysningen bygger på att vi hör av oss.
 *
 * Därför två adaptrar bakom samma gränssnitt:
 *
 *   file  skriver FÄRDIGRENDERADE brev till /outbox som .txt. Det som ligger där är exakt vad en
 *         mottagare hade fått, vilket gör mappen till verifieringen: går det att läsa breven och se
 *         att siffrorna stämmer, så fungerar utskicket.
 *   none  gör ingenting alls, och säger det. Platsen där en riktig leverantör kopplas in.
 *
 * VALET STYRS AV `EMAIL_PROVIDER`, och förvalet är `file`. Att låtsas skicka hade varit värre än att
 * inte skicka: en bevakning som tyst inte hör av sig är sämre än ingen bevakning.
 *
 * IN-APP-INKORGEN ÄR PRIMÄR KANAL och ligger inte här — den skrivs i efterlysning/notify.ts och når
 * mottagaren oavsett vilken adapter som är vald. Brevet är en påminnelse om inkorgen, inte tvärtom.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";

export interface Letter {
  to: string;
  subject: string;
  /** Ren text. Ingen HTML förrän en leverantör är vald — mallspråket är deras beslut, inte vårt. */
  body: string;
  /** Vad brevet gäller. Blir en del av filnamnet, så mappen går att läsa utan att öppna filerna. */
  kind: string;
}

export interface Sender {
  name: string;
  send(letter: Letter): Promise<void>;
}

const OUTBOX = () => process.env.OUTBOX_DIR?.trim() || path.join(DATA_DIR, "..", "..", "outbox");

/** Ett filnamn som går att sortera och läsa: tid, sort, mottagare. */
function fileNameFor(letter: Letter): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const who = letter.to.replace(/[^a-z0-9@._-]/gi, "_").slice(0, 40);
  return `${stamp}__${letter.kind}__${who}.txt`;
}

const fileSender: Sender = {
  name: "file",
  async send(letter) {
    const dir = OUTBOX();
    await mkdir(dir, { recursive: true });
    const text = [
      `Till: ${letter.to}`,
      `Ämne: ${letter.subject}`,
      `Sort: ${letter.kind}`,
      `Skrivet: ${new Date().toISOString()}`,
      "",
      letter.body,
    ].join("\n");
    await writeFile(path.join(dir, fileNameFor(letter)), text, "utf-8");
  },
};

const noneSender: Sender = {
  name: "none",
  async send(letter) {
    // Säger vad som INTE hände. Ett tyst nej ser ut som ett skickat brev i loggen.
    console.info(`[utskick] ingen leverantör vald — brevet "${letter.subject}" till ${letter.to} skickades inte.`);
  },
};

/**
 * gmail  skickar på riktigt, genom Gmails SMTP med samma konto och applösenord som Tradera-posten
 *        läser inkorgen med (GMAIL_USER / GMAIL_APP_PASSWORD). Avsändaren blir kontot självt.
 *        Det är den första riktiga leverantören, och den valdes för att kontot redan fanns — inte
 *        som ett beslut om hur Loopa ska skicka brev i stor skala. Gmail tillåter några hundra
 *        brev om dagen, vilket räcker för adminens egna notiser.
 */
const gmailSender: Sender = {
  name: "gmail",
  async send(letter) {
    const user = process.env.GMAIL_USER?.trim();
    const pass = process.env.GMAIL_APP_PASSWORD?.trim();
    if (!user || !pass) throw new Error("EMAIL_PROVIDER=gmail kräver GMAIL_USER och GMAIL_APP_PASSWORD.");
    const { createTransport } = await import("nodemailer");
    const transport = createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
    await transport.sendMail({
      from: `Loopa <${user}>`,
      to: letter.to,
      subject: letter.subject,
      text: letter.body,
      headers: { "X-Loopa-Kind": letter.kind },
    });
  },
};

export function sender(): Sender {
  const choice = (process.env.EMAIL_PROVIDER ?? "file").trim().toLowerCase();
  if (choice === "none") return noneSender;
  if (choice === "file") return fileSender;
  if (choice === "gmail") return gmailSender;
  /**
   * En okänd leverantör faller till `file` och SÄGER det.
   *
   * Alternativet — att kasta — hade stoppat en pulskörning för en felstavad miljövariabel. Att tyst
   * falla till `none` hade tappat breven. Filen behåller dem och loggen berättar varför.
   */
  console.warn(`[utskick] okänd EMAIL_PROVIDER "${choice}" — skriver till /outbox i stället.`);
  return fileSender;
}

export function outboxDir(): string {
  return OUTBOX();
}

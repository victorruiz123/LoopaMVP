/**
 * Provar SMS-utskicket: `npm run sms:prov -- +46701234567`
 *
 * Skickar ETT SMS till numret du anger — ditt eget — med samma kod som fraktlänken går genom. Säger
 * vilken leverantör som valdes och vad 46elks svarade. Med `--torr` skickas anropet i 46elks
 * provläge (dryrun): nycklarna prövas, men ingen telefon piper och inget dras från saldot.
 *
 * Körs på servern efter att ELKS_API_USERNAME och ELKS_API_PASSWORD lagts i server/.env.
 */

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // Ingen .env — miljön får komma utifrån.
}

const { sendSms, smsProvider, smsDelar, giltigtNummer } = await import("./sms.js");
const { normalizePhone } = await import("../integrations/tradera/orderspec.js");
const { smsText } = await import("../integrations/tradera/betald.js");

const args = process.argv.slice(2);
const torr = args.includes("--torr");
const nummer = normalizePhone(args.find((a) => !a.startsWith("--")) ?? "");
if (!nummer || !giltigtNummer(nummer)) {
  console.error("Ange ditt mobilnummer: npm run sms:prov -- 0701234567   (lägg till --torr för provläge)");
  process.exit(1);
}
if (torr) process.env.SMS_DRYRUN = "1";

const leverantor = smsProvider();
console.log(`Leverantör: ${leverantor}${torr ? " (provläge, inget skickas)" : ""}`);
if (leverantor !== "46elks") {
  console.log("ELKS_API_USERNAME/ELKS_API_PASSWORD saknas i server/.env — SMS:et hamnar i /outbox i stället.");
}

const lank = `${(process.env.LOOPA_PUBLIC_URL?.trim() || "https://app.loopa.nu").replace(/\/+$/, "")}/butik/frakt/PROV-${Date.now().toString(36)}`;
const text = smsText({ namn: "Prov Provsson", titel: "3-sitssoffa (prov-SMS från Loopa)", lank });
console.log(`Till: ${nummer}\nText (${text.length} tecken, ${smsDelar(text)} SMS):\n${text}\n`);

const r = await sendSms({ to: nummer, text, kind: "prov" });
if (r.sent) console.log(`OK — 46elks tog emot SMS:et${r.id ? ` (id ${r.id})` : ""}.`);
else console.log(`INTE skickat: ${r.error}`);
process.exit(r.sent || leverantor !== "46elks" ? 0 : 1);

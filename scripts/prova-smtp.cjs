/**
 * Provar att brevlådan går att logga in på, och skickar ett provbrev om du ber om det.
 *
 * Läser SMTP_HOST, SMTP_PORT, SMTP_USER och SMTP_PASS ur server/.env. Lösenordet skrivs aldrig ut,
 * varken i terminalen eller i ett fel — det enda som rapporteras är om inloggningen gick igenom.
 *
 *   node scripts/prova-smtp.cjs                      bara inloggning
 *   node scripts/prova-smtp.cjs din@adress.se        inloggning + ett provbrev dit
 *
 * Provbrevet är vägen att se vad mottagaren faktiskt ser: avsändarnamn, adress och om brevet hamnar
 * i inkorgen eller i skräpposten. Ett utskick till åttio personer ska aldrig vara första gången
 * någon läser ett brev härifrån.
 */

const fs = require("fs");
const path = require("path");

const ROT = path.join(__dirname, "..");
const ENV_FIL = path.join(ROT, "server", ".env");
if (!fs.existsSync(ENV_FIL)) {
  console.error("server/.env finns inte.");
  process.exit(1);
}

const env = Object.fromEntries(
  fs
    .readFileSync(ENV_FIL, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const host = env.SMTP_HOST || "send.one.com";
const port = Number(env.SMTP_PORT || 465);
const user = env.SMTP_USER;
const pass = env.SMTP_PASS;
const fran = env.SMTP_FROM || `Loopa <${user}>`;
const till = process.argv[2] || null;

if (!user || !pass) {
  console.error("SMTP_USER och SMTP_PASS saknas i server/.env. Lägg in dem först:");
  console.error("  SMTP_HOST=send.one.com");
  console.error("  SMTP_PORT=465");
  console.error("  SMTP_USER=info@loopa.nu");
  console.error("  SMTP_PASS=<brevlådans lösenord>");
  process.exit(1);
}

let nodemailer;
try {
  nodemailer = require(path.join(ROT, "server", "node_modules", "nodemailer"));
} catch {
  console.error("nodemailer saknas. Kör: npm --prefix server install");
  process.exit(1);
}

(async () => {
  console.log(`server: ${host}:${port} (${port === 465 ? "SSL" : "STARTTLS"})`);
  console.log(`konto:  ${user}`);
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  try {
    await transport.verify();
    console.log("inloggning: OK — brevlådan tar emot utgående post.");
  } catch (err) {
    // Felet från servern säger vad som är fel utan att avslöja lösenordet: "535" = fel uppgifter,
    // "ETIMEDOUT" = når inte fram, "ECONNREFUSED" = fel port.
    console.error("inloggning: MISSLYCKADES —", (err && err.message ? err.message : String(err)).slice(0, 200));
    process.exit(1);
  }

  if (!till) {
    console.log("\nKör om med din egen adress som argument för att skicka ett provbrev.");
    return;
  }

  try {
    const info = await transport.sendMail({
      from: fran,
      to: till,
      subject: "Provbrev från Loopa",
      text: [
        "Det här är ett provbrev.",
        "",
        `Skickat via ${host} som ${user}.`,
        "Kontrollera att avsändaren ser rätt ut och att brevet hamnade i inkorgen och inte i skräpposten.",
      ].join("\n"),
    });
    console.log(`provbrev skickat till ${till} (id ${info.messageId}).`);
  } catch (err) {
    console.error("provbrev: MISSLYCKADES —", (err && err.message ? err.message : String(err)).slice(0, 200));
    process.exit(1);
  }
})();

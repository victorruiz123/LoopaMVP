/**
 * Kontaktbrevet till Massproductions, från terminalen. Skickar ALDRIG till Massproductions.
 *
 *   npm run massproductions:kontakt                          kontrollen: loggar in på brevlådan
 *                                                            (utan att skicka) och visar läget för
 *                                                            varje brev
 *   npm run massproductions:kontakt -- --visa                skriver ut exakt brevet Magnus får, med
 *                                                            påhittade uppgifter, utan att skicka
 *   npm run massproductions:kontakt -- --prov din@adress.se  skickar exakt samma brev till DIN adress,
 *                                                            genom samma one.com-konto och samma kod
 *   npm run massproductions:kontakt -- --skicka-om           försöker igen med allt som inte gått
 *                                                            fram, även de servern gett upp om
 *
 * --prov är vägen att se brevet i en riktig inkorg: avsändare, ämne, svarsadress och om det hamnar
 * i skräpposten. Mottagaren MÅSTE anges, och Massproductions adresser avvisas.
 */

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const k = await import("./massproductionsKontakt.js");
const { skickaEttBrev, avsandare, smtpKonfigurerat } = await import("./utskick.js");

const args = process.argv.slice(2);
const MARKE = { ok: "  ok   ", varning: "varning", fel: "  FEL  ", av: "  av   " } as const;

const exempel = {
  loopaId: "LP-PROV",
  titel: "Pinocchio Sofa (provbrev)",
  mobelprisSek: 5000,
  credits: 5500,
  saljare: { namn: "Anna Svensson", epost: "anna@exempel.se", telefon: null },
};

function skrivBrev(b: { to: string; subject: string; text: string; replyTo?: string }): void {
  console.log(`Från:     ${avsandare()}`);
  console.log(`Till:     ${b.to}`);
  console.log(`Svar-till: ${b.replyTo ?? "(avsändaren)"}`);
  console.log(`Ämne:     ${b.subject}`);
  console.log("─".repeat(60));
  console.log(b.text);
  console.log("─".repeat(60));
}

if (args.includes("--visa")) {
  skrivBrev(k.byggKontaktbrev(exempel));
  console.log("\nInget skickades.");
  process.exit(0);
}

const provIdx = args.indexOf("--prov");
if (provIdx >= 0) {
  const till = args[provIdx + 1]?.trim();
  if (!till || !till.includes("@")) {
    console.error("Ange din egen adress: npm run massproductions:kontakt -- --prov din@adress.se");
    process.exit(2);
  }
  if (/@massproductions\./i.test(till) || till.toLowerCase() === k.kontaktAdress().toLowerCase()) {
    console.error(`${till} är Massproductions. Provbrevet går bara till din egen adress.`);
    process.exit(2);
  }
  if (!smtpKonfigurerat()) {
    console.error("SMTP_USER och SMTP_PASS saknas i server/.env. Inget kan skickas.");
    process.exit(1);
  }
  const brev = k.byggKontaktbrev(exempel, till);
  skrivBrev(brev);
  try {
    const kvitto = await skickaEttBrev({ ...brev, subject: `[PROV] ${brev.subject}`, headers: { "X-Loopa-Kind": "massproductions-kontakt-prov" } });
    if (!kvitto.accepted.map((a) => a.toLowerCase()).includes(till.toLowerCase())) {
      console.error(`\nFEL: SMTP-servern tog inte emot brevet (avvisad: ${kvitto.rejected.join(", ") || "okänt"}).`);
      process.exit(1);
    }
    console.log(`\nOK: one.com tog emot provbrevet till ${till} (${kvitto.messageId}). Titta i inkorgen, och i skräpposten.`);
    process.exit(0);
  } catch (err) {
    console.error(`\nFEL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

if (args.includes("--skicka-om")) {
  const gjorda = await k.skickaOm({ alla: true });
  if (!gjorda.length) console.log("Inget att skicka om. Alla brev har gått fram.");
  for (const p of gjorda) console.log(`  ${p.status === "skickat" ? "  ok   " : "  FEL  "} ${p.loopaId}: ${p.status}${p.senasteFel ? `: ${p.senasteFel}` : ""}`);
}

// Kontrollen, alltid sist.
console.log(`\nMottagare: ${k.kontaktAdress()}`);
const kontroller = await k.kontrollera();
for (const c of kontroller) console.log(`  [${MARKE[c.utfall]}] ${c.namn}: ${c.text}`);
const poster = await k.listaPoster();
if (poster.length) {
  console.log("\nBreven:");
  for (const p of poster.slice(0, 20)) {
    console.log(`  ${p.skapad.slice(0, 16).replace("T", " ")}  ${p.loopaId.padEnd(10)} ${p.status.padEnd(10)} ${p.forsok} försök${p.senasteFel ? `: ${p.senasteFel}` : ""}`);
  }
}
process.exit(kontroller.some((c) => c.utfall === "fel") ? 1 : 0);

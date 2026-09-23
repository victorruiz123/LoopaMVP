/**
 * Personligt mejl till en lista ur grupper.csv.
 *
 * TORRKÖRNING ÄR FÖRVALET. Utan `--skarpt` skickas ingenting: breven renderas färdiga till
 * ./utskick-forhandsvisning/ så att du kan läsa exakt vad varje mottagare skulle få. Ett utskick går
 * inte att ta tillbaka, och det enda sättet att veta att mallen blev rätt är att läsa den ifylld.
 *
 * ÅTERUPPTAS UTAN DUBBLETTER. Varje skickat brev loggas i utskick-logg.csv, och en adress som redan
 * står där hoppas över vid nästa körning. Ett avbrutet utskick — tappat nät, stängd dator — ska gå
 * att köra om utan att någon får brevet två gånger.
 *
 * Användning:
 *   node scripts/utskick.cjs --fil grupper.csv --grupper A,B --mall mall.txt
 *   node scripts/utskick.cjs --fil grupper.csv --grupper A,B --mall mall.txt --skarpt
 *
 * Mallen är en textfil. Första raden är ämnesraden och börjar med "Ämne:". Resten är brevet.
 * Platshållaren [förnamn] byts ut per mottagare, och [efternamn] om du vill ha det.
 *
 *   Ämne: En fråga till dig som sålde på Vips
 *
 *   Hej [förnamn],
 *   ...
 *   Vill du inte höra från oss igen, svara på det här mejlet med "nej tack".
 *
 * AVANMÄLAN KRÄVS. Skriptet vägrar skicka en mall som inte säger hur man slipper fler brev. Det är
 * inte en formalitet: mottagarna registrerade sig i Vips, inte hos Loopa, och ett utskick utan väg ut
 * är både sämre bemötande och sämre juridik.
 *
 * AVSÄNDAREN sätts med --fran och måste vara en adress vi får skicka från. Se noten längst ned om
 * vad som krävs för info@loopa.nu.
 */

const fs = require("fs");
const path = require("path");

const ROT = path.join(__dirname, "..");
const ENV_FIL = path.join(ROT, "server", ".env");

const env = fs.existsSync(ENV_FIL)
  ? Object.fromEntries(
      fs
        .readFileSync(ENV_FIL, "utf8")
        .split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    )
  : {};

/** Argumenten, som `--nyckel värde`. Flaggor utan värde blir true. */
function args(argv) {
  const ut = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const nyckel = argv[i].slice(2);
    const nasta = argv[i + 1];
    if (!nasta || nasta.startsWith("--")) ut[nyckel] = true;
    else {
      ut[nyckel] = nasta;
      i += 1;
    }
  }
  return ut;
}

const a = args(process.argv.slice(2));
const FIL = a.fil || "grupper.csv";
const MALL = a.mall || "mall.txt";
const GRUPPER = typeof a.grupper === "string" ? a.grupper.split(",").map((g) => g.trim().toUpperCase()) : null;
const SKARPT = a.skarpt === true;
const FRAN = typeof a.fran === "string" ? a.fran : "Loopa <info@loopa.nu>";
const LOGG = a.logg || "utskick-logg.csv";
const FORHANDS = a.forhandsvisning || "utskick-forhandsvisning";
/** Paus mellan breven. Gmail stryper den som skickar hundra brev på en minut. */
const PAUS_MS = Number(a.paus || 1500);

function avbryt(meddelande) {
  console.error(meddelande);
  process.exit(1);
}

// ---- mallen ----------------------------------------------------------------

if (!fs.existsSync(MALL)) avbryt(`Mallen ${MALL} finns inte. Skriv den först — se kommentaren överst i skriptet.`);
const mallText = fs.readFileSync(MALL, "utf8").replace(/\r\n/g, "\n");
const rader = mallText.split("\n");
const amnesrad = rader[0] || "";
if (!/^Ämne:\s*\S/.test(amnesrad)) avbryt('Mallens första rad måste börja med "Ämne: " följt av ämnesraden.');
const AMNE_MALL = amnesrad.replace(/^Ämne:\s*/, "").trim();
const BREV_MALL = rader.slice(1).join("\n").replace(/^\n+/, "");
if (!BREV_MALL.trim()) avbryt("Mallen har en ämnesrad men ingen brevtext.");
if (!/avregistrer|avanmäl|nej tack|slipp|inte höra/i.test(BREV_MALL)) {
  avbryt("Mallen saknar en väg ut. Skriv hur mottagaren slipper fler brev — se noten i skriptet.");
}

/**
 * Platshållarna, ifyllda.
 *
 * `[förnamn]` är formen som står i mallen. Stavningarna utan prickar och med klammer eller måsvingar
 * godtas också — den som skriver brevet ska inte behöva minnas vilken variant skriptet ville ha, och
 * ett obytt "[fornamn]" mitt i ett utskickat brev är precis den sortens fel som inte går att ångra.
 */
const fyll = (text, p) =>
  text
    // [namn] ÄR FÖRNAMNET. Brevet är personligt och inleds "Hej [namn]," — där hör efternamnet inte
    // hemma, och den som skriver mallen ska inte behöva välja mellan två platshållare som betyder
    // nästan samma sak. Alla förekomster byts ut, inte bara den första.
    .replace(/[[{](namn|förnamn|fornamn)[\]}]/gi, p.fornamn)
    .replace(/[[{](helanamn|fulltnamn)[\]}]/gi, [p.fornamn, p.efternamn].filter(Boolean).join(" "))
    .replace(/[[{](efternamn)[\]}]/gi, p.efternamn);

/** Kvarglömda platshållare, t.ex. [stad]. Hittas de stoppas utskicket — se kontrollen nedan. */
const kvarglomda = (text) => [...text.matchAll(/\[[^\]\n]{1,30}\]/g)].map((m) => m[0]);

// ---- mottagarna ------------------------------------------------------------

if (!fs.existsSync(FIL)) avbryt(`Listan ${FIL} finns inte. Kör scripts/grupper.cjs först.`);
const csvRader = fs.readFileSync(FIL, "utf8").trim().split("\n");
const rubriker = csvRader[0].split(";").map((h) => h.trim().toLowerCase());
const kol = (namn) => rubriker.indexOf(namn);
const iGrupp = kol("grupp");
const iFornamn = kol("fornamn");
const iEfternamn = kol("efternamn");
const iEpost = kol("epost");
if (iFornamn < 0 || iEpost < 0) avbryt(`${FIL} saknar kolumnerna fornamn och epost.`);

const alla = csvRader.slice(1).map((rad) => {
  const f = rad.split(";");
  return {
    grupp: iGrupp >= 0 ? (f[iGrupp] || "").trim() : "",
    fornamn: (f[iFornamn] || "").trim(),
    efternamn: iEfternamn >= 0 ? (f[iEfternamn] || "").trim() : "",
    epost: (f[iEpost] || "").trim(),
  };
});

const redanSkickat = new Set(
  fs.existsSync(LOGG)
    ? fs
        .readFileSync(LOGG, "utf8")
        .split("\n")
        .slice(1)
        .map((r) => (r.split(";")[1] || "").trim().toLowerCase())
        .filter(Boolean)
    : [],
);

const mottagare = alla.filter(
  (p) =>
    p.epost &&
    p.fornamn &&
    (!GRUPPER || GRUPPER.includes(p.grupp.toUpperCase())) &&
    !redanSkickat.has(p.epost.toLowerCase()),
);

/**
 * Ingen får ett brev med en platshållare kvar i sig.
 *
 * Prövas på den FÖRSTA mottagaren, alltså på ett verkligt ifyllt brev: det fångar både felstavade
 * namn på platshållare och sådana skriptet aldrig kände till, t.ex. [stad].
 */
if (mottagare.length > 0) {
  const prov = fyll(`${AMNE_MALL}\n${BREV_MALL}`, mottagare[0]);
  const kvar = kvarglomda(prov);
  if (kvar.length) {
    avbryt(
      `Mallen har platshållare som inte går att fylla i: ${[...new Set(kvar)].join(", ")}.\n` +
        `Skriptet kan bara [förnamn] och [efternamn]. Skriv om eller ta bort de andra.`,
    );
  }
}

console.log(`lista: ${FIL} · ${alla.length} rader`);
console.log(`urval: ${GRUPPER ? "grupp " + GRUPPER.join(", ") : "alla grupper"} · ${mottagare.length} mottagare`);
if (redanSkickat.size) console.log(`redan skickat tidigare: ${redanSkickat.size} adresser hoppas över`);
if (mottagare.length === 0) avbryt("Ingen mottagare kvar — inget att göra.");

// ---- torrkörning -----------------------------------------------------------

if (!SKARPT) {
  fs.mkdirSync(FORHANDS, { recursive: true });
  for (const p of mottagare) {
    const namn = p.epost.replace(/[^a-z0-9@._-]/gi, "_");
    const text = [`Från: ${FRAN}`, `Till: ${p.epost}`, `Ämne: ${fyll(AMNE_MALL, p)}`, "", fyll(BREV_MALL, p)].join("\n");
    fs.writeFileSync(path.join(FORHANDS, `${p.grupp || "X"}__${namn}.txt`), text);
  }
  console.log(`\nTORRKÖRNING — ingenting skickat.`);
  console.log(`${mottagare.length} brev renderade till ${path.resolve(FORHANDS)}/`);
  console.log(`Läs igenom några, och kör sedan om med --skarpt för att skicka på riktigt.`);
  process.exit(0);
}

// ---- skarpt läge -----------------------------------------------------------

/**
 * Uppgifterna för avsändaren.
 *
 * SMTP_USER/SMTP_PASS först: det är vägen för en egen brevlåda, t.ex. info@loopa.nu. Utan dem
 * används Gmail-kontot servern redan har — och då MÅSTE adressen i --fran vara ett verifierat alias
 * på det kontot, annars skriver Gmail om avsändaren till kontots egen adress.
 */
const user = env.SMTP_USER || env.GMAIL_USER;
const pass = env.SMTP_PASS || env.GMAIL_APP_PASSWORD;
const host = env.SMTP_HOST || "smtp.gmail.com";
const port = Number(env.SMTP_PORT || 465);
if (!user || !pass) avbryt("Saknar SMTP_USER/SMTP_PASS (eller GMAIL_USER/GMAIL_APP_PASSWORD) i server/.env.");

let nodemailer;
try {
  nodemailer = require(path.join(ROT, "server", "node_modules", "nodemailer"));
} catch {
  avbryt("nodemailer hittades inte. Kör `npm --prefix server install` först.");
}

const sov = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  await transport.verify();
  if (!fs.existsSync(LOGG)) fs.writeFileSync(LOGG, "tid;epost;grupp;amne;status\n");

  console.log(`\nSKARPT LÄGE: skickar ${mottagare.length} brev från ${FRAN} via ${host}.`);
  let ok = 0;
  let fel = 0;
  for (const [i, p] of mottagare.entries()) {
    const amne = fyll(AMNE_MALL, p);
    try {
      await transport.sendMail({ from: FRAN, to: p.epost, subject: amne, text: fyll(BREV_MALL, p) });
      ok += 1;
      fs.appendFileSync(LOGG, `${new Date().toISOString()};${p.epost};${p.grupp};${amne.replace(/;/g, ",")};ok\n`);
    } catch (err) {
      fel += 1;
      const orsak = (err && err.message ? err.message : String(err)).replace(/[;\n]/g, " ").slice(0, 120);
      fs.appendFileSync(LOGG, `${new Date().toISOString()};${p.epost};${p.grupp};${amne.replace(/;/g, ",")};FEL: ${orsak}\n`);
      console.error(`  fel till mottagare ${i + 1}: ${orsak}`);
    }
    // Skriver ut antal, aldrig adresser: terminalen sparas i historiken.
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${mottagare.length} …`);
    if (i < mottagare.length - 1) await sov(PAUS_MS);
  }
  console.log(`\nKlart: ${ok} skickade, ${fel} fel. Logg: ${path.resolve(LOGG)}`);
})();

/**
 * OM AVSÄNDAREN info@loopa.nu
 *
 * Gmail skickar bara från en adress kontot äger eller har verifierat som alias. Två vägar:
 *
 *   1. Alias på det befintliga Gmail-kontot: Gmail → Inställningar → Konton → "Skicka e-post som" →
 *      lägg till info@loopa.nu och verifiera med koden som skickas dit. Därefter fungerar
 *      --fran "Loopa <info@loopa.nu>" med kontots vanliga applösenord.
 *   2. Egen brevlåda hos den som hanterar loopa.nu: sätt SMTP_HOST, SMTP_PORT, SMTP_USER och
 *      SMTP_PASS i server/.env. Då rör utskicket inte Gmail-kontot alls.
 *
 * Utan något av detta kommer brevet fram med Gmail-adressen som avsändare, oavsett vad --fran säger.
 */

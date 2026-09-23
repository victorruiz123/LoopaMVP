/**
 * Delar in konton i fyra grupper för ett utskick, och skriver dem till en CSV-fil.
 *
 * GRUPPERNA ÄR ÖMSESIDIGT UTESLUTANDE. Ingen person hamnar i två grupper: A och B tas ur dem som har
 * telefonnummer, C och D ur dem som har en Gmail-adress OCH inte redan tagits till A eller B.
 *
 *   A, B  20 personer var med telefonnummer i profilen
 *   C, D  20 personer var med gmail.com-adress, utanför A och B
 *
 * BARA KONTON REGISTRERADE FÖRE JULI 2026. Gränsen går på `created_at` i profiltabellen, alltså när
 * kontot skapades i Vips. Ett konto utan datum räknas INTE med: "okänt" är inte samma sak som
 * "gammalt", och ett utskick till fel personer går inte att ta tillbaka.
 *
 * URVALET ÄR NYAST FÖRST och inte slumpat, så att två körningar ger samma listor. Konton utan både
 * för- och efternamn hoppas över — tabellen ska ha ett namn att skriva ut — och Loopas egna konton
 * räknas bort.
 *
 * Uppgifterna hämtas ur profiltabellen i Supabase, som delas med Vips. Det är där telefonnumren och
 * namnen ligger; Supabases inloggningsuppgifter är tomma (se server/src/admin.ts).
 *
 * KÖRS FÖR HAND, och skriver till en fil i stället för till terminalen: det här är personuppgifter,
 * och de ska inte ligga i ett skalfönster eller i en loggfil längre än de behöver.
 *
 *   node scripts/grupper.cjs grupper.csv
 *
 * Kräver SUPABASE_SERVICE_ROLE_KEY i server/.env. Filen som skapas innehåller namn, telefonnummer och
 * e-postadresser — behandla den därefter, och ta bort den när utskicket är gjort.
 */

const fs = require("fs");
const path = require("path");

const ENV_FIL = path.join(__dirname, "..", "server", ".env");
const env = Object.fromEntries(
  fs
    .readFileSync(ENV_FIL, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

/** Samma förval som servern använder när SUPABASE_URL inte är satt — se server/src/supabaseAuth.ts. */
const BAS = env.SUPABASE_URL || "https://tyxqxodnfyzxpwdgtypd.supabase.co";
const NYCKEL = env.SUPABASE_SERVICE_ROLE_KEY;

/** Loopas egna konton räknas inte som mottagare. */
const EGNA = ["isacekelund07@gmail.com", "victor@ruiz.se"];

const UT = process.argv[2] || "grupper.csv";
const PER_GRUPP = 20;

/**
 * Bara konton som fanns före juli 2026.
 *
 * Jämförelsen görs på strängen och inte på ett datumobjekt: `created_at` kommer som ISO-tid från
 * PostgREST, och "2026-06-30T23:59:59Z" < "2026-07-01" är sant teckenvis. Ett tomt eller trasigt
 * datum faller därmed också bort, vilket är avsikten.
 */
const SENAST = "2026-07-01";

if (!NYCKEL) {
  console.error("SUPABASE_SERVICE_ROLE_KEY saknas i server/.env — utan den går profiltabellen inte att läsa.");
  process.exit(1);
}

/** Ett fält i en CSV: citera bara när det behövs, och dubbla citattecken inuti. */
function falt(v) {
  const s = (v ?? "").toString().trim();
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

(async () => {
  const url = `${BAS}/rest/v1/profiles?select=full_name,phone,email,created_at&limit=1000`;
  const res = await fetch(url, { headers: { apikey: NYCKEL, Authorization: `Bearer ${NYCKEL}` } });
  if (!res.ok) {
    console.error("Profiltabellen svarade", res.status, (await res.text()).slice(0, 200));
    process.exit(1);
  }
  const rader = await res.json();

  const delar = (p) => (p.full_name || "").trim().split(/\s+/).filter(Boolean);
  const harNamn = (p) => delar(p).length >= 2;
  const harTelefon = (p) => (p.phone || "").trim().length >= 6;
  const harGmail = (p) => /@gmail\.com$/i.test((p.email || "").trim());

  const foreJuli = (p) => typeof p.created_at === "string" && p.created_at < SENAST;

  const pool = rader
    .filter((p) => !EGNA.includes((p.email || "").toLowerCase()))
    .filter(foreJuli)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const medTelefon = pool.filter((p) => harTelefon(p) && harNamn(p));
  const A = medTelefon.slice(0, PER_GRUPP);
  const B = medTelefon.slice(PER_GRUPP, PER_GRUPP * 2);

  // Redan tagna räknas bort på e-post: samma person ska aldrig få två utskick.
  const tagna = new Set([...A, ...B].map((p) => (p.email || "").toLowerCase()));
  const medGmail = pool.filter((p) => harGmail(p) && harNamn(p) && !tagna.has((p.email || "").toLowerCase()));
  const C = medGmail.slice(0, PER_GRUPP);
  const D = medGmail.slice(PER_GRUPP, PER_GRUPP * 2);

  const utrader = ["grupp;fornamn;efternamn;telefon;epost"];
  for (const [grupp, lista] of [["A", A], ["B", B], ["C", C], ["D", D]]) {
    for (const p of lista) {
      const d = delar(p);
      utrader.push([grupp, falt(d[0]), falt(d.slice(1).join(" ")), falt(p.phone), falt(p.email)].join(";"));
    }
  }
  fs.writeFileSync(UT, utrader.join("\n") + "\n");

  console.log(`profiler: ${rader.length} · registrerade före ${SENAST}: ${pool.length}`);
  console.log(`med telefon och namn: ${medTelefon.length} · gmail och namn utanför A/B: ${medGmail.length}`);
  console.log(`grupp A ${A.length} · B ${B.length} · C ${C.length} · D ${D.length}`);
  // En grupp som inte blev full säger det här, i stället för att en kortare lista upptäcks i Excel.
  for (const [namn, lista] of [["A", A], ["B", B], ["C", C], ["D", D]]) {
    if (lista.length < PER_GRUPP) console.log(`OBS: grupp ${namn} fick bara ${lista.length} av ${PER_GRUPP} — underlaget räckte inte.`);
  }
  console.log(`skrivet till ${path.resolve(UT)}`);
})();

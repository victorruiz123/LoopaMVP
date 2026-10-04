/**
 * Provkörning av Traderas prisändring, från terminalen. Motsvarigheten till blocket:pris.
 *
 *   npm run tradera:pris -- --item <itemId>                     läser annonsen som Tradera ser den: pris, typ, bud, läge
 *   npm run tradera:pris -- --item <itemId> --pris <kr> --skarpt  sätter priset (Köp nu-pris, eller utropspris med --auktion) och läser om
 *   npm run tradera:pris -- <jobId> [--skarpt]                  samma, för jobbets Tradera-annons; priset är stegens (möbeln + hemleverans)
 *
 * Tradera har ett API, så här finns ingen robot: det är ETT anrop, `PUT /listings/items/{id}/price`
 * (tradera.ts `updateTraderaPrice`), samma som prisstegen gör varje vecka. Skriptet finns för att
 * kunna se anropet gå igenom på en riktig annons och läsa svaret, med samma nycklar som servern.
 *
 * Kräver TRADERA_APP_ID/APP_KEY/USER_ID/USER_TOKEN — de ligger på servern, inte lokalt. Kör där:
 *   cd /opt/loopa && ./server/node_modules/.bin/tsx server/src/integrations/tradera/pris-prov.ts --item 752969544
 *
 * Skriver inget kvitto på jobbet; stegen bekräftar kanalen själv vid nästa varv (eller "Ändrat för
 * hand" i panelen).
 */

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { getJob } = await import("../../jobStore.js");
const { annonsensFrakt, prisMedHemleverans } = await import("../../hemleverans.js");
const { kategoriMedRattelse } = await import("../../butik/overrides.js");
const { kanalPrisLagen } = await import("../../priceLadder.js");
const { getTraderaItem, missingTraderaEnv, updateTraderaPrice } = await import("./tradera.js");

const args = process.argv.slice(2);
const flagga = (namn: string): string | null => {
  const i = args.indexOf(namn);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const skarpt = args.includes("--skarpt");
const auktion = args.includes("--auktion");
const itemFlagga = flagga("--item");
const prisFlagga = flagga("--pris");
const jobId = args.find((a) => !a.startsWith("--") && a !== itemFlagga && a !== prisFlagga)?.trim();

if (!itemFlagga && !jobId) {
  console.error("\n  Användning:");
  console.error("    npm run tradera:pris -- --item <itemId>");
  console.error("    npm run tradera:pris -- --item <itemId> --pris <kr> --skarpt [--auktion]");
  console.error("    npm run tradera:pris -- <jobId> [--skarpt]\n");
  process.exit(1);
}

console.log("\nTradera-prisändring, provkörning\n");

const saknas = missingTraderaEnv();
if (saknas.length) {
  console.error(`  ✗ Tradera är inte konfigurerat här. Saknar: ${saknas.join(", ")} — nycklarna ligger på servern.\n`);
  process.exit(1);
}

let itemId: number;
let nyttPris: number | null = null;
let mode: "auction" | "fixed" = auktion ? "auction" : "fixed";

if (itemFlagga) {
  itemId = Number(itemFlagga);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    console.error(`  ✗ --item ska vara Traderas artikelnummer, inte "${itemFlagga}".\n`);
    process.exit(1);
  }
  if (prisFlagga !== null) {
    nyttPris = Math.round(Number(prisFlagga));
    if (!Number.isFinite(nyttPris) || nyttPris < 1) {
      console.error(`  ✗ --pris ska vara ett belopp i kronor, inte "${prisFlagga}".\n`);
      process.exit(1);
    }
  }
} else {
  const job = await getJob(jobId!);
  if (!job) {
    console.error(`  ✗ Hittade inget jobb med id ${jobId}.\n`);
    process.exit(1);
  }
  if (job.tradera?.status !== "published" || typeof job.tradera.itemId !== "number") {
    console.error("  ✗ Jobbet har ingen publicerad Tradera-annons.\n");
    process.exit(1);
  }
  if (!job.priceLadder) {
    console.error("  ✗ Jobbet har ingen prissteg, så det finns inget pris att flytta till.\n");
    process.exit(1);
  }
  itemId = job.tradera.itemId;
  mode = job.priceLadder.listingMode ?? "fixed";
  const frakt = annonsensFrakt(job, await kategoriMedRattelse(job));
  nyttPris = prisMedHemleverans(job.priceLadder.currentPrice, frakt);
  const lage = kanalPrisLagen(job).find((l) => l.kanal === "tradera");
  console.log(`  Jobb:         ${job.id}`);
  console.log(`  Stegen:       möbeln ${job.priceLadder.currentPrice} kr + ${frakt} kr hemleverans = ${nyttPris} kr i annonsen`);
  console.log(`  Kvittot:      ${lage ? `${prisMedHemleverans(lage.bekraftat, frakt)} kr (${lage.via})` : "inget"}`);
}

/** De fält i Traderas artikel som säger något om priset och läget. Schemat har ~40 fält till. */
function sammanfatta(item: unknown): Record<string, unknown> {
  const o = (item ?? {}) as Record<string, unknown>;
  const ut: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (/price|bid|itemType|status|endDate|startDate|title|shortDescription|quantity/i.test(k) && v !== null && typeof v !== "object") ut[k] = v;
  }
  const status = o.status as Record<string, unknown> | undefined;
  if (status && typeof status === "object") ut.status = status;
  return ut;
}

console.log(`  Artikel:      ${itemId}  (https://www.tradera.com/item/${itemId})`);
console.log(`  Läge:         ${skarpt && nyttPris !== null ? `SKARPT — sätter ${mode === "fixed" ? "Köp nu-priset" : "utropspriset"} till ${nyttPris} kr` : "läser bara"}\n`);

const fore = await getTraderaItem(itemId);
console.log("  Före:", JSON.stringify(sammanfatta(fore), null, 2).replace(/\n/g, "\n  "));

if (skarpt && nyttPris !== null) {
  try {
    await updateTraderaPrice(itemId, nyttPris, mode);
    console.log(`\n  ✓ PUT /listings/items/${itemId}/price gick igenom (${mode === "fixed" ? "binPrice" : "openingPrice"}: ${nyttPris})`);
  } catch (err) {
    console.error(`\n  ✗ Tradera avvisade prisändringen: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const efter = await getTraderaItem(itemId);
  console.log("\n  Efter:", JSON.stringify(sammanfatta(efter), null, 2).replace(/\n/g, "\n  "));
  console.log("\n  Kontrollera på tradera.com — Köp nu-priset brukar slå igenom direkt.\n");
} else if (nyttPris !== null) {
  console.log(`\n  Torrkörning: hade satt ${nyttPris} kr. Lägg till --skarpt för att göra det.\n`);
} else {
  console.log("\n  Bara läst. Ange --pris <kr> --skarpt för att ändra.\n");
}

/**
 * Kontrollerad SKARP publicering av EN Loopa-annons genom den vanliga kön — med räcken runt.
 *
 *   npx tsx scripts/facebook-kontrollerad-publicering.mts LP-9X20-66BZ [--max 3] [--skarpt]
 *
 * Utan --skarpt är det en torrkörning genom kön (WOULD_PUBLISH). Med --skarpt trycks Publicera:
 * Marketplace först, sedan grupperna i köordning, med köns vanliga paus mellan skrivningarna.
 *
 * RÄCKEN, alla före första skrivningen:
 *   1. Growth-projektet (samma Facebook-konto) får inte kunna skriva: dess publicerare OCH ansökare
 *      måste vara pausade och dess torrkörning på. Annars körs ingenting.
 *   2. Kön får bara innehålla den utpekade annonsen — inga andra QUEUED-poster.
 *   3. Kontoräcket i webbläsaren (FACEBOOK_ACCOUNT_ID) gäller som vanligt.
 *
 * Skriptet är en orkestrering av den befintliga kön (enqueueForListing + processQueue) — inte en
 * egen publiceringsväg. Allt som händer bokförs i lagret precis som när servern kör.
 */
// server/.env FÖRST (LÄRDOM 2026-09-26: utan den blev den kanoniska adressen app.loopa.nu i det publicerade
// säljinlägget). Inställningarna läses vid anrop, så det räcker att filen är inläst innan kön körs.
try {
  process.loadEnvFile(new URL("../server/.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}
// Dynamiska importer, som cli.ts: statiska importer körs FÖRE modulkroppen och hade sett en tom miljö.
const { facebookAccountId, facebookDryRun } = await import("../server/src/integrations/facebook/config.ts");
const { listingChannelStatus } = await import("../server/src/integrations/facebook/admin.ts");
const { enqueueForListing, processQueue } = await import("../server/src/integrations/facebook/queue.ts");
const { allGroupPublications, allMarketplace, readSession } = await import("../server/src/integrations/facebook/store.ts");
const { jobByLoopaId } = await import("../server/src/publicCard.ts");

const args = process.argv.slice(2);
const loopaId = args.find((a) => !a.startsWith("--"));
const skarpt = args.includes("--skarpt");
const maxIdx = args.indexOf("--max");
const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 3;
if (!loopaId) {
  console.error("Ange ett Loopa-ID.");
  process.exit(1);
}
if (!Number.isInteger(max) || max < 1 || max > 10) {
  console.error(`--max måste vara ett heltal 1–10 (fick ${args[maxIdx + 1] ?? "inget"}).`);
  process.exit(1);
}
if (!process.env.LOOPA_PUBLIC_URL) {
  console.error("STOPP: LOOPA_PUBLIC_URL är inte satt — den kanoniska adressen hade blivit förvalet app.loopa.nu.");
  process.exit(2);
}
process.env.FACEBOOK_ENABLED = "1";
process.env.FACEBOOK_DRY_RUN = skarpt ? "false" : "true";

const GROWTH_STATUS = process.env.GROWTH_STATUS_URL ?? "http://127.0.0.1:4310/api/status";

async function growthKanSkriva(): Promise<string | null> {
  try {
    const res = await fetch(GROWTH_STATUS, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null; // Ingen Growth-server svarar = den kör inte.
    const s = (await res.json()) as { publisher?: string; joiner?: string; scanner?: string; dry_run?: boolean; all_paused?: boolean };
    const problem: string[] = [];
    if (!s.all_paused) {
      if (s.publisher !== "PAUSED") problem.push(`publisher=${s.publisher}`);
      if (s.joiner !== "PAUSED") problem.push(`joiner=${s.joiner}`);
    }
    if (s.dry_run === false) problem.push("dry_run=false");
    return problem.length ? `Growth (${GROWTH_STATUS}) kan skriva på kontot: ${problem.join(", ")}. Pausa publiceraren och ansökaren i Growth (eller stoppa dess server) och kör igen.` : null;
  } catch {
    return null; // Nås inte = kör inte.
  }
}

const growth = await growthKanSkriva();
if (growth) {
  console.error(`STOPP: ${growth}`);
  process.exit(2);
}
console.log("Growth: pausad eller avstängd — ok.");

const session = await readSession();
console.log(`Session: ${session?.status ?? "okänd"} (konto ${session?.accountId ?? "?"}; förväntat ${facebookAccountId() ?? "ingen kontroll"})`);

const job = await jobByLoopaId(loopaId);
if (!job) {
  console.error(`Hittar inget jobb för ${loopaId}.`);
  process.exit(1);
}
const ko = await enqueueForListing(loopaId, job.id);
console.log("Köat:", JSON.stringify(ko));

const frammande = [
  ...(await allMarketplace()).filter((p) => p.status === "QUEUED" && p.listingId !== loopaId).map((p) => `marketplace ${p.listingId}`),
  ...(await allGroupPublications()).filter((p) => p.status === "QUEUED" && p.listingId !== loopaId).map((p) => `grupp ${p.listingId} → ${p.groupId}`),
];
if (frammande.length) {
  console.error(`STOPP: kön innehåller annat än ${loopaId}: ${frammande.join("; ")}`);
  process.exit(2);
}
const egna = (await allGroupPublications()).filter((p) => p.listingId === loopaId && p.status === "QUEUED").map((p) => p.groupId);
console.log(`I kö för ${loopaId}: Marketplace ${(await allMarketplace()).find((p) => p.listingId === loopaId)?.status ?? "—"}, grupper ${egna.join(", ") || "—"}`);
console.log(skarpt ? `SKARPT LÄGE: Publicera trycks (max ${max} skrivningar).` : "TORRKÖRNING genom kön (Publicera trycks inte).");
console.log("torrkörning enligt config:", facebookDryRun(), "| LOOPA_PUBLIC_URL:", process.env.LOOPA_PUBLIC_URL);

const result = await processQueue({ max, force: true });
console.log("Resultat:", JSON.stringify(result, null, 2));
console.log("Kanalstatus:", JSON.stringify(await listingChannelStatus(loopaId), (k, v) => (k === "steps" ? `${(v as unknown[]).length} steg` : v), 2));
process.exit(0);

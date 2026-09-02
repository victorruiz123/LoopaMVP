/**
 * Publicerar eller avpublicerar butikens utkast — en driftåtgärd, inte en väg i appen.
 *
 * Att publicera är normalt SÄLJARENS handling: en besiktning är inte ett medgivande till försäljning,
 * och syncFromJobs släpper därför bara fram det som redan ligger uppe på Tradera. Det här skriptet
 * finns för att fylla en butik som ännu inte har säljare som tryckt på knappen — och för att kunna
 * ta tillbaka det igen, vilket är varför `av` finns i samma fil som `på`.
 *
 *   npx tsx scripts/butik-drafts.ts publicera     # alla butiksfärdiga utkast -> live
 *   npx tsx scripts/butik-drafts.ts avpublicera   # alla live -> utkast
 *   npx tsx scripts/butik-drafts.ts status
 */

process.loadEnvFile(new URL("../server/.env", import.meta.url));

const { store, publish, unpublish } = await import("../server/src/butik/store.js");
const { syncFromJobs, invalidate } = await import("../server/src/butik/inventory.js");

const actor = { kind: "admin", userId: null } as const;
const command = process.argv[2] ?? "status";

await syncFromJobs();
const records = await store().all();
const counts = records.reduce<Record<string, number>>((acc, r) => {
  acc[r.state] = (acc[r.state] ?? 0) + 1;
  return acc;
}, {});

if (command === "status") {
  console.log("Butikens lager:", counts);
} else if (command === "publicera") {
  let n = 0;
  for (const r of records) if (r.state === "draft" && (await publish(r.id, actor))) n += 1;
  invalidate();
  console.log(`${n} utkast publicerade.`);
} else if (command === "avpublicera") {
  let n = 0;
  for (const r of records) if (r.state === "live" && (await unpublish(r.id, actor))) n += 1;
  invalidate();
  console.log(`${n} varor avpublicerade.`);
} else {
  console.error(`Okänt kommando: ${command}. Använd publicera | avpublicera | status.`);
  process.exit(1);
}

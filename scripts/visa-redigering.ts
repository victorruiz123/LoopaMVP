/**
 * Visa redigeringsrobotarna i ett synligt fönster, med en exempeländring som ALDRIG sparas.
 *
 *   npm run annons:visa                 listar annonser som ligger ute på Blocket eller Facebook
 *   npm run annons:visa -- LP-XXXX-XXXX kör visningen för den annonsen (Loopa-ID eller jobb-id)
 *
 * Körs på servern med ett fönster till den egna datorn (ssh -Y + XQuartz), som inloggningarna —
 * sessionerna finns bara där.
 *
 * VAD SOM INTE HÄNDER, och varför:
 *  - Ingenting sparas på Blocket eller Facebook. Robotarna får `visning` och är då alltid i
 *    torrkörning, oavsett BLOCKET_REDIGERA/FACEBOOK_REDIGERA; de stannar där Spara hade tryckts.
 *  - Ingenting sparas hos Loopa. Exempeländringen är en mening sist i beskrivningen, i minnet; jobbet
 *    och rättelserna skrivs inte.
 *  - Tradera körs inte alls. Där är uppdateringen att ta ner annonsen och lägga upp den igen, och det
 *    går inte att visa utan att göra det på riktigt.
 */

import { createInterface } from "node:readline/promises";

try {
  process.loadEnvFile(new URL("../server/.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}
// Före importerna: modulerna läser miljön när de laddas.
process.env.BLOCKET_SYNLIG = "1";
process.env.FACEBOOK_HEADFUL = "1";
delete process.env.BLOCKET_REDIGERA;
delete process.env.FACEBOOK_REDIGERA;

const { getJob, listJobs } = await import("../server/src/jobStore.ts");
const { loopaIdFor } = await import("../server/src/loopaId.ts");
const { adTitle } = await import("../server/src/adContent.ts");
const { allGroupPublications, allMarketplace } = await import("../server/src/integrations/facebook/store.ts");
const { redigeraBlocketAnnons } = await import("../server/src/integrations/blocket/redigera.ts");
const { redigeraFacebook } = await import("../server/src/integrations/facebook/redigera.ts");

const TILLAGG = "(Exempeländring från Loopa — visas bara, sparas inte.)";
const rl = createInterface({ input: process.stdin, output: process.stdout });

const fbUppe = new Set<string>();
for (const p of [...(await allMarketplace()), ...(await allGroupPublications())]) {
  if (p.status === "PUBLISHED") fbUppe.add(p.listingId);
}

const arg = process.argv[2]?.trim();
const jobb = await listJobs();
const traff = arg ? ((await getJob(arg)) ?? jobb.find((j) => loopaIdFor(j.id) === arg.toUpperCase())) : undefined;

if (!traff) {
  if (arg) console.log(`\nHittade ingen annons för "${arg}".`);
  console.log("\nAnnonser som ligger ute på Blocket eller Facebook:\n");
  for (const j of jobb) {
    const id = loopaIdFor(j.id);
    const kanaler = [j.blocket?.status === "published" ? "Blocket" : null, fbUppe.has(id) ? "Facebook" : null].filter(Boolean);
    if (kanaler.length) console.log(`  ${id}  ${adTitle(j).slice(0, 50).padEnd(50)}  ${kanaler.join(" + ")}`);
  }
  console.log("\nKör sedan: npm run annons:visa -- <Loopa-ID>\n");
  rl.close();
  process.exit(0);
}

// En egen kopia: ingenting robotarna gör med jobbet når det som servern har i minnet eller på disk.
const job = structuredClone(traff);
const loopaId = loopaIdFor(job.id);
let n = 0;
const paus = async (vad: string): Promise<void> => {
  n += 1;
  await rl.question(`\n  [${n}] ${vad}\n      Titta i fönstret. Tryck Enter för att gå vidare… `);
};

console.log(`
VISNING AV REDIGERINGSROBOTARNA — ingenting sparas
  Annons:        ${loopaId}  ${adTitle(job)}
  Exempeländring: en mening sist i beskrivningen: "${TILLAGG}"
  Tradera:       körs inte (där tas annonsen ner och läggs upp igen — det går inte att visa utan att göra det)
`);

for (const [namn, uppe, kor] of [
  ["Blocket", job.blocket?.status === "published", () => redigeraBlocketAnnons(job, { tillagg: TILLAGG, paus })],
  ["Facebook", fbUppe.has(loopaId), () => redigeraFacebook(job, { tillagg: TILLAGG, paus })],
] as const) {
  if (!uppe) {
    console.log(`\n— ${namn}: annonsen ligger inte ute där, hoppar över.`);
    continue;
  }
  await rl.question(`\n— ${namn}: tryck Enter för att öppna fönstret… `);
  const utfall = await kor();
  console.log(`\n  ${namn} → ${utfall.status.toUpperCase()}: ${utfall.detalj}`);
  if (namn === "Blocket" && job.blocket?.redigeringSteg?.length) {
    for (const s of job.blocket.redigeringSteg) console.log(`      ${s.status.padEnd(8)} ${s.name}`);
  }
}

console.log("\nKlart. Ingenting sparades — varken på Blocket, Facebook eller hos Loopa.\n");
rl.close();
process.exit(0);

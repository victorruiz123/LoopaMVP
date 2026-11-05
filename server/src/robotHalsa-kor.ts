/**
 * Robotarnas hälsokontroll, från terminalen.
 *
 *   npm run robotar:halsa              kör, skriv ut, spara — inget brev
 *   npm run robotar:halsa -- --brev    som ovan, och mejla adminadresserna efter samma regel som schemat
 *
 * Samma kod som servern kör varje morgon (robotHalsa.ts). Rapporten sparas där panelen läser den.
 * Kör inte medan servern publicerar: skriptet är en egen process och ser inte serverns upptagetflaggor.
 */

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { korOchRapportera } = await import("./robotHalsa.js");

const MARKE = { ok: "  ok   ", varning: "varning", fel: "  FEL  ", av: "  av   " } as const;

const rapport = await korOchRapportera({ mejla: process.argv.includes("--brev") });
for (const r of rapport.robotar) {
  console.log(`\n${r.robot.toUpperCase()} — ${r.utfall}`);
  for (const k of r.kontroller) console.log(`  [${MARKE[k.utfall]}] ${k.namn}: ${k.text}`);
}
console.log(`\nTotalt: ${rapport.utfall} (${rapport.sekunder} s)`);
process.exit(rapport.utfall === "fel" ? 1 : 0);

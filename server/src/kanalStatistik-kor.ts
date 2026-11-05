/**
 * Ett svep av säljarnas marknadsplatssiffror, från terminalen.
 *
 *   npm run statistik:svep
 *
 * Samma kod som servern kör var tredje timme (kanalStatistik.ts). Siffrorna sparas där säljarens
 * annonsvy läser dem. Kör inte medan servern publicerar på Blocket: skriptet är en egen process och
 * ser inte serverns Blocket-lås.
 */

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const { svepAlla } = await import("./kanalStatistik.js");

const start = Date.now();
const r = await svepAlla();
console.log(`Tradera  ${r.tradera.status}: ${r.tradera.detalj}`);
console.log(`Blocket  ${r.blocket.status}: ${r.blocket.detalj}`);
console.log(`(${Math.round((Date.now() - start) / 1000)} s)`);
process.exit(r.tradera.status === "fel" || r.blocket.status === "fel" ? 1 : 0);

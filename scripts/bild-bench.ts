/**
 * Modelljämförelsen: läser argumenten och lämnar över.
 *
 * Allt arbete ligger i server/src/pipeline/bild/jamfor.ts — dels för att ett skript här inte kan
 * importera sharp och onnxruntime (de bor i server/node_modules), dels för att jämförelsen då kör
 * exakt samma kod som driften i stället för en kopia av den.
 *
 *   npx tsx scripts/bild-bench.ts                          # 10 bilder, alla modeller
 *   npx tsx scripts/bild-bench.ts --antal 20               # fler bilder
 *   npx tsx scripts/bild-bench.ts --modeller birefnet-general,isnet-general-use
 *   npx tsx scripts/bild-bench.ts --bild <sökväg>          # en utpekad bild
 *   npx tsx scripts/bild-bench.ts --ut bench               # var sidan hamnar
 *
 * Kör med PRODUKTBILD_TRADAR=4 (eller antalet kärnor).
 */

import { jamfor } from "../server/src/pipeline/bild/jamfor.js";

function flagga(namn: string): string | null {
  const i = process.argv.indexOf(`--${namn}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const modeller = flagga("modeller");
await jamfor({
  antal: Number(flagga("antal") ?? 10),
  modeller: modeller ? modeller.split(",").map((s) => s.trim()) : undefined,
  bild: flagga("bild"),
  ut: flagga("ut") ?? undefined,
});

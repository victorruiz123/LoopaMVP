/**
 * Bevakningar → efterlysningar.
 *
 * Butikens `bevakningar` var samma sak i mindre: en sparad sökning som skulle höra av sig. De två
 * får inte leva bredvid varandra, för då räknar efterfrågeväggen, säljarkroken och annonsutkasten
 * olika beroende på vilket register de läser.
 *
 * IDEMPOTENT OCH ICKE-DESTRUKTIV. Körningen märker den gamla filen som migrerad i stället för att
 * radera den, och hoppar över rader som redan har en efterlysning. En migrering som körs vid varje
 * uppstart måste tåla att köras vid varje uppstart — och den gamla filen är den enda kopian av data
 * som inte går att räkna fram igen.
 *
 * Fälten går över ETT TILL ETT: bevakningens `brand` (ental) blir `brands: [brand]`, resten heter
 * redan samma sak i `ProductFilter`. Det som inte fanns — stil, deadline, brådska, anteckning —
 * lämnas tomt i stället för gissat.
 */

import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../jobStore.js";
import * as store from "./store.js";

interface LegacyBevakning {
  id: string;
  userId: string;
  email: string | null;
  categorySlug: string | null;
  brand: string | null;
  maxPriceSek: number | null;
  maxWidthMm: number | null;
  maxDepthMm: number | null;
  maxHeightMm: number | null;
  createdAt: string;
  notifiedProductIds: string[];
}

function legacyFile(): string {
  return path.join(process.env.BUTIK_DATA_DIR?.trim() || path.join(DATA_DIR, "butik"), "bevakningar.json");
}

/** En mening ur en gammal bevakning, i samma form som tolkningen skriver dem. */
function summaryOf(b: LegacyBevakning, categoryLabel: (slug: string) => string): string {
  const parts: string[] = [];
  if (b.categorySlug) parts.push(categoryLabel(b.categorySlug));
  if (b.brand) parts.push(b.brand);
  if (b.maxPriceSek) parts.push(`max ${b.maxPriceSek.toLocaleString("sv-SE")} kr`);
  return parts.join(" · ") || "Sparad bevakning";
}

export interface MigrationResult {
  found: number;
  migrated: number;
  skipped: number;
}

export async function migrateBevakningar(): Promise<MigrationResult> {
  let rows: LegacyBevakning[];
  try {
    rows = JSON.parse(await readFile(legacyFile(), "utf-8")) as LegacyBevakning[];
  } catch {
    // Ingen fil = inget att migrera. Det vanliga fallet, och inte ett fel.
    return { found: 0, migrated: 0, skipped: 0 };
  }

  const { categoryLabel } = await import("../butik/catalog.js");
  const existing = await store.all();
  // Nyckeln är (användare, kategori, maxpris): en bevakning har inget id vi sparat vidare, och två
  // körningar av samma fil ska inte ge två efterlysningar.
  const seen = new Set(
    existing.map((e) => `${e.userId}:${e.filter.categorySlug ?? ""}:${e.filter.maxPriceSek ?? ""}`),
  );

  let migrated = 0;
  let skipped = 0;
  for (const b of rows) {
    const key = `${b.userId}:${b.categorySlug ?? ""}:${b.maxPriceSek ?? ""}`;
    if (seen.has(key)) { skipped += 1; continue; }
    seen.add(key);
    await store.create({
      userId: b.userId,
      email: b.email,
      filter: {
        categorySlug: b.categorySlug,
        brands: b.brand ? [b.brand] : null,
        maxPriceSek: b.maxPriceSek,
        maxWidthMm: b.maxWidthMm,
        maxDepthMm: b.maxDepthMm,
        maxHeightMm: b.maxHeightMm,
      },
      styleTags: [],
      deadline: null,
      urgency: "none",
      note: null,
      summary: summaryOf(b, categoryLabel),
      // Egen märkning: en migrerad bevakning är varken chattad eller ifylld, och att kalla den det
      // ena hade förorenat måttet på hur folk faktiskt skapar efterlysningar.
      parseMethod: "butik_filter",
      area: null,
    });
    migrated += 1;
  }

  if (migrated > 0) {
    // Flyttas undan, inte raderas. Filen är den enda kopian av data som inte går att räkna fram igen.
    await rename(legacyFile(), `${legacyFile()}.migrerad`).catch(() => undefined);
  }
  return { found: rows.length, migrated, skipped };
}

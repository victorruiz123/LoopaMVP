/**
 * Engångsscript: skriver ut de id-nummer mapping.ts hårdkodar, så uppslaget går att göra om.
 *
 *   npm run tradera:lookup
 *
 * Kräver bara TRADERA_APP_ID och TRADERA_APP_KEY — ingen user-token, ingenting publiceras.
 */

import { TRADERA_SKICK_ATTRIBUTE_ID } from "./mapping.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // Variablerna kan lika gärna komma ur skalet.
}

const BASE = "https://api.tradera.com/v4";
const HEADERS = {
  "X-App-Id": process.env.TRADERA_APP_ID ?? "",
  "X-App-Key": process.env.TRADERA_APP_KEY ?? "",
};

interface Category {
  id: number;
  name: string;
  childCategories?: Category[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** Kategoriträdet är stort (260 kB) — vi skriver bara ut möbelgrenarna. */
function walk(node: Category, trail: string[], out: Array<{ id: number; path: string; leaf: boolean }>): void {
  const here = [...trail, node.name];
  const children = node.childCategories ?? [];
  if (/möbler|inredning/i.test(here.join(" > "))) {
    out.push({ id: node.id, path: here.join(" > "), leaf: children.length === 0 });
  }
  for (const child of children) walk(child, here, out);
}

async function main(): Promise<void> {
  if (!HEADERS["X-App-Id"] || !HEADERS["X-App-Key"]) {
    console.error("Sätt TRADERA_APP_ID och TRADERA_APP_KEY först (server/.env).");
    process.exit(1);
  }

  console.log("== Möbelkategorier (L = bladkategori, det är dem annonser läggs i) ==");
  const categories = await get<Category[]>("/categories");
  const furniture: Array<{ id: number; path: string; leaf: boolean }> = [];
  for (const root of categories) walk(root, [], furniture);
  for (const c of furniture) console.log(`${c.leaf ? "L" : " "} ${c.id}\t${c.path}`);

  console.log("\n== Fraktsätt och skickflaggor (reference-data/item-field-values) ==");
  const fields = await get<{
    itemAttributes: Array<{ id: number; description: string }>;
    paymentTypes: Array<{ id: number; description: string }>;
    shippingTypes: Array<{ id: number; description: string }>;
  }>("/reference-data/item-field-values");
  console.log("itemAttributes:", fields.itemAttributes.map((a) => `${a.id}=${a.description}`).join(", "));
  console.log("shippingTypes: ", fields.shippingTypes.map((s) => `${s.id}=${s.description}`).join(", "));
  console.log("paymentTypes:  ", fields.paymentTypes.map((p) => `${p.id}=${p.description}`).join(", "));

  console.log("\n== Annonstyper ==");
  const itemTypes = await get<Array<{ id: number; description: string }>>("/reference-data/item-types");
  console.log(itemTypes.map((t) => `${t.id}=${t.description}`).join(", "));

  console.log(`\n== Skick-attributet per möbelkategori (mapping.ts antar id ${TRADERA_SKICK_ATTRIBUTE_ID}) ==`);
  const leaves = furniture.filter((c) => c.leaf && /Hem & Hushåll > Möbler/.test(c.path));
  for (const category of leaves) {
    const attributes = await get<Array<{ id: number; name: string; possibleTermValues?: string[] }>>(
      `/categories/${category.id}/attribute-definitions`,
    );
    for (const attribute of attributes) {
      console.log(
        `${category.id}\t${attribute.id}\t${attribute.name}\t${(attribute.possibleTermValues ?? []).join(" | ")}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

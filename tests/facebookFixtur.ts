/**
 * Ett besiktigat, prissatt Loopa-jobb på disk — det Facebook-distributionen bygger annonsen av.
 *
 * Skrivs i LOOPA_JOBS_DIR (som testet måste ha pekat om FÖRE import av jobStore) med två små riktiga
 * bildfiler, så att `adImages` och `jobToProduct` har något att arbeta med. Formen följer
 * ConditionJob så långt projektionen läser den; resten är tomt.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ConditionJob } from "../server/src/types.js";

export interface FixturOptions {
  id?: string;
  title?: string;
  brand?: string | null;
  model?: string | null;
  category?: string;
  price?: number | null;
  grade?: "A" | "B" | "C" | "D" | "E" | "F" | null;
  description?: string;
  estimatedDimensions?: boolean;
  images?: number;
}

export function skrivJobb(jobsDir: string, opts: FixturOptions = {}): ConditionJob {
  const id = opts.id ?? "11111111-2222-4333-8444-555555555555";
  const dir = path.join(jobsDir, id, "originals");
  mkdirSync(dir, { recursive: true });
  const n = opts.images ?? 2;
  const images = Array.from({ length: n }, (_, i) => {
    const name = `img_${i}.jpg`;
    writeFileSync(path.join(dir, name), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]));
    return { id: `img_${i}`, viewLabel: i === 0 ? "Framifrån" : "Sidan", source: "video" as const, width: 1200, height: 900, path: name };
  });
  const brand = opts.brand === undefined ? "Sweef" : opts.brand;
  const model = opts.model === undefined ? "Cloud 3-sits" : opts.model;
  const grade = opts.grade === undefined ? "B" : opts.grade;
  const price = opts.price === undefined ? 6500 : opts.price;
  const title = opts.title ?? "Sweef Cloud 3-sits soffa i grå sammet";
  const job = {
    id,
    createdAt: "2026-09-20T10:00:00.000Z",
    ownerId: "user-1",
    ownerEmail: "saljare@example.com",
    progress: { stage: "done", message: "Klar" },
    error: null,
    productContext: null,
    identity: { brand, model },
    images,
    tradera: { status: "pending", requestId: null, itemId: null, url: null, error: null, startedAt: "2026-09-21T10:00:00.000Z", publishedAt: null, approvedAt: "2026-09-21T11:00:00.000Z", approvedBy: "admin-1" },
    result: {
      jobId: id,
      createdAt: "2026-09-20T10:05:00.000Z",
      identity: { brand, model },
      price:
        price === null
          ? { status: "no_data", low: null, default: null, high: null, currency: "SEK", confidence: null, note: null, matchCount: 0, variant: null, variantMethod: null, damageDeduction: null }
          : { status: "ok", low: price - 500, default: price, high: price + 500, currency: "SEK", confidence: "medium", note: null, matchCount: 12, variant: null, variantMethod: null, damageDeduction: 0.05 },
      reviewPending: false,
      reviewed: true,
      listing: {
        status: "ok",
        unavailableReason: null,
        result: {
          identity: { brand, exactProduct: model, variant: "Grå sammet", category: opts.category ?? "Soffa", confidence: "high", uncertain: false, uncertaintyNote: null },
          attributes: [
            { key: "type", label: "Typ", value: opts.category ?? "Soffa", sourceUrl: null },
            { key: "bredd", label: "Bredd", value: "230 cm", sourceUrl: null, ...(opts.estimatedDimensions ? { estimated: true } : {}) },
            { key: "djup", label: "Djup", value: "98 cm", sourceUrl: null },
            { key: "hojd", label: "Höjd", value: "82 cm", sourceUrl: null },
            { key: "farg", label: "Färg", value: "Grå", sourceUrl: null },
            { key: "material", label: "Material", value: "Sammet", sourceUrl: null },
          ],
          pricing: { retailPriceSek: 14990, suggestedPriceSek: 7000, priceRangeMinSek: 6000, priceRangeMaxSek: 8000, rationale: null },
          listing: {
            title,
            description:
              opts.description ??
              "Rymlig tresitssoffa med djup sits och avtagbar klädsel i grå sammet. Stommen är i massivt trä och sitsen har fjädrande kallskum. Hämtas på Södermalm efter överenskommelse. Skickas ej.",
            conditionText: "Mycket gott skick med lätt bruksslitage.",
          },
          sources: [],
        },
      },
      coverage: "INSPECTED_CLEAR",
      coverageNote: null,
      grade: grade
        ? { grade, canonicalCondition: grade === "A" || grade === "B" ? "Mycket bra skick" : grade === "C" ? "Bra skick" : "Okej skick", label: grade === "B" ? "Mycket gott skick" : "Gott begagnat skick", rationale: "Inga skador utöver normalt slitage.", reasons: [] }
        : null,
      damages: [],
      overallCondition: null,
      images,
      coverImageId: "img_0",
      productImage: null,
    },
  } as unknown as ConditionJob;
  writeFileSync(path.join(jobsDir, id, "job.json"), JSON.stringify(job, null, 2), "utf-8");
  return job;
}

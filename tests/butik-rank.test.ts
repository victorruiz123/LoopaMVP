// ─── butik/rank.ts: rangordningen ───────────────────────────────────────────
//
// Sorteringen är den rad i butiken som justeras oftast, och den som är svårast
// att se att man brutit: ett fel ger inte ett undantag utan en lista i lite fel
// ordning. Testerna nedan låser därför FÖRHÅLLANDEN — vad som ska slå vad — och
// inte exakta tal, så att vikterna går att skruva på utan att testerna faller
// för att de skruvades.

import { test } from "node:test";
import assert from "node:assert/strict";
import { alderspoang, fyndpoang, kvalitetspoang, rankScore, VIKTER } from "../server/src/butik/rank.js";
import type { Product } from "../server/src/butik/types.js";

const NU = new Date("2026-09-06T12:00:00Z");

function vara(over: Partial<Product> = {}): Product {
  return {
    id: "LP-TEST-0001", source: "loopa", title: "Testmöbel", brand: "HAY", model: "Mags",
    categorySlug: "soffor", color: null, material: null,
    dimensions: { widthMm: 2000, depthMm: 900, heightMm: 750, seatHeightMm: null, estimated: false },
    priceSek: 5000, retailPriceSek: 20000, estimatedValueSek: 5000,
    priceHistory: [], priceDroppedAt: null, imageCount: 6, hasMeasurements: true,
    imageUrl: null,
    condition: {
      grade: "good" as Product["condition"] extends null ? never : never, canonical: "good",
      label: "Gott skick", rationale: "", defectCount: 1, inspectedAt: NU.toISOString(), reviewed: true,
    } as unknown as Product["condition"],
    state: "live", listedAt: NU.toISOString(), listedAtKnown: true,
    externalUrl: null, auction: null, region: "Stockholm",
    homeDeliveryAvailable: true, returnsAccepted: true, jobId: "job", identity: null,
    ...over,
  };
}

test("vikterna summerar till ett, så poängen går att läsa som en procent", () => {
  const summa = VIKTER.fynd + VIKTER.kvalitet + VIKTER.engagemang + VIKTER.alder;
  assert.ok(Math.abs(summa - 1) < 1e-9, `vikterna summerar till ${summa}`);
});

test("fyndpoängen mäts mot uppskattat värde, inte mot nypriset", () => {
  // Halva det uppskattade värdet = långt över FULLT_FYND = maxpoäng.
  assert.equal(fyndpoang(vara({ priceSek: 2500, estimatedValueSek: 5000 })), 1);
  // Priset ÄR uppskattningen: inget fynd, oavsett hur högt nypriset står.
  assert.equal(fyndpoang(vara({ priceSek: 5000, estimatedValueSek: 5000, retailPriceSek: 99000 })), 0);
  // Över uppskattningen är inte ett negativt fynd — det är inget fynd.
  assert.equal(fyndpoang(vara({ priceSek: 9000, estimatedValueSek: 5000 })), 0);
});

test("en vara utan uppskattning lånar inte fyndpoäng av de som har en", () => {
  assert.equal(fyndpoang(vara({ estimatedValueSek: null, priceSek: 100 })), 0);
});

test("kvalitetspoängen är bilder, mått och granskat skick i lika delar", () => {
  assert.equal(kvalitetspoang(vara()), 1);
  const utanAllt = vara({ imageCount: 0, hasMeasurements: false, condition: null });
  assert.equal(kvalitetspoang(utanAllt), 0);
  // Bara mått av tre delar.
  const baraMatt = vara({ imageCount: 0, condition: null });
  assert.ok(Math.abs(kvalitetspoang(baraMatt) - 1 / 3) < 1e-9);
});

test("åldern mättas och kan aldrig ensam slå ett fynd", () => {
  const urgammal = vara({ listedAt: "2020-01-01T00:00:00Z", estimatedValueSek: null });
  const fardsk = vara({ listedAt: NU.toISOString(), priceSek: 2500, estimatedValueSek: 5000 });
  assert.equal(alderspoang(urgammal, NU), 1, "taket ska vara nått");
  assert.ok(
    rankScore(fardsk, null, NU) > rankScore(urgammal, null, NU),
    "en gammal annons gick före ett färskt fynd — ålderns vikt är för hög",
  );
});

test("ett gissat listningsdatum ger ingen åldersknuff", () => {
  const gissad = vara({ listedAt: "2020-01-01T00:00:00Z", listedAtKnown: false });
  assert.equal(alderspoang(gissad, NU), 0);
});

test("mellan två lika billiga vinner den mer kompletta annonsen", () => {
  const komplett = vara({ id: "a" });
  const tom = vara({ id: "b", imageCount: 1, hasMeasurements: false });
  assert.ok(rankScore(komplett, null, NU) > rankScore(tom, null, NU));
});

test("engagemang påverkar inget så länge ingen vara har mätning", () => {
  const a = vara({ id: "a" });
  const b = vara({ id: "b" });
  assert.equal(rankScore(a, null, NU), rankScore(b, null, NU));
});
